import {
  EQUIP_SLOTS,
  SIM_HZ,
  Tile,
  clamp01,
  distance,
  hashString,
  pixelToTile,
  tileCenter,
  type ContainerSubState,
  type EntityId,
  type ItemEntityState,
  type ItemStack,
  type PlayerState,
  type StructureState,
} from '@survive/protocol';
import type { PerishableProps } from '@survive/game-data';
import { SystemOrder, type SimContext, type System } from '../../core/context';
import {
  addToInventory,
  canMerge,
  createStack,
  maxStackSize,
  mergeStacks,
  recomputeCarryWeight,
} from '../../core/items';
import { dropStack } from '../../core/loot';
import { bump, destroyEntity, markDirtyAt, markStructureDirty } from '../../core/queries';
// The protection window belongs to the inventory system, which owns pickup; this
// module only has to agree with it.
import { DROP_PROTECTION_TICKS } from './inventorySystem';

/**
 * The life and death of items that are not in anyone's hands.
 *
 * Two jobs that both have to be cheap, because they run over *everything* the world is
 * holding rather than over what a player just touched:
 *
 * - **Ground piles.** Old drops despawn, and drops that landed on the same spot are
 *   folded together so a mass of loot is one entity instead of forty.
 * - **Rot.** Perishables lose freshness wherever they are - on the floor, in a pack,
 *   or in a chest - because food quietly rotting in storage is the pressure that makes
 *   preserving it interesting. Doing that naively would mean walking every slot of
 *   every container every tick, so the work is staggered: each entity is visited once
 *   per {@link SPOIL_CYCLE_TICKS} and charged for the whole cycle when it is.
 *
 * Everything iterates in sorted id order. Rot can drop a stack on the floor, dropping
 * consumes the master RNG, and consuming the RNG in a different order is a different
 * world (Architecture Guard rule 7).
 */

/**
 * How often a given entity's perishables are re-checked, in ticks.
 *
 * One second. Long enough that a thousand containers cost fifty visits a tick, short
 * enough that the freshness a client renders is never visibly stale, and the error it
 * introduces at the moment a stack is created is at most one second of shelf life.
 */
export const SPOIL_CYCLE_TICKS = Math.max(1, Math.round(SIM_HZ));

/**
 * How often the ground is swept for despawns and merges, in ticks.
 *
 * Rounded to a whole tick: the sweep fires on `tick % GROUND_SWEEP_TICKS === 0`, and a
 * fractional interval would simply never be due.
 */
export const GROUND_SWEEP_TICKS = Math.max(1, Math.round(SIM_HZ / 2));

/** How close two ground piles must be to fold into one, in pixels. */
export const MERGE_RADIUS = 12;

/** Ambient temperature at or below which stored food keeps noticeably longer. */
export const COOL_TEMPERATURE_C = 10;

/** Coolness contributed by being inside a closed container rather than in the open. */
export const SEALED_COOLNESS = 0.5;
/** Coolness contributed by cold ambient air. */
export const COLD_AIR_COOLNESS = 0.35;
/** Coolness contributed by standing on an interior floor, out of the sun. */
export const INDOOR_COOLNESS = 0.15;

/** Interior floor tiles, the tile world's stand-in for "has a roof over it". */
const INTERIOR_TILES: readonly number[] = [Tile.FloorWood, Tile.FloorTile, Tile.FloorConcrete];

// ---------------------------------------------------------------------------
// Spoilage model
// ---------------------------------------------------------------------------

/**
 * How cool the place a stack is stored in is, 0..1.
 *
 * 0 is bare ground under an open sky; 1 earns the definition's full
 * `refrigeratedMultiplier`. There is no fridge in the game, so "cool" has to be
 * assembled out of what the world can actually offer: a closed container keeps the sun
 * off, cold air does most of the rest, and an interior floor finishes the job. A chest
 * therefore always preserves food better than the floor does, and a chest indoors in
 * winter preserves it best - which is the decision the mechanic exists to create.
 */
export function storageCoolness(ctx: SimContext, x: number, y: number, sealed: boolean): number {
  let coolness = sealed ? SEALED_COOLNESS : 0;
  if (ctx.state.weather.temperature <= COOL_TEMPERATURE_C) coolness += COLD_AIR_COOLNESS;
  if (INTERIOR_TILES.includes(ctx.world.getTile(pixelToTile(x), pixelToTile(y)))) {
    coolness += INDOOR_COOLNESS;
  }
  return clamp01(coolness);
}

/**
 * Spoil-rate multiplier for a given coolness: 1 in the open, the definition's
 * `refrigeratedMultiplier` in a properly cool place, linear in between.
 */
export function spoilRateMultiplier(perishable: PerishableProps, coolness: number): number {
  const cold = Math.max(0, perishable.refrigeratedMultiplier);
  return 1 + (cold - 1) * clamp01(coolness);
}

/** Freshness lost by one stagger cycle at the given coolness, as a 0..1 fraction. */
export function freshnessLossPerCycle(perishable: PerishableProps, coolness: number): number {
  if (perishable.spoilTicks <= 0) return 1;
  return (SPOIL_CYCLE_TICKS / perishable.spoilTicks) * spoilRateMultiplier(perishable, coolness);
}

/**
 * One place a perishable stack lives, expressed as the two things rot needs to do to
 * it: overwrite it, and find somewhere for anything that no longer fits.
 *
 * Wrapping the three storage kinds this way is what keeps the decay arithmetic in one
 * place instead of once per container type.
 */
interface SpoilTarget {
  /** Entity the stack belongs to, for the `itemSpoiled` event. */
  readonly ownerId: EntityId;
  readonly stack: ItemStack;
  /** Replace the stack in its slot. `null` empties the slot. */
  replace(stack: ItemStack | null): void;
  /** Somewhere for rot that will not fit in one slot. */
  overflow(stack: ItemStack): void;
}

/**
 * Age one stack. Returns true when anything changed, so the caller knows whether to
 * replicate its owner.
 */
function decayStack(ctx: SimContext, target: SpoilTarget, coolness: number): boolean {
  const stack = target.stack;
  const def = ctx.data.items.get(stack.defId);
  const perishable = def?.perishable;
  if (!perishable) return false;

  const current = stack.freshness ?? 1;
  const next = current - freshnessLossPerCycle(perishable, coolness);
  if (next > 0) {
    stack.freshness = next;
    return true;
  }

  ctx.events.emit({ type: 'itemSpoiled', entityId: target.ownerId, defId: stack.defId });

  const spoiledDefId = perishable.spoiledDefId;
  if (!spoiledDefId || !ctx.data.items.has(spoiledDefId)) {
    // Nothing to turn into: the stack is simply gone. `spoiledDefId` is the content
    // author's way of saying "this leaves something behind".
    target.replace(null);
    return true;
  }

  const spoiledDef = ctx.data.items.require(spoiledDefId);
  const size = maxStackSize(spoiledDef);
  const total = stack.count;
  const kept = Math.min(total, size);
  target.replace(createStack(ctx.data, spoiledDefId, kept));
  if (total > kept) target.overflow(createStack(ctx.data, spoiledDefId, total - kept));
  return true;
}

// ---------------------------------------------------------------------------
// Staggering
// ---------------------------------------------------------------------------

/**
 * Which cycle phase an entity is visited on.
 *
 * Hashed from the id rather than taken from a position in the table, so an entity keeps
 * its phase as neighbours come and go - otherwise items would shuffle between phases
 * and some would be charged twice while others were skipped.
 */
export function spoilPhase(id: EntityId): number {
  return hashString(id) % SPOIL_CYCLE_TICKS;
}

/**
 * Ids from a table whose phase is due this tick, in sorted order.
 *
 * The filter itself is one cheap pass over the keys - no cheaper than the spatial index
 * rebuild already does every tick - and what it saves is the expensive part: reading
 * and writing forty slots per container, which happens to 1/{@link SPOIL_CYCLE_TICKS}
 * of the world instead of all of it. Only the due ids are sorted, because the sort is
 * there for determinism (rot can drop items, and dropping rolls dice) and paying
 * `n log n` for the whole table to order a handful would defeat the point.
 */
function duePhase(table: Record<string, unknown>, phase: number): EntityId[] {
  const due: EntityId[] = [];
  for (const id of Object.keys(table)) {
    if (spoilPhase(id) === phase) due.push(id);
  }
  due.sort();
  return due;
}

// ---------------------------------------------------------------------------
// Rot, per storage kind
// ---------------------------------------------------------------------------

function decayGroundItem(ctx: SimContext, entity: ItemEntityState): void {
  const coolness = storageCoolness(ctx, entity.x, entity.y, false);
  let destroyed = false;
  const changed = decayStack(
    ctx,
    {
      ownerId: entity.id,
      stack: entity.stack,
      replace: (stack) => {
        if (stack) {
          // A ground pile is one entity holding one stack, so it may exceed a slot's
          // stack size; picking it up splits it again. No overflow can arise here.
          entity.stack = stack;
        } else {
          destroyEntity(ctx.state, entity.id);
          destroyed = true;
        }
      },
      overflow: () => {},
    },
    coolness,
  );
  if (!changed) return;
  markDirtyAt(ctx.state, entity.x, entity.y);
  if (!destroyed) bump(entity);
}

/**
 * The whole grid a player carries, including any worn pack's pockets.
 *
 * A player carrying anything perishable is therefore re-sent once per cycle - once a
 * second, against a snapshot rate of ten a second. That is the price of the client
 * being able to draw a freshness bar that is true; the alternative, only replicating on
 * a threshold, means the number the player reads is wrong most of the time.
 */
function decayPlayerItems(ctx: SimContext, player: PlayerState): void {
  const coolness = storageCoolness(ctx, player.x, player.y, false);
  let changed = false;

  const inv = player.inventory;
  for (let i = 0; i < inv.slots.length; i++) {
    const stack = inv.slots[i];
    if (!stack) continue;
    changed =
      decayStack(
        ctx,
        {
          ownerId: player.id,
          stack,
          replace: (next) => {
            inv.slots[i] = next;
          },
          overflow: (extra) => spillIntoPlayer(ctx, player, extra),
        },
        coolness,
      ) || changed;
  }

  // Held food rots too: a sandwich in your hand is not in cold storage either.
  for (const slot of EQUIP_SLOTS) {
    const stack = player.equipment[slot];
    if (!stack) continue;
    changed =
      decayStack(
        ctx,
        {
          ownerId: player.id,
          stack,
          replace: (next) => {
            player.equipment[slot] = next;
          },
          overflow: (extra) => spillIntoPlayer(ctx, player, extra),
        },
        coolness,
      ) || changed;
  }

  if (!changed) return;
  recomputeCarryWeight(player, ctx.data);
  bump(player);
}

/** Put rot that will not fit in the player's grid, or on the floor at their feet. */
function spillIntoPlayer(ctx: SimContext, player: PlayerState, stack: ItemStack): void {
  addToInventory(player.inventory, stack, ctx.data);
  if (stack.count > 0) dropStack(ctx, player.x, player.y, stack, player.id);
}

function decayContainer(
  ctx: SimContext,
  structure: StructureState,
  container: ContainerSubState,
): void {
  const x = tileCenter(structure.tileX);
  const y = tileCenter(structure.tileY);
  const coolness = storageCoolness(ctx, x, y, true);
  let changed = false;

  for (let i = 0; i < container.slots.length; i++) {
    const stack = container.slots[i];
    if (!stack) continue;
    changed =
      decayStack(
        ctx,
        {
          ownerId: structure.id,
          stack,
          replace: (next) => {
            container.slots[i] = next;
          },
          overflow: (extra) => {
            addToInventory(container, extra, ctx.data);
            if (extra.count > 0) dropStack(ctx, x, y, extra);
          },
        },
        coolness,
      ) || changed;
  }

  if (!changed) return;
  bump(structure);
  markStructureDirty(ctx.state, structure);
}

// ---------------------------------------------------------------------------
// Ground sweep
// ---------------------------------------------------------------------------

/**
 * Remove ground items whose time is up.
 *
 * `itemDespawnTicks = -1` means "never", and it is honoured here as well as at drop
 * time: a world whose knob was turned off after a drop keeps what is already lying
 * around, rather than reaping it on the next sweep.
 */
function sweepDespawns(ctx: SimContext): void {
  if (ctx.config.tuning.itemDespawnTicks < 0) return;
  const tick = ctx.state.tick;
  for (const id of Object.keys(ctx.state.items).sort()) {
    const entity = ctx.state.items[id];
    if (!entity || entity.despawnTick < 0) continue;
    if (tick < entity.despawnTick) continue;
    markDirtyAt(ctx.state, entity.x, entity.y);
    destroyEntity(ctx.state, id);
  }
}

/**
 * Whether two piles may be folded together.
 *
 * Drop protection is per-pile, so merging across it would launder someone else's gear
 * into a pile anyone can take. Piles with the same owner merge freely; otherwise both
 * have to be out of their protection window first.
 */
function mayMerge(ctx: SimContext, a: ItemEntityState, b: ItemEntityState): boolean {
  if (a.droppedBy !== undefined && a.droppedBy === b.droppedBy) return true;
  return !isProtected(ctx, a) && !isProtected(ctx, b);
}

function isProtected(ctx: SimContext, entity: ItemEntityState): boolean {
  if (entity.droppedBy === undefined) return false;
  return ctx.state.tick - entity.droppedTick < DROP_PROTECTION_TICKS;
}

/**
 * Fold ground piles that landed on the same spot into one entity.
 *
 * Bucketed by tile so the sweep stays linear in the number of items rather than
 * quadratic: two piles that straddle a tile boundary are left alone, which costs one
 * entity and saves scanning neighbours.
 */
function mergeGroundPiles(ctx: SimContext): void {
  const buckets = new Map<string, EntityId[]>();
  for (const id of Object.keys(ctx.state.items).sort()) {
    const entity = ctx.state.items[id];
    if (!entity) continue;
    const key = `${pixelToTile(entity.x)},${pixelToTile(entity.y)}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(id);
    else buckets.set(key, [id]);
  }

  for (const key of [...buckets.keys()].sort()) {
    const ids = buckets.get(key);
    if (!ids || ids.length < 2) continue;
    for (let i = 0; i < ids.length; i++) {
      const targetId = ids[i];
      if (targetId === undefined) continue;
      const target = ctx.state.items[targetId];
      if (!target) continue;
      for (let j = i + 1; j < ids.length; j++) {
        const otherId = ids[j];
        if (otherId === undefined) continue;
        const other = ctx.state.items[otherId];
        if (!other) continue;
        if (distance(target.x, target.y, other.x, other.y) > MERGE_RADIUS) continue;
        if (!canMerge(target.stack, other.stack, ctx.data)) continue;
        if (!mayMerge(ctx, target, other)) continue;
        if (mergeStacks(target.stack, other.stack, ctx.data) <= 0) continue;

        // The pile inherits the longer life of the two, so a fresh drop landing on an
        // almost-expired one is not reaped seconds later.
        if (target.despawnTick >= 0 && other.despawnTick < 0) target.despawnTick = -1;
        else if (target.despawnTick >= 0) {
          target.despawnTick = Math.max(target.despawnTick, other.despawnTick);
        }
        bump(target);
        if (other.stack.count <= 0) {
          markDirtyAt(ctx.state, other.x, other.y);
          destroyEntity(ctx.state, otherId);
        } else {
          bump(other);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// The system
// ---------------------------------------------------------------------------

export function createItemEntitySystem(): System {
  return {
    id: 'itemEntities',
    // Straight after the inventory system, so a stack dropped or spoiled by a command
    // this tick is accounted for on the same tick rather than the next one.
    order: SystemOrder.Items + 1,

    update(ctx: SimContext): void {
      if (ctx.state.tick % GROUND_SWEEP_TICKS === 0) {
        sweepDespawns(ctx);
        mergeGroundPiles(ctx);
      }

      const phase = ctx.state.tick % SPOIL_CYCLE_TICKS;
      for (const id of duePhase(ctx.state.items, phase)) {
        const entity = ctx.state.items[id];
        if (entity) decayGroundItem(ctx, entity);
      }
      for (const id of duePhase(ctx.state.players, phase)) {
        const player = ctx.state.players[id];
        if (player) decayPlayerItems(ctx, player);
      }
      for (const id of duePhase(ctx.state.structures, phase)) {
        const structure = ctx.state.structures[id];
        if (structure?.container) decayContainer(ctx, structure, structure.container);
      }
    },
  };
}
