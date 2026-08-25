import {
  EQUIP_SLOTS,
  Rng,
  SIM_HZ,
  type CraftJobState,
  type InventoryState,
  type ItemStack,
  type PlayerState,
  type RecipeDefId,
  type SkillId,
} from '@survive/protocol';
import { UNLOCK_TAG_PREFIX, type RecipeDef, type RecipeInput } from '@survive/game-data';
import type { CommandRouter, SimContext, System } from '../../core/context';
import { SystemOrder } from '../../core/context';
import {
  addToInventory,
  conditionMultiplier,
  countItem,
  countTag,
  createStack,
  findTool,
  maxStackSize,
  recomputeCarryWeight,
  removeByTag,
  removeFromInventory,
} from '../../core/items';
import { dropStack } from '../../core/loot';
import { bump, markStructureDirty, type Revisioned } from '../../core/queries';
import { grantXp, skillCostMultiplier, skillLevel } from '../../core/skills';
import {
  burnStationFuel,
  handleExtinguish,
  handleIgnite,
  handleRefuel,
  rejectCommand,
  resolveStation,
  spendToolUse,
  stationDropPoint,
  stationOutOfReach,
  withinStationReach,
  type ItemRef,
  type StationRef,
} from './stations';

/**
 * Crafting: hand work, stations, and the fires under them.
 *
 * Three rules shape everything here.
 *
 * 1. **Inputs are reserved at queue time.** A job takes its materials out of the
 *    inventory the moment it is queued, not when it finishes. Otherwise a player
 *    queues ten planks, drops the logs, and collects ten free planks - the classic
 *    duplication bug in every crafting system that validates lazily.
 * 2. **A station job belongs to the station, not the player.** It lives on
 *    `structure.station.jobs` and keeps running while the crafter walks away, which
 *    is the entire reason a furnace is worth building. A hand job lives on
 *    `player.craftQueue` and stops existing if the player does.
 * 3. **One job at a time per queue.** Only the head of each queue advances. A queue
 *    whose every entry ticked down together would not be a queue, and fuel
 *    accounting for a burning station would stop meaning anything.
 *
 * The client's crafting panel greys entries out with {@link canCraft}, which is the
 * same predicate the command handler validates with, so the UI and the server never
 * disagree about what is craftable.
 */

/** Most units one `craft` command may queue. */
export const MAX_CRAFT_COUNT = 99;

/** Most jobs one queue (a player's hands, or one station) may hold. */
export const MAX_QUEUED_JOBS = 8;

/**
 * Ticks of work between `craftProgress` events.
 *
 * One second. Progress is derivable from the replicated job state, so this event is
 * a convenience for effects and audio, not a source of truth - emitting it every tick
 * would be twenty times the traffic for no extra information.
 */
export const CRAFT_PROGRESS_INTERVAL_TICKS = SIM_HZ;

/** Result of a craftability check, phrased for the player. */
export interface CraftCheck {
  ok: boolean;
  reason?: string;
}

const ok: CraftCheck = { ok: true };

function no(reason: string): CraftCheck {
  return { ok: false, reason };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * The skill a recipe practises.
 *
 * Deliberately the skill it grants XP in rather than the one it gates on: forging an
 * iron spear is gated on `melee` (you have to know what a spear is for) but the work
 * itself is crafting, and it is crafting practice that should make it quicker.
 */
export function recipeSkill(recipe: RecipeDef): SkillId {
  return recipe.xp.skill;
}

/** Display name for a recipe input, for rejection messages. */
function inputName(ctx: SimContext, input: RecipeInput): string {
  const def = ctx.data.items.get(input.defId);
  if (def) return def.name;
  return input.tag ?? input.defId;
}

/**
 * Speed multiplier from the tools a recipe demands.
 *
 * The *worst* tool sets the pace: a recipe needing a hammer and a saw goes at the
 * speed of whichever of the two is more decrepit, because that is the one holding the
 * job up. Wear and quality count via {@link conditionMultiplier}, so a nearly-broken
 * saw is slower than a fresh one. Clamped so no tool table entry can make a craft
 * instant or interminable.
 */
export function toolSpeedFactor(ctx: SimContext, player: PlayerState, recipe: RecipeDef): number {
  let factor = Number.POSITIVE_INFINITY;
  for (const kind of recipe.tools) {
    const found = findTool(player, kind, ctx.data);
    // A missing tool is rejected before a job is queued; it must never read as a bonus.
    if (!found) return 1;
    const efficiency = ctx.data.items.get(found.stack.defId)?.tool?.efficiency ?? 1;
    factor = Math.min(factor, efficiency * conditionMultiplier(found.stack, ctx.data));
  }
  if (!Number.isFinite(factor)) return 1;
  return Math.min(3, Math.max(0.5, factor));
}

/**
 * Ticks one unit of a recipe takes for this player, right now.
 *
 * Locked in when the job is queued, alongside the reserved inputs: levelling up
 * mid-job does not retroactively speed up work already paid for, and a tool breaking
 * does not strand a half-finished job at a new duration.
 */
export function craftTicksPerUnit(ctx: SimContext, player: PlayerState, recipe: RecipeDef): number {
  const speed = Math.max(0.05, ctx.config.tuning.craftSpeed);
  const skillFactor = skillCostMultiplier(player, recipeSkill(recipe));
  const toolFactor = toolSpeedFactor(ctx, player, recipe);
  return Math.max(1, Math.round((recipe.craftTicks * skillFactor) / (speed * toolFactor)));
}

/**
 * The random stream for one finished unit of work.
 *
 * Deliberately *not* `ctx.rng.fork(...)`. Forking advances the master generator, so two
 * crafters finishing on the same tick would each shift the other's rolls and the
 * quality of your axe would depend on whether a stranger across the map queued their
 * craft a moment before you did. Seeding from replicated state instead makes a unit's
 * rolls a pure function of who made it, what, where and when: stable under command
 * reordering, unchanged by anything else that drew from the world's randomness that
 * tick, and incapable of perturbing another subsystem's rolls in return.
 *
 * The world seed is in the mix so two worlds do not hand out identical items, and
 * `remaining` distinguishes the units of a multi-unit job even though their completion
 * ticks already differ.
 */
export function craftUnitRng(ctx: SimContext, job: CraftJobState): Rng {
  return new Rng(
    `craft:${ctx.state.seed}:${job.recipeId}:${job.crafterId}:${job.stationId ?? 'hand'}:${ctx.state.tick}:${job.remaining}`,
  );
}

/**
 * Quality of a crafted item, 0..1.
 *
 * A novice's output is shoddy and varies little; a master's is good and varies little
 * either way. The seeded roll is the reason two identical crafts are not identical
 * items. See {@link craftUnitRng} for why that roll does not come from the master
 * stream.
 */
export function craftQuality(rng: Rng, level: number): number {
  const base = 0.3 + level * 0.05;
  const rolled = base + rng.float(-0.1, 0.1);
  // Three decimals: enough spread to matter, small enough not to bloat snapshots.
  return Math.round(Math.min(1, Math.max(0.05, rolled)) * 1000) / 1000;
}

/** Has this player learned the recipe? Schematics are carried, not memorised. */
export function isRecipeUnlocked(ctx: SimContext, player: PlayerState, recipe: RecipeDef): boolean {
  if (recipe.unlockedByDefault) return true;
  const tag = `${UNLOCK_TAG_PREFIX}${recipe.id}`;
  const carries = (stack: ItemStack | null): boolean =>
    stack !== null && (ctx.data.items.get(stack.defId)?.tags.includes(tag) ?? false);
  for (const slot of EQUIP_SLOTS) {
    if (carries(player.equipment[slot])) return true;
  }
  for (const stack of player.inventory.slots) {
    if (carries(stack)) return true;
  }
  return false;
}

/** Find a specific item on a player, hands first. Used for `consumeDurability` inputs. */
function findItemRef(player: PlayerState, defId: string): ItemRef | null {
  for (const slot of EQUIP_SLOTS) {
    const stack = player.equipment[slot];
    if (stack?.defId === defId) return { stack, where: 'equipment', slot };
  }
  for (let index = 0; index < player.inventory.slots.length; index++) {
    const stack = player.inventory.slots[index];
    if (stack?.defId === defId) return { stack, where: 'inventory', index };
  }
  return null;
}

/** Units of an input the player can supply. Tagged inputs count every match. */
function availableInput(ctx: SimContext, player: PlayerState, input: RecipeInput): number {
  if (input.tag) return countTag(player.inventory, input.tag, ctx.data);
  return countItem(player.inventory, input.defId);
}

/**
 * Take an input's materials out of an inventory. Returns how many units were taken.
 *
 * A tagged input spends the recipe's canonical `defId` first and only then reaches for
 * other items carrying the tag, so "any wood" burns the plank the recipe names before
 * it starts eating the logs the player was saving.
 */
function removeInput(
  ctx: SimContext,
  inv: InventoryState,
  input: RecipeInput,
  units: number,
  taken?: ItemStack[],
): number {
  const total = input.count * units;
  if (total <= 0) return 0;
  if (!input.tag) return removeFromInventory(inv, input.defId, total, taken);

  let removed = 0;
  if (input.defId.length > 0 && ctx.data.items.get(input.defId)?.tags.includes(input.tag)) {
    removed += removeFromInventory(inv, input.defId, total, taken);
  }
  if (removed < total) {
    removed += removeByTag(inv, input.tag, total - removed, ctx.data, taken);
  }
  return removed;
}

/**
 * Which item id a refund pays back.
 *
 * A tagged input is refunded as the recipe's canonical item, because {@link
 * CraftJobState} has nowhere to record which of the tag's many matches actually went
 * in. Reservation consumes that same canonical item first, so in practice the refund
 * is exact.
 *
 * The canonical item is only paid back when it would itself have satisfied the input.
 * A recipe naming an item the tag does not cover ("any 2 metal, listed as an iron
 * ingot") could otherwise be cancelled for an ingot the player never put in, turning
 * `cancelCraft` into a transmuter. Where the canonical item does not qualify the
 * refund falls back to the tag's alphabetically first match, which cannot invent
 * something outside the set the recipe already accepts.
 */
function refundDefId(ctx: SimContext, input: RecipeInput): string | null {
  const canonical = input.defId.length > 0 ? ctx.data.items.get(input.defId) : undefined;
  if (canonical && (!input.tag || canonical.tags.includes(input.tag))) return canonical.id;
  if (input.tag) {
    const ids = ctx.data.itemsWithTag(input.tag).map((item) => item.id);
    // Sorted so a refund is not at the mercy of table order.
    ids.sort();
    return ids[0] ?? null;
  }
  return null;
}

function cloneInventory(inv: InventoryState): InventoryState {
  return {
    capacity: inv.capacity,
    slots: inv.slots.map((slot) => (slot ? { ...slot } : null)),
  };
}

// ---------------------------------------------------------------------------
// Reserved weight
// ---------------------------------------------------------------------------

/**
 * Weight of the materials a player's hand queue is holding on to, in kilograms.
 *
 * Reserving inputs at queue time (rule 1) takes them out of the inventory, and
 * `recomputeCarryWeight` only weighs what is *in* the inventory. Left alone, that is a
 * free anti-gravity trick: queue eight jobs, watch forty kilos of logs weigh nothing,
 * jog home unencumbered and cancel for a refund. The materials have not gone anywhere
 * - they are in the same pack, spoken for - so their weight is still the player's to
 * carry.
 *
 * Only hand jobs count. A station job's inputs went into the machine and stay there:
 * the player cannot walk off with them, and the refund is paid out at the station.
 */
export function reservedCraftWeight(ctx: SimContext, player: PlayerState): number {
  let total = 0;
  for (const job of player.craftQueue) {
    const recipe = ctx.data.recipes.get(job.recipeId);
    if (!recipe) continue;
    for (const input of recipe.inputs) {
      if (input.consumeDurability) continue;
      const def = ctx.data.items.get(input.defId);
      if (!def) continue;
      total += def.weight * input.count * job.remaining;
    }
  }
  return total;
}

/**
 * Recompute carry weight *including* whatever the craft queue is holding.
 *
 * Every mutation crafting makes to an inventory goes through here rather than through
 * `recomputeCarryWeight` directly, and {@link settleQueuedWeight} re-applies it once a
 * tick so a plain `recomputeCarryWeight` elsewhere cannot leave the reserve written off.
 */
function settleCarryWeight(ctx: SimContext, player: PlayerState): void {
  recomputeCarryWeight(player, ctx.data);
  player.carryWeight += reservedCraftWeight(ctx, player);
}

/**
 * Re-apply the reserved weight once a tick, for players who have a queue at all.
 *
 * This is the correction the note on {@link reservedCraftWeight} promises.
 * `recomputeCarryWeight` lives in the inventory core and knows nothing about materials
 * a craft queue is holding, so every other system that calls it - a pickup, a slot
 * move, an equip, a drop - silently writes the reserved kilos back out again. Those all
 * run as command handlers at `SystemOrder.Command`, ahead of this system, so re-applying
 * here bounds the error to no ticks at all rather than leaving a player weightless until
 * their next craft happens to land.
 *
 * Bumps only on an actual change: carry weight is replicated, and a revision every tick
 * for every player with something on the go would be pure traffic.
 */
function settleQueuedWeight(ctx: SimContext, player: PlayerState): void {
  // Deliberately *not* skipped when the queue is empty. The tick a queue empties is the
  // one that most needs correcting: the last unit's inputs were still being counted when
  // the weight was last settled, so bailing out here left the phantom kilos written into
  // replicated state permanently - a real 2 kg load reported as 4 kg, for good. The same
  // held for anything that wiped the queue from outside, like going to sleep or dying.
  //
  // Costs one weight recomputation per player per tick, and only bumps when the number
  // actually moved, so an idle player still stays out of the snapshot stream.
  const before = player.carryWeight;
  settleCarryWeight(ctx, player);
  if (player.carryWeight !== before) bump(player);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Everything that has to be true before a craft may be queued, checked for `count`
 * units at once.
 *
 * Order matters only for which reason the player is shown first; the checks are
 * independent. This is the single source of truth for craftability - {@link canCraft}
 * is this function with `count = 1`, which is exactly what a crafting panel needs to
 * grey an entry out.
 */
function checkCraft(
  ctx: SimContext,
  player: PlayerState,
  recipe: RecipeDef,
  count: number,
  stationId?: string,
): CraftCheck {
  if (!player.alive) return no('you are dead');
  if (!Number.isFinite(count) || count < 1 || count > MAX_CRAFT_COUNT) {
    return no(`craft between 1 and ${MAX_CRAFT_COUNT} at a time`);
  }
  if (!isRecipeUnlocked(ctx, player, recipe)) return no('you have not learned that recipe');

  const required = recipe.requiredSkill;
  if (required && skillLevel(player, required.id) < required.level) {
    return no(`needs ${required.id} level ${required.level}`);
  }

  let ref: StationRef | null = null;
  if (recipe.station) {
    if (!stationId) return no(`needs a ${recipe.station}`);
    ref = resolveStation(ctx, stationId);
    if (!ref) return no('that is not a station');
    if (ref.kind !== recipe.station) return no(`needs a ${recipe.station}`);
    if (ref.structure.progress < 1) return no('that station is not finished');
    const blocked = stationOutOfReach(ctx, player, ref);
    if (blocked) return no(blocked);
    if (recipe.requiresHeat && !ref.station.lit) return no('the station is not lit');
  }

  const queue = ref ? ref.station.jobs : player.craftQueue;
  if (queue.length >= MAX_QUEUED_JOBS) return no('that crafting queue is full');

  for (const kind of recipe.tools) {
    if (!findTool(player, kind, ctx.data)) return no(`needs a ${kind}`);
  }

  for (const input of recipe.inputs) {
    if (input.consumeDurability) {
      // A mould or jig: carried rather than eaten, but its durability *is* the input
      // the recipe consumes, so the whole job's worth has to be there before the job
      // is queued - the same rule the consumable inputs get. It is not reserved:
      // unlike a stack of logs, a mould cannot be lifted out of the player's hands
      // and held by the job, so it is spent one unit at a time as the work lands.
      const found = findItemRef(player, input.defId);
      if (!found) return no(`needs a ${inputName(ctx, input)}`);
      const needed = input.consumeDurability * count;
      // An item with no durability has no points to spend, so it cannot serve as this
      // kind of input at all. Treating "no durability" as *infinite* durability, which
      // is the tempting reading, would hand the recipe a mould that never wears out.
      if (found.stack.durability === undefined) {
        return no(`a ${inputName(ctx, input)} cannot be used up that way`);
      }
      if (found.stack.durability < needed) {
        return no(
          count === 1
            ? `the ${inputName(ctx, input)} is worn out`
            : `the ${inputName(ctx, input)} will not last ${count} of those`,
        );
      }
      continue;
    }
    const need = input.count * count;
    if (availableInput(ctx, player, input) < need) {
      return no(`needs ${need} x ${inputName(ctx, input)}`);
    }
  }

  // Room for the result. Only hand crafting is strict about it: a station can fall
  // back on its own container or the floor beside it, and a job that keeps running
  // while its owner is elsewhere must not depend on that owner's spare slots.
  if (!recipe.station) {
    const projected = cloneInventory(player.inventory);
    for (const input of recipe.inputs) {
      if (!input.consumeDurability) removeInput(ctx, projected, input, count);
    }
    for (const output of recipe.outputs) {
      if (!ctx.data.items.has(output.defId)) continue;
      const stack = createStack(ctx.data, output.defId, output.count);
      if (addToInventory(projected, stack, ctx.data) > 0) return no('no room for the result');
    }
  }

  return ok;
}

/**
 * Can this player craft one of this recipe right now?
 *
 * Exported for the client's crafting UI: greying an entry out and rejecting the
 * command it would have sent are the same question, and answering it twice in two
 * places is how the two drift apart.
 */
export function canCraft(
  ctx: SimContext,
  player: PlayerState,
  recipe: RecipeDef,
  stationId?: string,
): CraftCheck {
  return checkCraft(ctx, player, recipe, 1, stationId);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/**
 * Rejection channel for `craft`.
 *
 * `craftFailed` carries the recipe id, so it is what the crafting panel listens to;
 * a generic `commandRejected` is emitted only when the recipe id itself was garbage
 * and there is nothing recipe-shaped to report. One rejection, one event.
 */
function failCraft(
  ctx: SimContext,
  player: PlayerState,
  recipeId: RecipeDefId,
  reason: string,
): void {
  ctx.events.emit({ type: 'craftFailed', playerId: player.id, recipeId, reason });
}

function handleCraft(
  ctx: SimContext,
  player: PlayerState,
  command: { recipeId: RecipeDefId; count: number; stationId?: string },
): void {
  const recipe = ctx.data.recipes.get(command.recipeId);
  if (!recipe) {
    rejectCommand(ctx, player, 'craft', 'no such recipe');
    return;
  }

  const count = Math.floor(command.count);
  const check = checkCraft(ctx, player, recipe, count, command.stationId);
  if (!check.ok) {
    failCraft(ctx, player, recipe.id, check.reason ?? 'you cannot craft that');
    return;
  }

  // A hand recipe is crafted by hand even if the client passed a station along: the
  // recipe decides where the work happens, never the caller.
  const ref = recipe.station && command.stationId ? resolveStation(ctx, command.stationId) : null;

  // Kept, not counted. A cancellation has to give back these very stacks - with the wear
  // and the freshness they had - and `removeInput` consumes the worst ones first, so
  // `reserved` comes out worst-first and a partial refund can hand back the tail.
  const reserved: ItemStack[] = [];
  for (const input of recipe.inputs) {
    if (input.consumeDurability) continue;
    removeInput(ctx, player.inventory, input, count, reserved);
  }

  const job: CraftJobState = {
    jobId: ctx.ids.craftJob(),
    recipeId: recipe.id,
    remaining: count,
    ticksPerUnit: craftTicksPerUnit(ctx, player, recipe),
    ticksLeft: 0,
    crafterId: player.id,
    reserved,
  };
  job.ticksLeft = job.ticksPerUnit;
  if (ref) job.stationId = ref.structure.id;

  if (ref) {
    ref.station.jobs.push(job);
    bump(ref.structure);
    markStructureDirty(ctx.state, ref.structure);
  } else {
    player.craftQueue.push(job);
  }
  // After the job is on the queue, so a hand job's reserved materials are weighed.
  settleCarryWeight(ctx, player);
  bump(player);

  ctx.events.emit({ type: 'craftQueued', playerId: player.id, recipeId: recipe.id, count });
}

/**
 * `cancelCraft`: abandon a job and hand back what has not been started.
 *
 * The unit currently under the hammer is forfeit - it has already been half made -
 * and every untouched unit behind it is refunded in full. Refunds go to whoever
 * cancelled, since they are the one standing there.
 */
function handleCancelCraft(
  ctx: SimContext,
  player: PlayerState,
  command: { jobId: string; stationId?: string },
): void {
  const fail = (reason: string) => rejectCommand(ctx, player, 'cancelCraft', reason);
  if (!player.alive) return fail('you are dead');

  let queue: CraftJobState[];
  let owner: Revisioned = player;
  let ref: StationRef | null = null;
  if (command.stationId) {
    ref = resolveStation(ctx, command.stationId);
    if (!ref) return fail('that is not a station');
    const blocked = stationOutOfReach(ctx, player, ref);
    if (blocked) return fail(blocked);
    queue = ref.station.jobs;
    owner = ref.structure;
  } else {
    queue = player.craftQueue;
  }

  const index = queue.findIndex((entry) => entry.jobId === command.jobId);
  if (index < 0) return fail('no such craft job');
  const job = queue[index];
  if (!job) return fail('no such craft job');
  // The crafter owns their job; the station's owner may also clear their own machine.
  if (job.crafterId !== player.id && ref?.structure.ownerId !== player.id) {
    return fail('that is not your craft job');
  }

  queue.splice(index, 1);
  bump(owner);
  if (ref) markStructureDirty(ctx.state, ref.structure);
  if (owner !== player) bump(player);

  const recipe = ctx.data.recipes.get(job.recipeId);
  if (recipe) {
    const untouched = job.ticksLeft >= job.ticksPerUnit ? job.remaining : job.remaining - 1;
    refundInputs(ctx, player, recipe, job, untouched);
  }
  ctx.events.emit({ type: 'craftCancelled', playerId: player.id, recipeId: job.recipeId });
}

/**
 * Drop the materials a set of jobs was holding onto the ground.
 *
 * A job's inputs leave the pack when it is queued, so anything that destroys the job
 * without cancelling it destroys the materials too. That happened three ways: demolishing
 * a station, a station being destroyed, and going to sleep (which cleared the hand queue
 * outright). None of them refunded, and the loss was silent - a workbench with eight
 * queued jobs was several stacks of materials that simply stopped existing when someone
 * knocked it down.
 *
 * Spilled rather than paid into an inventory: the owner may be elsewhere, dead, or asleep,
 * and the ground beside the station is where the rest of its contents go anyway.
 */
export function spillReservedMaterials(
  ctx: SimContext,
  jobs: readonly CraftJobState[],
  x: number,
  y: number,
): void {
  for (const job of jobs) {
    if (!job.reserved) continue;
    for (const stack of job.reserved) {
      if (stack.count > 0) dropStack(ctx, x, y, { ...stack }, job.crafterId, 20);
    }
    job.reserved = [];
  }
}

/**
 * Pay `units` worth of a job's inputs back to a player, spilling on the floor.
 *
 * Pays back the stacks the job actually took, so a cancelled job returns the same worn
 * tool and the same half-rotten meat that went in. Minting them from their definitions
 * instead made `cancelCraft` a repair bench and a spoilage cure, and because reservation
 * takes the *worst* units the player holds, it was worth doing deliberately.
 *
 * On a partial cancel the units already worked on kept the worst stacks - reservation
 * order - so the refund hands back the tail of `reserved`, which is the better end.
 *
 * `reserved` is absent on jobs restored from a save written before it was recorded. Those
 * fall back to minting: a one-time cosmetic gain on an in-flight job beats refusing to
 * refund a save that predates the field.
 */
function refundInputs(
  ctx: SimContext,
  player: PlayerState,
  recipe: RecipeDef,
  job: CraftJobState,
  units: number,
): void {
  if (units <= 0) return;

  const give = (stack: ItemStack): void => {
    if (addToInventory(player.inventory, stack, ctx.data) > 0) {
      dropStack(ctx, player.x, player.y, stack, player.id);
    }
  };

  if (job.reserved && job.reserved.length > 0) {
    const total = Math.max(1, job.remaining);
    if (units >= total) {
      for (const stack of job.reserved) give({ ...stack });
    } else {
      // Refund the better tail, unit for unit, per definition: the consumed units took
      // the front of the list because that is the order reservation removes in.
      const perDef = new Map<string, ItemStack[]>();
      for (const stack of job.reserved) {
        const bucket = perDef.get(stack.defId) ?? [];
        bucket.push(stack);
        perDef.set(stack.defId, bucket);
      }
      for (const [, stacks] of perDef) {
        const held = stacks.reduce((sum, stack) => sum + stack.count, 0);
        // What this definition owes back, scaled by the units being cancelled.
        let owed = Math.round((held * units) / total);
        for (let i = stacks.length - 1; i >= 0 && owed > 0; i--) {
          const stack = stacks[i]!;
          const take = Math.min(stack.count, owed);
          give({ ...stack, count: take });
          owed -= take;
        }
      }
    }
    job.reserved = [];
    settleCarryWeight(ctx, player);
    bump(player);
    return;
  }

  for (const input of recipe.inputs) {
    if (input.consumeDurability) continue;
    const defId = refundDefId(ctx, input);
    if (!defId) continue;
    const stack = createStack(ctx.data, defId, input.count * units);
    give(stack);
  }
  settleCarryWeight(ctx, player);
  bump(player);
}

// ---------------------------------------------------------------------------
// Per-tick job advance
// ---------------------------------------------------------------------------

/** One job plus everything needed to run it for a tick. */
interface JobRunner {
  job: CraftJobState;
  queue: CraftJobState[];
  recipe: RecipeDef;
  /** Entity whose `rev` carries the job to clients. */
  owner: Revisioned;
  station: StationRef | null;
  /** The crafter, when they are still in the world and alive. */
  crafter: PlayerState | null;
  /**
   * Whether the crafter is close enough to take the work out with their hands.
   *
   * Always true for a hand job - it is happening in their hands. For a station job it
   * is re-tested every time a unit lands, because the whole point of a station is that
   * it carries on without you, and what carries on is the *work*, not the delivery.
   */
  atHand: boolean;
}

/** Stall a job with a reason, without spamming a revision bump every tick. */
function blockJob(job: CraftJobState, owner: Revisioned, reason: string): void {
  if (job.blockedReason === reason) return;
  job.blockedReason = reason;
  bump(owner);
}

function advanceJob(ctx: SimContext, runner: JobRunner): void {
  const { job, owner, station } = runner;
  if (job.blockedReason !== undefined) delete job.blockedReason;

  job.ticksLeft -= 1;
  bump(owner);
  if (station) markStructureDirty(ctx.state, station.structure);

  if (job.ticksLeft > 0) {
    const elapsed = job.ticksPerUnit - job.ticksLeft;
    if (elapsed % CRAFT_PROGRESS_INTERVAL_TICKS === 0) {
      ctx.events.emit({
        type: 'craftProgress',
        playerId: job.crafterId,
        recipeId: job.recipeId,
        progress: elapsed / job.ticksPerUnit,
      });
    }
    return;
  }

  completeUnit(ctx, runner);
}

/** Finish one unit: roll the outputs, wear the tools, pay the XP, requeue or retire. */
function completeUnit(ctx: SimContext, runner: JobRunner): void {
  const { job, queue, recipe, owner, station, crafter } = runner;
  const rng = craftUnitRng(ctx, job);
  const level = crafter ? skillLevel(crafter, recipeSkill(recipe)) : 0;

  for (const output of recipe.outputs) {
    if (output.chance !== undefined && !rng.chance(output.chance)) continue;
    const def = ctx.data.items.get(output.defId);
    if (!def) {
      ctx.log.warn('recipe output references unknown item', {
        recipeId: recipe.id,
        defId: output.defId,
      });
      continue;
    }
    const stack = createStack(ctx.data, output.defId, output.count);
    // Quality only goes on items that already carry per-item state. Stamping it on a
    // stackable would split every ingot into its own slot, since `canMerge` has no
    // way to average two qualities.
    if (maxStackSize(def) === 1) stack.quality = craftQuality(rng, level);
    const produced: ItemStack = { ...stack };
    deliverStack(ctx, stack, runner.atHand ? crafter : null, station);
    ctx.events.emit({
      type: 'craftCompleted',
      playerId: job.crafterId,
      recipeId: recipe.id,
      output: produced,
    });
  }

  if (crafter) {
    // Tools are required, not consumed - they just wear. Checked when the job was
    // queued, so a tool that has since been dropped simply escapes the wear.
    for (const kind of recipe.tools) {
      const found = findTool(crafter, kind, ctx.data);
      if (!found) continue;
      const perUse = ctx.data.items.get(found.stack.defId)?.tool?.durabilityPerUse ?? 1;
      spendToolUse(ctx, crafter, found, perUse);
    }
    for (const input of recipe.inputs) {
      if (!input.consumeDurability) continue;
      const found = findItemRef(crafter, input.defId);
      if (found) spendToolUse(ctx, crafter, found, input.consumeDurability);
    }
    crafter.stats.itemsCrafted += 1;
    grantXp(ctx, crafter, recipe.xp.skill, recipe.xp.amount);
    bump(crafter);
  }

  job.remaining -= 1;
  if (job.remaining > 0) {
    job.ticksLeft = job.ticksPerUnit;
  } else {
    const index = queue.indexOf(job);
    if (index >= 0) queue.splice(index, 1);
  }
  bump(owner);
}

/**
 * Put a finished stack somewhere real.
 *
 * Crafter's inventory, then the station's own container, then the ground at whichever
 * of the two is present. The output is never destroyed: a full pack costs the player
 * a walk back to a dropped pile, not the smelt.
 *
 * `crafter` is passed as null when the player is not standing at the station any more.
 * A furnace keeps working while its owner is away - that is the point of building one -
 * but the ingots come out of the furnace, not out of thin air into a pack two
 * kilometres downwind, which would make every station a courier.
 */
function deliverStack(
  ctx: SimContext,
  stack: ItemStack,
  crafter: PlayerState | null,
  station: StationRef | null,
): void {
  let left = stack.count;
  if (crafter) {
    left = addToInventory(crafter.inventory, stack, ctx.data);
    settleCarryWeight(ctx, crafter);
    bump(crafter);
  }
  if (left > 0 && station?.structure.container) {
    left = addToInventory(station.structure.container, stack, ctx.data);
    bump(station.structure);
    markStructureDirty(ctx.state, station.structure);
  }
  if (left <= 0) return;

  const at = crafter ? { x: crafter.x, y: crafter.y } : station ? stationDropPoint(station) : null;
  if (!at) {
    ctx.log.warn('craft output had nowhere to go', { defId: stack.defId });
    return;
  }
  dropStack(ctx, at.x, at.y, stack, crafter?.id);
}

/** Drop a job whose recipe no longer exists, e.g. after a content update. */
function discardJob(
  ctx: SimContext,
  job: CraftJobState,
  queue: CraftJobState[],
  owner: Revisioned,
): void {
  ctx.log.warn('discarding craft job with unknown recipe', { recipeId: job.recipeId });
  const index = queue.indexOf(job);
  if (index >= 0) queue.splice(index, 1);
  bump(owner);
}

/** Advance the job in a player's hands, if any. */
function stepHandQueue(ctx: SimContext, player: PlayerState): void {
  const job = player.craftQueue[0];
  if (!job) return;
  const recipe = ctx.data.recipes.get(job.recipeId);
  if (!recipe) {
    discardJob(ctx, job, player.craftQueue, player);
    return;
  }
  advanceJob(ctx, {
    job,
    queue: player.craftQueue,
    recipe,
    owner: player,
    station: null,
    crafter: player,
    atHand: true,
  });
}

/**
 * Burn a station's fuel and advance its head job.
 *
 * Fuel burns whenever the station is lit, job or no job, which is what makes leaving a
 * campfire alight overnight cost something. A running job raises the burn rate to
 * `fuelCost / ticksPerUnit` so that one unit of work costs exactly the `fuelCost` the
 * recipe table advertises, no matter how fast the crafter is at it.
 */
function stepStation(ctx: SimContext, structureId: string): void {
  const ref = resolveStation(ctx, structureId);
  if (!ref) return;

  const job = ref.station.jobs[0];
  const recipe = job ? ctx.data.recipes.get(job.recipeId) : undefined;
  const fuelCost = recipe?.fuelCost ?? 0;
  const jobRate =
    job && ref.burnsFuel && fuelCost > 0 ? fuelCost / Math.max(1, job.ticksPerUnit) : 0;

  const fuelPaid = burnStationFuel(ctx, ref, jobRate);
  if (!job) return;
  if (!recipe) {
    discardJob(ctx, job, ref.station.jobs, ref.structure);
    return;
  }

  // A stalled fire is one situation but two different instructions to the player, so
  // the reason is picked from the actual cause rather than from whichever check runs
  // first. An empty hopper means fetch fuel; a full but cold one means strike a light.
  // Note that running out *douses* the station in `burnStationFuel` above, so the
  // fuel level - not `lit` - is what distinguishes the two by the time we get here.
  if (jobRate > 0 && !fuelPaid) {
    blockJob(
      job,
      ref.structure,
      ref.station.fuel <= 0 ? 'the station is out of fuel' : 'the station is not lit',
    );
    return;
  }
  if (recipe.requiresHeat && !ref.station.lit) {
    blockJob(job, ref.structure, 'the station is not lit');
    return;
  }

  const found = ctx.state.players[job.crafterId];
  const crafter = found?.alive ? found : null;
  advanceJob(ctx, {
    job,
    queue: ref.station.jobs,
    recipe,
    owner: ref.structure,
    station: ref,
    crafter,
    atHand: crafter !== null && withinStationReach(ctx, crafter, ref.structure),
  });
}

// ---------------------------------------------------------------------------
// System
// ---------------------------------------------------------------------------

export function createCraftingSystem(): System {
  return {
    id: 'crafting',
    order: SystemOrder.Crafting,

    init(_ctx: SimContext, router: CommandRouter) {
      router.on('craft', handleCraft);
      router.on('cancelCraft', handleCancelCraft);
      router.on('refuel', handleRefuel);
      router.on('ignite', handleIgnite);
      router.on('extinguish', handleExtinguish);
    },

    update(ctx: SimContext) {
      // Sorted iteration: two players finishing a craft on the same tick must not
      // draw their quality rolls in whatever order the record happens to enumerate.
      for (const id of Object.keys(ctx.state.players).sort()) {
        const player = ctx.state.players[id];
        if (!player?.alive) continue;
        stepHandQueue(ctx, player);
        // After the job advanced: a unit that just landed has already been weighed by
        // `deliverStack`, and this catches whatever else moved the pack this tick.
        settleQueuedWeight(ctx, player);
      }
      for (const id of Object.keys(ctx.state.structures).sort()) {
        if (!ctx.state.structures[id]?.station) continue;
        stepStation(ctx, id);
      }
    },
  };
}
