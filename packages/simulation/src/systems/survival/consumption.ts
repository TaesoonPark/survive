import {
  BODY_PART_IDS,
  BODY_PART_LABELS,
  clamp,
  type BodyPartId,
  type BodyPartState,
  type CommandOf,
  type ContainerRef,
  type ItemStack,
  type PlayerState,
  type StatusEffectId,
} from '@survive/protocol';
import type { EffectGrant, ItemDef, MedicalKind, MedicalProps } from '@survive/game-data';
import type { SimContext } from '../../core/context';
import { syncHealthFromBody } from '../../core/damage';
import { addEffect } from '../../core/effects';
import { conditionMultiplier, recomputeCarryWeight, spendDurability } from '../../core/items';
import { bump } from '../../core/queries';
import { grantXp, skillLevel } from '../../core/skills';
import { notify, reject } from './attrition';
import {
  DIRTY_BANDAGE_CLEANLINESS,
  DIRTY_BANDAGE_INFECT_CHANCE,
  DIRTY_BANDAGE_SEED,
  DISINFECT_PROTECTION_TICKS,
  FUMBLE_MAX_CHANCE,
  FUMBLE_PAIN,
  FUMBLE_PER_MISSING_LEVEL,
  HYDRATED_THIRST,
  HYDRATED_TICKS,
  SICKNESS_TICKS,
  SPOILED_FRESHNESS,
  SPOILED_SICKNESS_BONUS,
  TREAT_XP,
  TREAT_XP_PER_SKILL,
  WELL_FED_HUNGER,
  WELL_FED_TICKS,
} from './tuning';

/**
 * Eating, drinking and first aid.
 *
 * The generic `useItem` routing belongs to the inventory system, which owns slot
 * validation and every non-consumable use; it calls {@link consumeItem} when the
 * item turns out to be food, drink or medicine. The `treat` command - "put *this*
 * bandage on *that* arm" - is handled here, because deciding what a bandage does to
 * a wound is a survival rule, not an inventory one.
 *
 * Both entry points take the stack by reference and an optional {@link ConsumeSlot}
 * so they can do their own bookkeeping: decrement the count, wear the durability of
 * a suture kit, empty the slot when it runs out. A caller that would rather manage
 * the stack itself simply omits the slot.
 */

/** Where the consumed stack lives, so a spent item can be cleared from it. */
export interface ConsumeSlot {
  ref: ContainerRef;
  /** Slot index for inventory and structure-container refs; ignored otherwise. */
  index: number;
}

export interface ConsumeResult {
  ok: boolean;
  /** Machine-readable refusal, forwarded to the client as a `commandRejected`. */
  reason?: string;
  /** Units removed from the stack. 0 when only a vessel's `fill` was drawn down. */
  consumed: number;
  /**
   * Ticks the player is busy for. Already written to `useReadyTick` here; reported so
   * a caller that owns the slot (the inventory system's `useItem`) can apply the same
   * cooldown without having to know which of food, drink and medicine it landed on.
   */
  busyTicks: number;
  /**
   * The treatment happened but went wrong. Still `ok`: the item is spent and the
   * cooldown applies, so this is an outcome, not a refusal. The `treated` event
   * carries `success: false`.
   */
  botched?: boolean;
}

const REFUSED = (reason: string): ConsumeResult => ({
  ok: false,
  reason,
  consumed: 0,
  busyTicks: 0,
});

const accepted = (consumed: number, busyTicks: number, botched = false): ConsumeResult =>
  botched ? { ok: true, consumed, busyTicks, botched: true } : { ok: true, consumed, busyTicks };

// ---------------------------------------------------------------------------
// Slot bookkeeping
// ---------------------------------------------------------------------------

/** Empty the slot a spent stack came out of. */
function clearSlot(ctx: SimContext, player: PlayerState, slot: ConsumeSlot | undefined): void {
  if (!slot) return;
  switch (slot.ref.kind) {
    case 'inventory':
      if (slot.index >= 0 && slot.index < player.inventory.slots.length) {
        player.inventory.slots[slot.index] = null;
      }
      break;
    case 'equipment':
      player.equipment[slot.ref.slot] = null;
      break;
    case 'structure': {
      const container = ctx.state.structures[slot.ref.structureId]?.container;
      if (container && slot.index >= 0 && slot.index < container.slots.length) {
        container.slots[slot.index] = null;
      }
      break;
    }
    default:
      break;
  }
}

/**
 * Use one unit of a consumable. Returns the units removed from the stack.
 *
 * Items with durability (a suture kit, a first aid box) are *worn* rather than
 * eaten, and only vanish when they break; everything else loses a unit from the
 * stack. Either way the slot is emptied once nothing is left.
 */
function spendConsumable(
  ctx: SimContext,
  player: PlayerState,
  stack: ItemStack,
  def: ItemDef,
  slot: ConsumeSlot | undefined,
): number {
  if (def.maxDurability !== undefined && stack.durability !== undefined) {
    // A kit with uses left is worn, not spent: the stack keeps its single unit.
    if (!spendDurability(stack, 1)) {
      recomputeCarryWeight(player, ctx.data);
      return 0;
    }
    stack.count = 0;
  } else {
    stack.count -= 1;
  }
  if (stack.count <= 0) clearSlot(ctx, player, slot);
  recomputeCarryWeight(player, ctx.data);
  return 1;
}

/**
 * Resolve the stack a command referred to, for the refs a player can consume from.
 *
 * Only the player's own inventory and equipment: a ground pile, a backpack pocket or a
 * remote container is resolved by the inventory system, which owns reach and open-view
 * validation for those, and which then calls {@link consumeItem} with the slot it found.
 */
export function resolveConsumable(
  player: PlayerState,
  ref: ContainerRef,
  index: number,
): { stack: ItemStack; slot: ConsumeSlot } | null {
  switch (ref.kind) {
    case 'inventory': {
      if (!Number.isInteger(index) || index < 0 || index >= player.inventory.slots.length) {
        return null;
      }
      const stack = player.inventory.slots[index];
      return stack ? { stack, slot: { ref, index } } : null;
    }
    case 'equipment': {
      const stack = player.equipment[ref.slot];
      return stack ? { stack, slot: { ref, index: 0 } } : null;
    }
    default:
      // Ground piles, backpack pockets and remote containers go through the
      // inventory system first; medicine is applied out of hand or off the belt.
      return null;
  }
}

// ---------------------------------------------------------------------------
// Shared body maths
// ---------------------------------------------------------------------------

/** The part in the worst shape, or undefined when the player is unhurt. */
function mostDamagedPart(player: PlayerState): BodyPartId | undefined {
  let worst: BodyPartId | undefined;
  let worstFraction = 1;
  for (const id of BODY_PART_IDS) {
    const part = player.body.parts[id];
    const fraction = part.maxHealth > 0 ? part.health / part.maxHealth : 1;
    if (fraction < worstFraction) {
      worstFraction = fraction;
      worst = id;
    }
  }
  return worst;
}

/** Put `amount` of health into whichever part needs it most. */
function healWorstPart(player: PlayerState, amount: number): void {
  if (amount <= 0) return;
  const id = mostDamagedPart(player);
  if (!id) return;
  const part = player.body.parts[id];
  part.health = Math.min(part.maxHealth, part.health + amount);
  syncHealthFromBody(player);
}

/** Reduce infection everywhere, as a systemic drug does. */
function cureInfectionSystemically(ctx: SimContext, player: PlayerState, amount: number): void {
  if (amount <= 0) return;
  for (const id of BODY_PART_IDS) {
    const part = player.body.parts[id];
    if (part.infection <= 0) continue;
    part.infection = Math.max(0, part.infection - amount);
    if (part.infection <= 0) part.bitten = false;
    ctx.events.emit({
      type: 'infectionChanged',
      entityId: player.id,
      bodyPart: id,
      value: part.infection,
    });
  }
}

/** Take the edge off every part at once. */
function relievePainSystemically(player: PlayerState, amount: number): void {
  if (amount <= 0) return;
  for (const id of BODY_PART_IDS) {
    const part = player.body.parts[id];
    part.pain = Math.max(0, part.pain - amount);
  }
}

/**
 * Apply the status effects a content definition attaches to a consumable.
 *
 * One RNG fork per call, rolled in table order, so adding an effect to one item
 * never shifts the rolls of another.
 */
function applyEffectGrants(
  ctx: SimContext,
  player: PlayerState,
  grants: readonly EffectGrant[] | undefined,
  label: string,
): void {
  if (!grants || grants.length === 0) return;
  const rng = ctx.rng.fork(`survival:grant:${label}:${player.id}:${ctx.state.tick}`);
  for (const grant of grants) {
    if (grant.chance !== undefined && !rng.chance(grant.chance)) continue;
    addEffect(ctx, player, grant.id, grant.durationTicks, grant.magnitude);
  }
}

/** Roll for illness from a questionable meal or a bad bottle of water. */
function rollSickness(
  ctx: SimContext,
  player: PlayerState,
  chance: number,
  effect: StatusEffectId,
  label: string,
  message: string,
): void {
  if (chance <= 0) return;
  const rng = ctx.rng.fork(`survival:sickness:${label}:${player.id}:${ctx.state.tick}`);
  if (!rng.chance(chance)) return;
  addEffect(ctx, player, effect, SICKNESS_TICKS, 1);
  notify(ctx, player, 'warn', message);
}

// ---------------------------------------------------------------------------
// Eating and drinking
// ---------------------------------------------------------------------------

function eat(
  ctx: SimContext,
  player: PlayerState,
  stack: ItemStack,
  def: ItemDef,
  slot: ConsumeSlot | undefined,
): ConsumeResult {
  const food = def.food;
  if (!food) return REFUSED('not food');

  // Spoiled food still feeds you, badly, and is far more likely to make you ill.
  const freshness = stack.freshness ?? 1;
  const potency = clamp(0.35 + freshness * 0.65, 0.35, 1);
  const nutrition = food.nutrition * potency;

  player.hunger = clamp(player.hunger - nutrition, 0, 100);
  player.thirst = clamp(player.thirst - food.hydration * potency, 0, 100);
  if (food.stamina > 0) {
    player.stamina = Math.min(player.maxStamina, player.stamina + food.stamina);
  }
  healWorstPart(player, food.health);

  const sickness = clamp(
    food.sicknessChance + (freshness < SPOILED_FRESHNESS ? SPOILED_SICKNESS_BONUS : 0),
    0,
    1,
  );
  rollSickness(ctx, player, sickness, 'food_poisoning', `food:${def.id}`, 'notify.foodPoisoning');

  applyEffectGrants(ctx, player, food.effects, `food:${def.id}`);
  if (player.hunger <= WELL_FED_HUNGER) {
    addEffect(ctx, player, 'well_fed', WELL_FED_TICKS, 0.25);
  }

  player.useReadyTick = ctx.state.tick + Math.max(1, food.eatTicks);
  ctx.events.emit({
    type: 'ateFood',
    playerId: player.id,
    itemDefId: def.id,
    nutrition,
  });
  const consumed = spendConsumable(ctx, player, stack, def, slot);
  bump(player);
  return accepted(consumed, food.eatTicks);
}

function swallow(
  ctx: SimContext,
  player: PlayerState,
  contentDef: ItemDef,
  drinkDef: NonNullable<ItemDef['drink']>,
): void {
  player.thirst = clamp(player.thirst - drinkDef.hydration, 0, 100);
  player.hunger = clamp(player.hunger - drinkDef.nutrition, 0, 100);
  rollSickness(
    ctx,
    player,
    drinkDef.sicknessChance,
    'poisoned',
    `drink:${contentDef.id}`,
    'The water was bad. You feel it already.',
  );
  applyEffectGrants(ctx, player, drinkDef.effects, `drink:${contentDef.id}`);
  if (player.thirst <= HYDRATED_THIRST) {
    addEffect(ctx, player, 'hydrated', HYDRATED_TICKS, 0.25);
  }
  player.useReadyTick = ctx.state.tick + Math.max(1, drinkDef.drinkTicks);
  ctx.events.emit({
    type: 'drank',
    playerId: player.id,
    itemDefId: contentDef.id,
    hydration: drinkDef.hydration,
  });
}

/**
 * Drink from a vessel: a bottle or canteen holding several units.
 *
 * The vessel is never consumed; one unit of `fill` is, and what the player actually
 * drinks is the *contents* definition, so the same bottle can hold clean or dirty
 * water and the sickness roll follows the water rather than the bottle.
 */
function drinkFromVessel(
  ctx: SimContext,
  player: PlayerState,
  stack: ItemStack,
  def: ItemDef,
): ConsumeResult {
  const liquid = def.liquid;
  if (!liquid) return REFUSED('not a vessel');
  const fill = stack.fill ?? 0;
  if (fill <= 0) return REFUSED('empty');
  const contentId = stack.contentDefId ?? liquid.contentDefId;
  const contentDef = contentId ? ctx.data.items.get(contentId) : undefined;
  const drinkDef = contentDef?.drink;
  if (!contentDef || !drinkDef) return REFUSED('nothing drinkable in it');

  swallow(ctx, player, contentDef, drinkDef);
  stack.fill = Math.max(0, fill - 1);
  if (stack.fill <= 0 && !liquid.contentDefId) delete stack.contentDefId;
  bump(player);
  // The vessel survives; only its contents were spent.
  return accepted(0, drinkDef.drinkTicks);
}

function drink(
  ctx: SimContext,
  player: PlayerState,
  stack: ItemStack,
  def: ItemDef,
  slot: ConsumeSlot | undefined,
): ConsumeResult {
  const drinkDef = def.drink;
  if (!drinkDef) return REFUSED('not a drink');
  swallow(ctx, player, def, drinkDef);
  const consumed = spendConsumable(ctx, player, stack, def, slot);
  bump(player);
  return accepted(consumed, drinkDef.drinkTicks);
}

// ---------------------------------------------------------------------------
// Medicine
// ---------------------------------------------------------------------------

/** Whether this item would actually do anything to this part. */
function treatmentApplies(part: BodyPartState, med: MedicalProps): boolean {
  const wounded = part.health < part.maxHealth || part.bleeding > 0;
  switch (med.kind) {
    case 'splint':
      return part.fractured && !part.splinted;
    case 'suture':
      return part.bleeding > 0 || wounded;
    case 'disinfect':
      return part.infection > 0 || part.bitten || wounded;
    case 'bandage':
      if (part.bleeding > 0 || part.infection > 0) return true;
      if (!wounded) return false;
      // Re-dressing is only worth an item if the new dressing is cleaner.
      return !part.bandaged || part.bandageQuality < med.cleanliness;
    default:
      return true;
  }
}

/**
 * Which part a medical item should go on when the player did not say.
 *
 * Used by `useItem` (the player clicked a bandage, not a bandage *and* a limb) so
 * the obvious thing happens: the splint finds the break, the bandage finds the
 * worst bleed, the antiseptic finds the infection.
 */
export function bestTreatmentTarget(
  player: PlayerState,
  kind: MedicalKind,
): BodyPartId | undefined {
  let best: BodyPartId | undefined;
  let bestScore = 0;
  for (const id of BODY_PART_IDS) {
    const part = player.body.parts[id];
    let score = 0;
    switch (kind) {
      case 'splint':
        score = part.fractured && !part.splinted ? 1 : 0;
        break;
      case 'suture':
        score = part.bleeding * 10 + (part.maxHealth - part.health);
        break;
      case 'disinfect':
        score = part.infection * 10 + (part.bitten ? 5 : 0);
        break;
      default:
        score = part.bleeding * 10 + part.infection * 2 + (part.maxHealth - part.health);
        break;
    }
    if (score > bestScore) {
      bestScore = score;
      best = id;
    }
  }
  return best;
}

/**
 * Apply one medical item to one body part.
 *
 * The interesting rules all live here:
 *
 * - a **bandage** slows a bleed by its `bleedStop` and records its `cleanliness`,
 *   which is what the infection step later reads. A dirty rag on an open wound
 *   rolls to seed an infection on the spot: it stops the blood and starts something
 *   worse, which is exactly the trade the content table describes.
 * - a **suture** closes the wound outright - bleeding to zero, `stitched` set.
 * - a **splint** does not mend the break, it makes mending *possible*: the healing
 *   step refuses to knit an unsplinted fracture.
 * - a **disinfect** buys the wound a window of protection in `disinfectedTicks`.
 *
 * Below the item's nominal `skillLevel` the treatment can be botched, which costs
 * the item and adds pain. That is the reason to level medicine before trying to
 * stitch yourself up in the field.
 */
export function treatBodyPart(
  ctx: SimContext,
  player: PlayerState,
  stack: ItemStack,
  bodyPart: BodyPartId,
  slot?: ConsumeSlot,
): ConsumeResult {
  if (!player.alive) return REFUSED('dead');
  if (ctx.state.tick < player.useReadyTick) return REFUSED('still busy');
  if (ctx.state.tick < player.actionLockedUntilTick) return REFUSED('cannot act');
  const def = ctx.data.items.get(stack.defId);
  const med = def?.medical;
  if (!def || !med) return REFUSED('not a medical item');
  if (!BODY_PART_IDS.includes(bodyPart)) return REFUSED('unknown body part');

  // Pills and injections are systemic; a body part is meaningless for them.
  if (med.kind === 'pill' || med.kind === 'injection') {
    return medicate(ctx, player, stack, def, med, slot);
  }

  const part = player.body.parts[bodyPart];
  if (!treatmentApplies(part, med)) return REFUSED('nothing to treat there');

  player.useReadyTick = ctx.state.tick + Math.max(1, med.useTicks);
  const rng = ctx.rng.fork(`survival:treat:${player.id}:${ctx.state.tick}:${bodyPart}`);
  const shortfall = Math.max(0, med.skillLevel - skillLevel(player, 'medicine'));
  const fumbleChance = Math.min(FUMBLE_MAX_CHANCE, shortfall * FUMBLE_PER_MISSING_LEVEL);

  if (fumbleChance > 0 && rng.chance(fumbleChance)) {
    part.pain = Math.min(100, part.pain + FUMBLE_PAIN);
    const wasted = spendConsumable(ctx, player, stack, def, slot);
    bump(player);
    ctx.events.emit({
      type: 'treated',
      entityId: player.id,
      bodyPart,
      itemDefId: def.id,
      success: false,
    });
    notify(ctx, player, 'warn', 'notify.botchedTreatment', {
      treatment: med.kind,
      part: BODY_PART_LABELS[bodyPart],
    });
    // Not a refusal: the item is gone and the player is worse off, which is the whole
    // point of trying to stitch yourself up below the skill for it.
    return accepted(wasted, med.useTicks, true);
  }

  // A worn kit works less well, which is what durability means for medicine.
  const quality = conditionMultiplier(stack, ctx.data);

  switch (med.kind) {
    case 'bandage': {
      const wasOpen = !part.bandaged;
      const stopped = clamp(med.bleedStop * quality, 0, 1);
      part.bleeding = Math.max(0, part.bleeding * (1 - stopped));
      part.bandaged = true;
      part.bandageQuality = med.cleanliness;
      if (part.bleeding <= 0) {
        ctx.events.emit({ type: 'bleedingStopped', entityId: player.id, bodyPart });
      }
      if (wasOpen && med.cleanliness < DIRTY_BANDAGE_CLEANLINESS) {
        const infectChance = DIRTY_BANDAGE_INFECT_CHANCE * (1 - med.cleanliness);
        if (rng.chance(infectChance) && part.infection < DIRTY_BANDAGE_SEED) {
          part.infection = DIRTY_BANDAGE_SEED;
          ctx.events.emit({
            type: 'infectionChanged',
            entityId: player.id,
            bodyPart,
            value: part.infection,
          });
        }
      }
      break;
    }
    case 'suture': {
      part.bleeding = 0;
      part.stitched = true;
      ctx.events.emit({ type: 'bleedingStopped', entityId: player.id, bodyPart });
      break;
    }
    case 'splint': {
      part.splinted = true;
      break;
    }
    case 'disinfect': {
      part.disinfectedTicks = Math.max(part.disinfectedTicks, DISINFECT_PROTECTION_TICKS);
      break;
    }
    default:
      break;
  }

  if (med.heal > 0) {
    part.health = Math.min(part.maxHealth, part.health + med.heal * quality);
  }
  if (med.painRelief > 0) part.pain = Math.max(0, part.pain - med.painRelief);
  if (med.infectionCure > 0 && part.infection > 0) {
    part.infection = Math.max(0, part.infection - med.infectionCure);
    if (part.infection <= 0) part.bitten = false;
    ctx.events.emit({
      type: 'infectionChanged',
      entityId: player.id,
      bodyPart,
      value: part.infection,
    });
  }

  applyEffectGrants(ctx, player, med.effects, `medical:${def.id}`);
  syncHealthFromBody(player);
  grantXp(ctx, player, 'medicine', TREAT_XP + med.skillLevel * TREAT_XP_PER_SKILL);
  const consumed = spendConsumable(ctx, player, stack, def, slot);
  bump(player);
  ctx.events.emit({
    type: 'treated',
    entityId: player.id,
    bodyPart,
    itemDefId: def.id,
    success: true,
  });
  return accepted(consumed, med.useTicks);
}

/** Swallow a pill or push an injection: whole-body, no target part. */
function medicate(
  ctx: SimContext,
  player: PlayerState,
  stack: ItemStack,
  def: ItemDef,
  med: MedicalProps,
  slot: ConsumeSlot | undefined,
): ConsumeResult {
  relievePainSystemically(player, med.painRelief);
  cureInfectionSystemically(ctx, player, med.infectionCure);
  healWorstPart(player, med.heal);
  applyEffectGrants(ctx, player, med.effects, `medical:${def.id}`);
  player.useReadyTick = ctx.state.tick + Math.max(1, med.useTicks);
  grantXp(ctx, player, 'medicine', TREAT_XP);
  const consumed = spendConsumable(ctx, player, stack, def, slot);
  bump(player);
  ctx.events.emit({
    type: 'treated',
    entityId: player.id,
    bodyPart: 'torso',
    itemDefId: def.id,
    success: true,
  });
  return accepted(consumed, med.useTicks);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Consume one item: eat it, drink it, or apply it as medicine.
 *
 * Called by the inventory system's `useItem` handler once it has resolved the slot
 * and established that the item is consumable. Returns a refusal rather than
 * throwing, so the caller can decide whether to emit `commandRejected` (a player
 * clicked it) or stay quiet (an automatic use).
 */
export function consumeItem(
  ctx: SimContext,
  player: PlayerState,
  stack: ItemStack,
  slot?: ConsumeSlot,
): ConsumeResult {
  if (!player.alive) return REFUSED('dead');
  if (ctx.state.tick < player.useReadyTick) return REFUSED('still busy');
  if (ctx.state.tick < player.actionLockedUntilTick) return REFUSED('cannot act');
  if (stack.count <= 0) return REFUSED('nothing there');

  const def = ctx.data.items.get(stack.defId);
  if (!def) return REFUSED('unknown item');

  // A vessel with something in it is a drink first, whatever else it also is.
  if (def.liquid && (stack.fill ?? 0) > 0) return drinkFromVessel(ctx, player, stack, def);
  if (def.food) return eat(ctx, player, stack, def, slot);
  if (def.drink) return drink(ctx, player, stack, def, slot);
  if (def.medical) {
    const kind = def.medical.kind;
    if (kind === 'pill' || kind === 'injection') {
      return medicate(ctx, player, stack, def, def.medical, slot);
    }
    const target = bestTreatmentTarget(player, kind);
    if (!target) return REFUSED('nothing to treat');
    return treatBodyPart(ctx, player, stack, target, slot);
  }
  return REFUSED('not consumable');
}

/** The `treat` command: apply a named item from a named slot to a named body part. */
export function handleTreat(
  ctx: SimContext,
  player: PlayerState,
  command: CommandOf<'treat'>,
): void {
  if (!player.alive) {
    reject(ctx, player, 'treat', 'dead');
    return;
  }
  if (!BODY_PART_IDS.includes(command.bodyPart)) {
    reject(ctx, player, 'treat', 'unknown body part');
    return;
  }
  const found = resolveConsumable(player, command.ref, command.index);
  if (!found) {
    reject(ctx, player, 'treat', 'no item in that slot');
    return;
  }
  const result = treatBodyPart(ctx, player, found.stack, command.bodyPart, found.slot);
  if (!result.ok) reject(ctx, player, 'treat', result.reason ?? 'refused');
}
