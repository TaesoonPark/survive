import {
  EQUIP_SLOTS,
  HOTBAR_SLOTS,
  SIM_HZ,
  distance,
  removeFrom,
  type CommandType,
  type ContainerRef,
  type ContainerSubState,
  type EquipSlot,
  type ItemDefId,
  type ItemStack,
  type PlayerState,
  type StructureState,
} from '@survive/protocol';
import type { GameData, ItemDef } from '@survive/game-data';
import { SystemOrder, type CommandRouter, type SimContext, type System } from '../../core/context';
import {
  addToInventory,
  canFit,
  canMerge,
  defaultEquipSlot,
  maxStackSize,
  mergeStacks,
  recomputeCarryWeight,
  resizeInventory,
} from '../../core/items';
import { dropStack, rollLootTable } from '../../core/loot';
import { bump, destroyEntity, markDirtyAt, markStructureDirty } from '../../core/queries';
import {
  CONTAINER_REACH,
  PICKUP_REACH,
  addToView,
  canReachStructure,
  distanceToStructure,
  firstEmptyIndex,
  isValidIndex,
  normalizeIndex,
  resolveRef,
  sameView,
  sortView,
  targetInventoryCapacity,
  type SlotView,
} from './containers';
import { consumeItem } from '../survival/consumption';

/**
 * Items, containers and the ground.
 *
 * `moveItem` is the most-used command in the game, so the shape of this file is
 * driven by it: every source and destination is reduced to a {@link SlotView} first
 * (see `containers.ts`), and the handler below then only has to reason about *slot*
 * cases - empty, mergeable, occupied, auto-place - instead of a matrix of container
 * kinds crossed with each other. Equipment is the one genuine special case, because a
 * slot there implies rules about what may be worn where and how many hands a weapon
 * needs.
 *
 * Everything here assumes the client is lying: refs are re-resolved, indices are
 * re-bounded, distances are re-measured, and the container a move touches must be the
 * one the *server* believes the player has open.
 *
 * `useItem` is the one command that is mostly *routing*: this system owns the slot, so
 * it resolves and validates it, then hands the stack to whoever owns the rule. Food,
 * drink and medicine go to the survival system's `consumeItem`; placeables arm the
 * building system's ghost; seeds wait for the farming system's `farm` command.
 */

/**
 * How long another player's fresh drop is off-limits.
 *
 * Long enough that a player who fumbles a swap in a shared base can pick their own
 * gear back up, short enough that it never feels like a lock. The dropper is never
 * blocked by their own protection window.
 */
export const DROP_PROTECTION_TICKS = SIM_HZ * 4;

/** Scatter radius, in pixels, applied to a dropped stack so piles stay readable. */
const DROP_SCATTER = 10;

function reject(ctx: SimContext, player: PlayerState, command: CommandType, reason: string): void {
  ctx.events.emit({ type: 'commandRejected', playerId: player.id, command, reason });
}

function notify(
  ctx: SimContext,
  player: PlayerState,
  severity: 'info' | 'warn' | 'error' | 'success',
  text: string,
): void {
  ctx.events.emit({ type: 'notification', playerId: player.id, severity, text });
}

function emitDropped(ctx: SimContext, player: PlayerState, stack: ItemStack): void {
  ctx.events.emit({
    type: 'itemDropped',
    playerId: player.id,
    stack,
    x: player.x,
    y: player.y,
  });
}

// ---------------------------------------------------------------------------
// Equipment rules
// ---------------------------------------------------------------------------

export function isTwoHanded(def: ItemDef): boolean {
  return def.weapon?.twoHanded === true;
}

/**
 * Where an item may be put.
 *
 * Armour and packs are restricted to the slot their definition names. Everything else
 * goes in a hand: being able to hold a log, a bandage or a seed packet is what makes
 * `useItem` and the build ghost work straight off the hotbar.
 *
 * A two-handed weapon is the exception: the main hand is the *only* slot that can hold
 * it. `equipInto` already refuses to put anything else in the off-hand while one is
 * wielded, but that guard alone is one-directional - park the spear in the off-hand
 * first and a knife slides into the main hand beside it, which is precisely the
 * two-weapon loadout `twoHanded` exists to forbid. Enforcing it here closes both
 * directions at once, because every equip path funnels through this predicate.
 */
export function equipSlotAccepts(def: ItemDef, slot: EquipSlot): boolean {
  if (def.armor) return def.armor.slot === slot;
  if (def.containerSlots) return slot === 'back';
  if (isTwoHanded(def)) return slot === 'mainHand';
  return slot === 'mainHand' || slot === 'offHand';
}

function twoHandedInMainHand(ctx: SimContext, player: PlayerState): boolean {
  const held = player.equipment.mainHand;
  if (!held) return false;
  const def = ctx.data.items.get(held.defId);
  return !!def && isTwoHanded(def);
}

/**
 * Resize the inventory to whatever the current equipment implies, spilling anything
 * that no longer fits.
 *
 * Called after *every* equipment change, so a pack always grants exactly its slots
 * and taking one off can never silently delete what was in it: the displaced stacks
 * are re-packed into the remaining grid first, and only the true overflow hits the
 * floor.
 */
export function syncInventoryCapacity(ctx: SimContext, player: PlayerState): ItemStack[] {
  const inv = player.inventory;
  const target = targetInventoryCapacity(player, ctx.data);
  if (inv.capacity === target && inv.slots.length === target) return [];

  const displaced = resizeInventory(inv, target);
  const spilled: ItemStack[] = [];
  for (const stack of displaced) {
    addToInventory(inv, stack, ctx.data);
    if (stack.count > 0) {
      dropStack(ctx, player.x, player.y, stack, player.id, DROP_SCATTER);
      spilled.push(stack);
      emitDropped(ctx, player, stack);
    }
  }
  // Hotbar entries are inventory indices; a shrunken grid leaves them dangling.
  for (let i = 0; i < player.hotbar.length; i++) {
    const entry = player.hotbar[i];
    if (entry !== null && entry !== undefined && entry >= inv.capacity) player.hotbar[i] = null;
  }
  if (spilled.length > 0) {
    notify(ctx, player, 'warn', 'Some items would not fit and fell on the ground.');
  }
  return spilled;
}

/**
 * Put a stack in the player's grid, preferring one particular slot, and drop whatever
 * will not fit. Returns true when nothing had to be dropped.
 */
function stowOrDrop(
  ctx: SimContext,
  player: PlayerState,
  stack: ItemStack,
  preferredIndex?: number,
): boolean {
  const inv = player.inventory;
  if (
    preferredIndex !== undefined &&
    preferredIndex >= 0 &&
    preferredIndex < inv.slots.length &&
    !inv.slots[preferredIndex]
  ) {
    inv.slots[preferredIndex] = stack;
    return true;
  }
  addToInventory(inv, stack, ctx.data);
  if (stack.count <= 0) return true;
  dropStack(ctx, player.x, player.y, stack, player.id, DROP_SCATTER);
  emitDropped(ctx, player, stack);
  return false;
}

type EquipOutcome = { ok: true; displaced: ItemStack | null } | { ok: false; reason: string };

/**
 * Put a stack into an equipment slot, handing back whatever it displaced.
 *
 * Two-handed weapons occupy the off-hand: equipping one stows whatever was there, and
 * while one is held nothing else may be put in the off-hand. The stow is checked
 * *before* anything is mutated, so a full inventory refuses the swap rather than
 * losing the shield.
 */
function equipInto(
  ctx: SimContext,
  player: PlayerState,
  slot: EquipSlot,
  stack: ItemStack,
): EquipOutcome {
  const def = ctx.data.items.get(stack.defId);
  if (!def) return { ok: false, reason: 'unknown item' };
  if (!equipSlotAccepts(def, slot)) return { ok: false, reason: 'that cannot be worn there' };

  if (slot === 'offHand' && twoHandedInMainHand(ctx, player)) {
    return { ok: false, reason: 'both hands are on that weapon' };
  }

  if (slot === 'mainHand' && isTwoHanded(def)) {
    const offHand = player.equipment.offHand;
    if (offHand) {
      if (!canFit(player.inventory, offHand, ctx.data)) {
        return { ok: false, reason: 'no room to stow your off-hand item' };
      }
      player.equipment.offHand = null;
      addToInventory(player.inventory, offHand, ctx.data);
    }
  }

  const displaced = player.equipment[slot] ?? null;
  player.equipment[slot] = stack;
  return { ok: true, displaced };
}

/**
 * Take an item out of an equipment slot and stow it.
 *
 * The order matters for packs: the pack is placed into a slot that will survive the
 * resize *first*, and only then does the resize spill its former contents. Losing a
 * rucksack hurts more than losing the twine that was in it - so when the grid that
 * survives the resize has nothing free, a pack (and only a pack) evicts one stack to
 * make room for itself. Anything else simply falls on the floor, which is the outcome
 * the player asked for by unequipping with a full inventory.
 */
function unequipToInventory(
  ctx: SimContext,
  player: PlayerState,
  slot: EquipSlot,
): { ok: true; dropped: boolean } | { ok: false; reason: string } {
  const stack = player.equipment[slot];
  if (!stack) return { ok: false, reason: 'nothing equipped there' };
  player.equipment[slot] = null;

  const target = targetInventoryCapacity(player, ctx.data);
  const inv = player.inventory;
  const limit = Math.min(target, inv.slots.length);
  let placed = false;
  for (let i = 0; i < limit && !placed; i++) {
    const existing = inv.slots[i];
    if (!existing) {
      inv.slots[i] = stack;
      placed = true;
    } else if (canMerge(existing, stack, ctx.data)) {
      mergeStacks(existing, stack, ctx.data);
      if (stack.count <= 0) placed = true;
    }
  }

  let evicted: ItemStack | null = null;
  const isPack = (ctx.data.items.get(stack.defId)?.containerSlots ?? 0) > 0;
  if (!placed && isPack && limit > 0) {
    // The pack's own removal is what caused the shortage, so it wins the last slot
    // that survives the resize; the stack that was there joins the spill.
    evicted = inv.slots[limit - 1] ?? null;
    inv.slots[limit - 1] = stack;
    placed = true;
  }

  syncInventoryCapacity(ctx, player);

  if (evicted) {
    addToInventory(inv, evicted, ctx.data);
    if (evicted.count > 0) {
      dropStack(ctx, player.x, player.y, evicted, player.id, DROP_SCATTER);
      emitDropped(ctx, player, evicted);
    }
  }

  if (!placed) {
    dropStack(ctx, player.x, player.y, stack, player.id, DROP_SCATTER);
    emitDropped(ctx, player, stack);
  }
  recomputeCarryWeight(player, ctx.data);
  bump(player);
  return { ok: true, dropped: !placed };
}

// ---------------------------------------------------------------------------
// Containers
// ---------------------------------------------------------------------------

/**
 * Roll a container's loot table, exactly once, ever.
 *
 * `rolled` is what makes a looted house stay looted - across every later visitor and
 * across a save/load. The roll is forked off the master RNG by table id, so the
 * contents of one cupboard do not shift because an unrelated system gained a die roll.
 */
export function rollContainerIfNeeded(
  ctx: SimContext,
  structure: StructureState,
  container: ContainerSubState,
): boolean {
  if (container.rolled || !container.lootTableId) return false;
  const stacks = rollLootTable(ctx, container.lootTableId, 'container');
  let placed = 0;
  for (const stack of stacks) {
    addToInventory(container, stack, ctx.data);
    if (stack.count <= 0) placed++;
  }
  container.rolled = true;
  bump(structure);
  markStructureDirty(ctx.state, structure);
  ctx.events.emit({ type: 'lootRolled', structureId: structure.id, items: placed });
  return true;
}

/** Close whatever container a player has open, if any. */
export function closeOpenContainer(ctx: SimContext, player: PlayerState): void {
  const openId = player.openContainerId;
  if (!openId) return;
  delete player.openContainerId;
  bump(player);
  const structure = ctx.state.structures[openId];
  if (structure?.container) {
    removeFrom(structure.container.viewers, player.id);
    bump(structure);
  }
  ctx.events.emit({ type: 'containerClosed', playerId: player.id, structureId: openId });
}

type ContainerLookup =
  | { ok: true; structure: StructureState; container: ContainerSubState }
  | { ok: false; reason: string };

/** A container structure the player may currently interact with, or a reason why not. */
function requireContainer(
  ctx: SimContext,
  player: PlayerState,
  structureId: string,
): ContainerLookup {
  const structure = ctx.state.structures[structureId];
  if (!structure) return { ok: false, reason: 'no such structure' };
  const container = structure.container;
  if (!container) return { ok: false, reason: 'that structure has no container' };
  const reach = canReachStructure(ctx, player, structure);
  if (!reach.ok) return { ok: false, reason: reach.reason };
  if (structure.door?.locked && structure.ownerId !== player.id) {
    return { ok: false, reason: 'it is locked' };
  }
  return { ok: true, structure, container };
}

// ---------------------------------------------------------------------------
// The system
// ---------------------------------------------------------------------------

export function createInventorySystem(): System {
  return {
    id: 'inventory',
    order: SystemOrder.Items,

    init(_ctx: SimContext, router: CommandRouter): void {
      router.on('moveItem', handleMoveItem);
      router.on('splitStack', handleSplitStack);
      router.on('sortContainer', handleSortContainer);
      router.on('dropItem', handleDropItem);
      router.on('pickUpItem', handlePickUpItem);
      router.on('takeAll', handleTakeAll);
      router.on('equipItem', handleEquipItem);
      router.on('unequipItem', handleUnequipItem);
      router.on('selectHotbar', handleSelectHotbar);
      router.on('assignHotbar', handleAssignHotbar);
      router.on('useItem', handleUseItem);
      router.on('openContainer', handleOpenContainer);
      router.on('closeContainer', handleCloseContainer);
      router.on('setLock', handleSetLock);
    },

    /**
     * An open container is state on the *player*, so the server has to keep checking
     * that the reason for it still holds: walk away, die, or have the chest broken out
     * from under you and the window closes itself. Line of sight is deliberately not
     * re-checked - standing on the far side of your own crate should not slam it shut.
     *
     * Grid size is reconciled here for the same reason `onPlayerJoin` does it: capacity is
     * derived from what is worn, and not every path that changes equipment is a command.
     * Death strips the pack directly (`core/death.ts`), which left the player carrying the
     * dead pack's pockets - usable slots granted by nothing - through death and respawn.
     * Reconciling on a sweep fixes that path and every future one, rather than patching
     * each place that forgets; `syncInventoryCapacity` returns immediately when the state
     * already agrees, so a consistent player costs one comparison.
     */
    update(ctx: SimContext): void {
      for (const id of Object.keys(ctx.state.players).sort()) {
        const player = ctx.state.players[id];
        if (!player) continue;

        syncInventoryCapacity(ctx, player);

        if (!player.openContainerId) continue;
        const structure = ctx.state.structures[player.openContainerId];
        if (!structure?.container || !player.alive) {
          closeOpenContainer(ctx, player);
          continue;
        }
        if (distanceToStructure(ctx, structure, player.x, player.y) > CONTAINER_REACH) {
          closeOpenContainer(ctx, player);
        }
      }
    },

    /**
     * Re-derive the grid size from what the player is actually wearing.
     *
     * Every *command* path already syncs, but a player state can arrive from anywhere:
     * restored from persistence, built by a test harness, or handed over by another
     * system. If a pack's `containerSlots` changed between builds, or the state was
     * assembled without going through `equipItem`, the pockets would stay the wrong size
     * for the rest of that player's life - and `pocketWindows` would hand out
     * `itemContainer` ranges that run off the end of the array. Doing it on join costs
     * nothing when the state is already consistent: the sync returns immediately.
     */
    onPlayerJoin(ctx: SimContext, player: PlayerState): void {
      syncInventoryCapacity(ctx, player);
      recomputeCarryWeight(player, ctx.data);
    },

    onPlayerLeave(ctx: SimContext, player: PlayerState): void {
      closeOpenContainer(ctx, player);
    },
  };
}

// ---------------------------------------------------------------------------
// moveItem
// ---------------------------------------------------------------------------

interface MoveItemCommand {
  from: ContainerRef;
  fromIndex: number;
  to: ContainerRef;
  toIndex: number | null;
  count: number | null;
}

function handleMoveItem(ctx: SimContext, player: PlayerState, command: MoveItemCommand): void {
  if (!player.alive) return reject(ctx, player, 'moveItem', 'you are dead');

  const fromResult = resolveRef(ctx, player, command.from, { requireOpen: true });
  if (!fromResult.ok) return reject(ctx, player, 'moveItem', `source: ${fromResult.reason}`);
  const toResult = resolveRef(ctx, player, command.to, { requireOpen: true });
  if (!toResult.ok) return reject(ctx, player, 'moveItem', `destination: ${toResult.reason}`);

  const from = fromResult.view;
  const to = toResult.view;
  if (from.isGround) return reject(ctx, player, 'moveItem', 'the ground is not a source');

  const fromIndex = normalizeIndex(from, command.fromIndex);
  if (!isValidIndex(from, fromIndex)) {
    return reject(ctx, player, 'moveItem', 'invalid source slot');
  }
  const source = from.get(fromIndex);
  if (!source) return reject(ctx, player, 'moveItem', 'source slot is empty');

  const requested =
    command.count === null || command.count === undefined
      ? source.count
      : Math.trunc(command.count);
  if (!Number.isFinite(requested) || requested <= 0) {
    return reject(ctx, player, 'moveItem', 'invalid count');
  }
  const count = Math.min(requested, source.count);
  const defId = source.defId;

  if (to.isGround) {
    const taken = takeFromView(from, fromIndex, count);
    if (!taken) return reject(ctx, player, 'moveItem', 'source slot is empty');
    finishDrop(ctx, player, from, taken);
    return;
  }

  const toIndex =
    command.toIndex === null || command.toIndex === undefined
      ? null
      : normalizeIndex(to, command.toIndex);

  // Dragging a stack back onto itself is normal UI noise, not an error.
  if (sameView(from, to) && toIndex === fromIndex) return;

  if (to.equipSlot) {
    moveIntoEquipment(ctx, player, from, fromIndex, to, count);
    return;
  }

  if (toIndex !== null && !isValidIndex(to, toIndex)) {
    return reject(ctx, player, 'moveItem', 'invalid destination slot');
  }

  // Auto-place: top up matching partial stacks, then take the first empty slot.
  if (toIndex === null) {
    const taken = takeFromView(from, fromIndex, count);
    if (!taken) return reject(ctx, player, 'moveItem', 'source slot is empty');
    addToView(to, taken, ctx.data);
    const leftover = taken.count;
    if (leftover > 0) returnToView(from, fromIndex, taken, ctx.data);
    if (leftover >= count) {
      from.commit();
      if (!sameView(from, to)) to.commit();
      return reject(ctx, player, 'moveItem', 'destination is full');
    }
    finishMove(ctx, player, from, to, defId, count - leftover);
    return;
  }

  const dest = to.get(toIndex);

  if (!dest) {
    const taken = takeFromView(from, fromIndex, count);
    if (!taken) return reject(ctx, player, 'moveItem', 'source slot is empty');
    const def = ctx.data.items.get(taken.defId);
    const size = def ? maxStackSize(def) : 1;
    if (taken.count > size) {
      // One slot cannot hold more than a full stack; the remainder stays put.
      const overflow: ItemStack = { ...taken, count: taken.count - size };
      taken.count = size;
      to.set(toIndex, taken);
      returnToView(from, fromIndex, overflow, ctx.data);
      finishMove(ctx, player, from, to, taken.defId, size);
      return;
    }
    to.set(toIndex, taken);
    finishMove(ctx, player, from, to, taken.defId, taken.count);
    return;
  }

  if (canMerge(dest, source, ctx.data)) {
    const taken = takeFromView(from, fromIndex, count);
    if (!taken) return reject(ctx, player, 'moveItem', 'source slot is empty');
    const moved = mergeStacks(dest, taken, ctx.data);
    to.set(toIndex, dest);
    if (taken.count > 0) returnToView(from, fromIndex, taken, ctx.data);
    if (moved === 0) {
      from.commit();
      if (!sameView(from, to)) to.commit();
      return reject(ctx, player, 'moveItem', 'destination stack is full');
    }
    finishMove(ctx, player, from, to, dest.defId, moved);
    return;
  }

  // Occupied by something that will not merge: swap - but only when the whole source
  // stack is moving, because a partial swap has nowhere to put the remainder.
  if (count < source.count) {
    return reject(ctx, player, 'moveItem', 'destination slot is occupied');
  }
  if (from.equipSlot) {
    const destDef = ctx.data.items.get(dest.defId);
    if (!destDef || !equipSlotAccepts(destDef, from.equipSlot)) {
      return reject(ctx, player, 'moveItem', 'that cannot be worn there');
    }
    // `equipSlotAccepts` answers about one slot in isolation, and the two-handed rule is
    // about *both*. The destination side of a move goes through `moveIntoEquipment` ->
    // `equipInto`, which enforces it; this branch writes straight into the slot the source
    // vacated, so without the same checks a swap produced the exact loadout `twoHanded`
    // exists to forbid - a two-handed weapon in the main hand beside a full off-hand.
    if (from.equipSlot === 'mainHand' && isTwoHanded(destDef) && player.equipment.offHand) {
      return reject(ctx, player, 'moveItem', 'no room to stow your off-hand item');
    }
    if (from.equipSlot === 'offHand' && twoHandedInMainHand(ctx, player)) {
      return reject(ctx, player, 'moveItem', 'both hands are on that weapon');
    }
  }
  const taken = takeFromView(from, fromIndex, count);
  if (!taken) return reject(ctx, player, 'moveItem', 'source slot is empty');
  to.set(toIndex, taken);
  from.set(fromIndex, dest);
  finishMove(ctx, player, from, to, taken.defId, taken.count);
}

/** Take `count` out of a view slot, clearing it when the stack is exhausted. */
function takeFromView(view: SlotView, index: number, count: number): ItemStack | null {
  const slot = view.get(index);
  if (!slot) return null;
  const take = Math.min(count, slot.count);
  if (take <= 0) return null;
  if (take >= slot.count) {
    view.set(index, null);
    return slot;
  }
  slot.count -= take;
  view.set(index, slot);
  return { ...slot, count: take };
}

/** Put an unmoved remainder back, preferring the slot it came out of. */
function returnToView(view: SlotView, index: number, stack: ItemStack, data: GameData): void {
  if (stack.count <= 0) return;
  const existing = view.get(index);
  if (!existing) {
    view.set(index, stack);
    return;
  }
  if (canMerge(existing, stack, data)) {
    mergeStacks(existing, stack, data);
    view.set(index, existing);
  }
  if (stack.count > 0) addToView(view, stack, data);
}

function finishMove(
  ctx: SimContext,
  player: PlayerState,
  from: SlotView,
  to: SlotView,
  defId: ItemDefId,
  count: number,
): void {
  from.commit();
  if (!sameView(from, to)) to.commit();
  if (from.equipSlot || to.equipSlot) {
    syncInventoryCapacity(ctx, player);
    recomputeCarryWeight(player, ctx.data);
    bump(player);
  }
  ctx.events.emit({ type: 'itemMoved', playerId: player.id, defId, count });
}

function finishDrop(ctx: SimContext, player: PlayerState, from: SlotView, stack: ItemStack): void {
  dropStack(ctx, player.x, player.y, stack, player.id, DROP_SCATTER);
  from.commit();
  if (from.equipSlot) syncInventoryCapacity(ctx, player);
  recomputeCarryWeight(player, ctx.data);
  bump(player);
  emitDropped(ctx, player, stack);
}

/** Equipment destinations: wear rules, two-handed weapons, and the swap-back. */
function moveIntoEquipment(
  ctx: SimContext,
  player: PlayerState,
  from: SlotView,
  fromIndex: number,
  to: SlotView,
  count: number,
): void {
  const slot = to.equipSlot;
  if (!slot) return;
  const source = from.get(fromIndex);
  if (!source) return reject(ctx, player, 'moveItem', 'source slot is empty');
  const occupied = to.get(0);
  // Swapping into an occupied slot has to move the whole stack: the displaced item
  // needs the source slot, and a partial move would not free it.
  if (occupied && count < source.count) {
    return reject(ctx, player, 'moveItem', 'unequip that first');
  }

  const taken = takeFromView(from, fromIndex, count);
  if (!taken) return reject(ctx, player, 'moveItem', 'source slot is empty');

  const outcome = equipInto(ctx, player, slot, taken);
  if (!outcome.ok) {
    returnToView(from, fromIndex, taken, ctx.data);
    from.commit();
    return reject(ctx, player, 'moveItem', outcome.reason);
  }
  if (outcome.displaced) {
    const displaced = outcome.displaced;
    returnToView(from, fromIndex, displaced, ctx.data);
    if (displaced.count > 0) {
      dropStack(ctx, player.x, player.y, displaced, player.id, DROP_SCATTER);
      emitDropped(ctx, player, displaced);
    }
  }
  finishMove(ctx, player, from, to, taken.defId, taken.count);
}

// ---------------------------------------------------------------------------
// splitStack / sortContainer
// ---------------------------------------------------------------------------

function handleSplitStack(
  ctx: SimContext,
  player: PlayerState,
  command: { ref: ContainerRef; index: number; count: number },
): void {
  if (!player.alive) return reject(ctx, player, 'splitStack', 'you are dead');
  const resolved = resolveRef(ctx, player, command.ref, { requireOpen: true });
  if (!resolved.ok) return reject(ctx, player, 'splitStack', resolved.reason);
  const view = resolved.view;
  if (view.isGround) return reject(ctx, player, 'splitStack', 'nothing to split there');
  if (view.equipSlot) return reject(ctx, player, 'splitStack', 'cannot split equipment');

  const index = normalizeIndex(view, command.index);
  if (!isValidIndex(view, index)) return reject(ctx, player, 'splitStack', 'invalid slot');
  const stack = view.get(index);
  if (!stack) return reject(ctx, player, 'splitStack', 'slot is empty');

  const count = Math.trunc(command.count);
  if (!Number.isFinite(count) || count <= 0) {
    return reject(ctx, player, 'splitStack', 'invalid count');
  }
  if (count >= stack.count) {
    return reject(ctx, player, 'splitStack', 'cannot split off the whole stack');
  }
  const empty = firstEmptyIndex(view);
  if (empty < 0) return reject(ctx, player, 'splitStack', 'no free slot to split into');

  stack.count -= count;
  view.set(index, stack);
  view.set(empty, { ...stack, count });
  view.commit();
  ctx.events.emit({ type: 'itemMoved', playerId: player.id, defId: stack.defId, count });
}

function handleSortContainer(
  ctx: SimContext,
  player: PlayerState,
  command: { ref: ContainerRef },
): void {
  if (!player.alive) return reject(ctx, player, 'sortContainer', 'you are dead');
  const resolved = resolveRef(ctx, player, command.ref, { requireOpen: true });
  if (!resolved.ok) return reject(ctx, player, 'sortContainer', resolved.reason);
  const view = resolved.view;
  if (view.isGround) return reject(ctx, player, 'sortContainer', 'nothing to sort there');
  if (view.equipSlot) return reject(ctx, player, 'sortContainer', 'cannot sort equipment');

  const isPlayerGrid = view.backing === player.inventory;
  // Hotbar entries point at slot *indices*, so remember what each one meant and
  // re-aim it afterwards. Skipping this silently rearms the wrong item mid-fight.
  const wanted = isPlayerGrid
    ? player.hotbar.map((entry) =>
        entry === null || entry === undefined
          ? null
          : (player.inventory.slots[entry]?.defId ?? null),
      )
    : null;

  const changed = sortView(view, ctx.data);

  if (wanted) {
    const claimed = new Set<number>();
    for (let i = 0; i < player.hotbar.length; i++) {
      const defId = wanted[i] ?? null;
      if (defId === null) {
        player.hotbar[i] = null;
        continue;
      }
      let found: number | null = null;
      for (let slot = 0; slot < player.inventory.slots.length; slot++) {
        if (claimed.has(slot)) continue;
        if (player.inventory.slots[slot]?.defId === defId) {
          found = slot;
          break;
        }
      }
      if (found !== null) claimed.add(found);
      player.hotbar[i] = found;
    }
  }
  view.commit();
  if (!changed) notify(ctx, player, 'info', 'Already tidy.');
}

// ---------------------------------------------------------------------------
// dropItem / pickUpItem / takeAll
// ---------------------------------------------------------------------------

function handleDropItem(
  ctx: SimContext,
  player: PlayerState,
  command: { ref: ContainerRef; index: number; count: number | null },
): void {
  if (!player.alive) return reject(ctx, player, 'dropItem', 'you are dead');
  const resolved = resolveRef(ctx, player, command.ref, { requireOpen: true });
  if (!resolved.ok) return reject(ctx, player, 'dropItem', resolved.reason);
  const view = resolved.view;
  if (view.isGround) return reject(ctx, player, 'dropItem', 'it is already on the ground');

  const index = normalizeIndex(view, command.index);
  if (!isValidIndex(view, index)) return reject(ctx, player, 'dropItem', 'invalid slot');
  const stack = view.get(index);
  if (!stack) return reject(ctx, player, 'dropItem', 'slot is empty');

  const requested =
    command.count === null || command.count === undefined ? stack.count : Math.trunc(command.count);
  if (!Number.isFinite(requested) || requested <= 0) {
    return reject(ctx, player, 'dropItem', 'invalid count');
  }
  const taken = takeFromView(view, index, Math.min(requested, stack.count));
  if (!taken) return reject(ctx, player, 'dropItem', 'slot is empty');
  finishDrop(ctx, player, view, taken);
}

function handlePickUpItem(
  ctx: SimContext,
  player: PlayerState,
  command: { itemEntityId: string },
): void {
  if (!player.alive) return reject(ctx, player, 'pickUpItem', 'you are dead');
  const entity = ctx.state.items[command.itemEntityId];
  if (!entity) return reject(ctx, player, 'pickUpItem', 'that item is gone');
  if (distance(player.x, player.y, entity.x, entity.y) > PICKUP_REACH) {
    return reject(ctx, player, 'pickUpItem', 'out of reach');
  }
  if (
    entity.droppedBy &&
    entity.droppedBy !== player.id &&
    ctx.state.tick - entity.droppedTick < DROP_PROTECTION_TICKS
  ) {
    return reject(ctx, player, 'pickUpItem', 'that is not yours yet');
  }

  const before = entity.stack.count;
  addToInventory(player.inventory, entity.stack, ctx.data);
  const picked = before - entity.stack.count;
  if (picked <= 0) return reject(ctx, player, 'pickUpItem', 'no room in your inventory');

  const pickedStack: ItemStack = { ...entity.stack, count: picked };
  markDirtyAt(ctx.state, entity.x, entity.y);
  if (entity.stack.count <= 0) destroyEntity(ctx.state, entity.id);
  else bump(entity);

  recomputeCarryWeight(player, ctx.data);
  bump(player);
  ctx.events.emit({ type: 'itemPickedUp', playerId: player.id, stack: pickedStack });
}

/**
 * Empty a container into the player's inventory.
 *
 * Unlike the moving commands this does not require the container to be *open*,
 * because quick-looting a cupboard you are standing in front of is the whole point of
 * the button - so it performs the first-open loot roll itself rather than giving a
 * client a way to skip it.
 */
function handleTakeAll(
  ctx: SimContext,
  player: PlayerState,
  command: { structureId: string },
): void {
  if (!player.alive) return reject(ctx, player, 'takeAll', 'you are dead');
  const found = requireContainer(ctx, player, command.structureId);
  if (!found.ok) return reject(ctx, player, 'takeAll', found.reason);
  const { structure, container } = found;
  rollContainerIfNeeded(ctx, structure, container);

  let moved = 0;
  let leftBehind = 0;
  for (let i = 0; i < container.slots.length; i++) {
    const stack = container.slots[i];
    if (!stack) continue;
    const before = stack.count;
    addToInventory(player.inventory, stack, ctx.data);
    const taken = before - stack.count;
    if (taken > 0) {
      moved += taken;
      ctx.events.emit({
        type: 'itemMoved',
        playerId: player.id,
        defId: stack.defId,
        count: taken,
      });
    }
    if (stack.count <= 0) container.slots[i] = null;
    else leftBehind += stack.count;
  }

  if (moved === 0) {
    return reject(
      ctx,
      player,
      'takeAll',
      leftBehind > 0 ? 'no room in your inventory' : 'it is empty',
    );
  }
  recomputeCarryWeight(player, ctx.data);
  bump(player);
  bump(structure);
  markStructureDirty(ctx.state, structure);
  if (leftBehind > 0) notify(ctx, player, 'warn', 'Your inventory filled up.');
}

// ---------------------------------------------------------------------------
// equipItem / unequipItem
// ---------------------------------------------------------------------------

function handleEquipItem(
  ctx: SimContext,
  player: PlayerState,
  command: { inventorySlot: number; slot?: EquipSlot },
): void {
  if (!player.alive) return reject(ctx, player, 'equipItem', 'you are dead');
  const index = Math.trunc(command.inventorySlot);
  if (!Number.isInteger(index) || index < 0 || index >= player.inventory.slots.length) {
    return reject(ctx, player, 'equipItem', 'invalid inventory slot');
  }
  const stack = player.inventory.slots[index];
  if (!stack) return reject(ctx, player, 'equipItem', 'slot is empty');
  const def = ctx.data.items.get(stack.defId);
  if (!def) return reject(ctx, player, 'equipItem', 'unknown item');

  const slot = command.slot ?? defaultEquipSlot(def);
  if (!slot) return reject(ctx, player, 'equipItem', 'that cannot be equipped');
  if (!EQUIP_SLOTS.includes(slot)) {
    return reject(ctx, player, 'equipItem', 'unknown equipment slot');
  }
  if (!equipSlotAccepts(def, slot)) {
    return reject(ctx, player, 'equipItem', 'that cannot be worn there');
  }

  player.inventory.slots[index] = null;
  const outcome = equipInto(ctx, player, slot, stack);
  if (!outcome.ok) {
    player.inventory.slots[index] = stack;
    return reject(ctx, player, 'equipItem', outcome.reason);
  }
  if (outcome.displaced) stowOrDrop(ctx, player, outcome.displaced, index);
  syncInventoryCapacity(ctx, player);
  recomputeCarryWeight(player, ctx.data);
  bump(player);
  ctx.events.emit({
    type: 'itemMoved',
    playerId: player.id,
    defId: stack.defId,
    count: stack.count,
  });
}

function handleUnequipItem(
  ctx: SimContext,
  player: PlayerState,
  command: { slot: EquipSlot },
): void {
  if (!player.alive) return reject(ctx, player, 'unequipItem', 'you are dead');
  if (!EQUIP_SLOTS.includes(command.slot)) {
    return reject(ctx, player, 'unequipItem', 'unknown equipment slot');
  }
  const stack = player.equipment[command.slot];
  if (!stack) return reject(ctx, player, 'unequipItem', 'nothing equipped there');
  const defId = stack.defId;
  const result = unequipToInventory(ctx, player, command.slot);
  if (!result.ok) return reject(ctx, player, 'unequipItem', result.reason);
  if (result.dropped) notify(ctx, player, 'warn', 'No room - it fell on the ground.');
  ctx.events.emit({ type: 'itemMoved', playerId: player.id, defId, count: 1 });
}

// ---------------------------------------------------------------------------
// Hotbar
// ---------------------------------------------------------------------------

/**
 * Select a hotbar slot.
 *
 * The hotbar is a set of pointers into the inventory, so selecting one is a *swap*:
 * whatever is in the main hand goes back into the slot the new item came out of. An
 * empty entry is the bare-hands slot and simply stows what is held.
 */
function handleSelectHotbar(
  ctx: SimContext,
  player: PlayerState,
  command: { index: number },
): void {
  if (!player.alive) return reject(ctx, player, 'selectHotbar', 'you are dead');
  const index = Math.trunc(command.index);
  if (!Number.isInteger(index) || index < 0 || index >= player.hotbar.length) {
    return reject(ctx, player, 'selectHotbar', 'invalid hotbar slot');
  }
  player.activeHotbar = index;
  bump(player);

  const inv = player.inventory;
  const entry = player.hotbar[index];
  const slotIndex =
    entry === null || entry === undefined || entry < 0 || entry >= inv.slots.length ? -1 : entry;
  const wanted = slotIndex >= 0 ? (inv.slots[slotIndex] ?? null) : null;

  if (!wanted) {
    if (!player.equipment.mainHand) return;
    const result = unequipToInventory(ctx, player, 'mainHand');
    if (!result.ok) return reject(ctx, player, 'selectHotbar', result.reason);
    if (result.dropped) notify(ctx, player, 'warn', 'No room - it fell on the ground.');
    return;
  }
  if (player.equipment.mainHand === wanted) return;

  inv.slots[slotIndex] = null;
  const outcome = equipInto(ctx, player, 'mainHand', wanted);
  if (!outcome.ok) {
    inv.slots[slotIndex] = wanted;
    return reject(ctx, player, 'selectHotbar', outcome.reason);
  }
  if (outcome.displaced) stowOrDrop(ctx, player, outcome.displaced, slotIndex);
  syncInventoryCapacity(ctx, player);
  recomputeCarryWeight(player, ctx.data);
  bump(player);
  ctx.events.emit({
    type: 'itemMoved',
    playerId: player.id,
    defId: wanted.defId,
    count: wanted.count,
  });
}

function handleAssignHotbar(
  ctx: SimContext,
  player: PlayerState,
  command: { hotbarIndex: number; inventorySlot: number | null },
): void {
  if (!player.alive) return reject(ctx, player, 'assignHotbar', 'you are dead');
  const index = Math.trunc(command.hotbarIndex);
  if (!Number.isInteger(index) || index < 0 || index >= HOTBAR_SLOTS) {
    return reject(ctx, player, 'assignHotbar', 'invalid hotbar slot');
  }
  if (command.inventorySlot === null || command.inventorySlot === undefined) {
    player.hotbar[index] = null;
    bump(player);
    return;
  }
  const slot = Math.trunc(command.inventorySlot);
  if (!Number.isInteger(slot) || slot < 0 || slot >= player.inventory.slots.length) {
    return reject(ctx, player, 'assignHotbar', 'invalid inventory slot');
  }
  // One inventory slot on two hotbar keys would fight over the main hand.
  for (let i = 0; i < player.hotbar.length; i++) {
    if (i !== index && player.hotbar[i] === slot) player.hotbar[i] = null;
  }
  player.hotbar[index] = slot;
  bump(player);
}

// ---------------------------------------------------------------------------
// useItem
// ---------------------------------------------------------------------------

function handleUseItem(
  ctx: SimContext,
  player: PlayerState,
  command: { ref: ContainerRef; index: number },
): void {
  if (!player.alive) return reject(ctx, player, 'useItem', 'you are dead');
  if (ctx.state.tick < player.useReadyTick) {
    return reject(ctx, player, 'useItem', 'still busy');
  }
  const resolved = resolveRef(ctx, player, command.ref, { requireOpen: true });
  if (!resolved.ok) return reject(ctx, player, 'useItem', resolved.reason);
  const view = resolved.view;
  if (view.isGround) return reject(ctx, player, 'useItem', 'nothing to use there');
  const index = normalizeIndex(view, command.index);
  if (!isValidIndex(view, index)) return reject(ctx, player, 'useItem', 'invalid slot');
  const stack = view.get(index);
  if (!stack) return reject(ctx, player, 'useItem', 'slot is empty');
  const def = ctx.data.items.get(stack.defId);
  if (!def) return reject(ctx, player, 'useItem', 'unknown item');

  // Placeables and seeds are not "used" here: they arm the systems that own the tile
  // grid. Selecting is the whole action - the item is spent when the building or
  // farming system actually commits it, which is also where the placement rules live.
  if (def.placesStructureDefId) {
    if (!ctx.data.structures.has(def.placesStructureDefId)) {
      return reject(ctx, player, 'useItem', 'that cannot be placed');
    }
    player.buildDefId = def.placesStructureDefId;
    bump(player);
    notify(ctx, player, 'success', `${def.name} ready to place.`);
    return;
  }
  if (def.cropDefId) {
    if (!ctx.data.crops.has(def.cropDefId)) {
      return reject(ctx, player, 'useItem', 'that will not grow');
    }
    notify(ctx, player, 'info', `Plant ${def.name} on a tilled plot.`);
    return;
  }

  if (!isConsumable(def)) return reject(ctx, player, 'useItem', 'nothing happens');

  // The survival system owns what a mouthful of food *does*, including the busy
  // window and the sickness roll; this system owns the slot it came out of. It
  // decrements the stack itself, so all that is left here is to clear an empty slot.
  const result = consumeItem(ctx, player, stack);
  if (!result.ok) return reject(ctx, player, 'useItem', result.reason ?? 'nothing happens');
  if (stack.count <= 0) view.set(index, null);
  view.commit();
  recomputeCarryWeight(player, ctx.data);
  bump(player);
}

/**
 * Whether `useItem` should hand this definition to the survival system.
 *
 * A vessel counts: a canteen is used by drinking from it, and `consumeItem` refuses an
 * empty one with a reason a player can act on.
 */
export function isConsumable(def: ItemDef): boolean {
  return !!(def.food || def.drink || def.medical || (def.liquid && def.liquid.capacity > 0));
}

// ---------------------------------------------------------------------------
// openContainer / closeContainer / setLock
// ---------------------------------------------------------------------------

function handleOpenContainer(
  ctx: SimContext,
  player: PlayerState,
  command: { structureId: string },
): void {
  if (!player.alive) return reject(ctx, player, 'openContainer', 'you are dead');
  const found = requireContainer(ctx, player, command.structureId);
  if (!found.ok) return reject(ctx, player, 'openContainer', found.reason);
  const { structure, container } = found;

  if (player.openContainerId === structure.id) return;
  if (player.openContainerId) closeOpenContainer(ctx, player);

  rollContainerIfNeeded(ctx, structure, container);

  if (!container.viewers.includes(player.id)) container.viewers.push(player.id);
  player.openContainerId = structure.id;
  bump(player);
  bump(structure);
  ctx.events.emit({ type: 'containerOpened', playerId: player.id, structureId: structure.id });
}

function handleCloseContainer(ctx: SimContext, player: PlayerState): void {
  closeOpenContainer(ctx, player);
}

/**
 * Fit or clear a lock.
 *
 * {@link DoorSubState} is the only lock record the state model has, so a lockable
 * *container* borrows one: the `open` flag is meaningless for a chest, but `locked`
 * and `code` are exactly what is needed. Collision is driven off the structure
 * *definition*, so a chest carrying a door sub-state never starts behaving as a door.
 */
function handleSetLock(
  ctx: SimContext,
  player: PlayerState,
  command: { structureId: string; code: string | null },
): void {
  if (!player.alive) return reject(ctx, player, 'setLock', 'you are dead');
  const structure = ctx.state.structures[command.structureId];
  if (!structure) return reject(ctx, player, 'setLock', 'no such structure');
  const reach = canReachStructure(ctx, player, structure);
  if (!reach.ok) return reject(ctx, player, 'setLock', reach.reason);
  if (structure.ownerId !== player.id) {
    return reject(ctx, player, 'setLock', 'you do not own that');
  }

  const def = ctx.data.structures.get(structure.defId);
  const lockableDoor = def?.door?.lockable === true;
  const lockableContainer = !!structure.container;
  if (!lockableDoor && !lockableContainer) {
    return reject(ctx, player, 'setLock', 'that has nowhere to fit a lock');
  }

  const code = command.code;
  if (code !== null && code !== undefined) {
    if (typeof code !== 'string' || code.length === 0 || code.length > 16) {
      return reject(ctx, player, 'setLock', 'invalid code');
    }
  }

  const door = structure.door ?? { open: false, locked: false };
  structure.door = door;
  if (code === null || code === undefined) {
    door.locked = false;
    delete door.code;
  } else {
    door.locked = true;
    door.code = code;
  }
  bump(structure);
  markStructureDirty(ctx.state, structure);
  notify(ctx, player, 'success', door.locked ? 'Locked.' : 'Unlocked.');
}
