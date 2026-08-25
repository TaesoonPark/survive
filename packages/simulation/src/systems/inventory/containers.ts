import {
  BASE_INVENTORY_SLOTS,
  EQUIP_SLOTS,
  TILE_SIZE,
  distance,
  tileCenter,
  type ContainerRef,
  type ContainerSubState,
  type EquipSlot,
  type InventoryState,
  type ItemDefId,
  type ItemStack,
  type PlayerState,
  type StructureState,
} from '@survive/protocol';
import type { GameData, ItemDef } from '@survive/game-data';
import type { SimContext } from '../../core/context';
import { canMerge, maxStackSize, mergeStacks, recomputeCarryWeight } from '../../core/items';
import { bump, markStructureDirty, structureTiles } from '../../core/queries';
import { tileKey } from '../../core/state';

/**
 * Addressing the places items live.
 *
 * Every item command in the protocol names its source and destination with a
 * {@link ContainerRef}, and every one of them needs the same validation: does the ref
 * resolve, is the player allowed to touch it, and is the slot index real. Doing that
 * once here - and handing back a uniform {@link SlotView} - is what keeps `moveItem`
 * from turning into a matrix of five source kinds times five destination kinds.
 *
 * The view deliberately hides *where* the slots live, but exposes the backing array
 * when there is one, because merge and auto-place want to walk a contiguous range.
 */

/** How close a player must stand to reach into a structure's container, in pixels. */
export const CONTAINER_REACH = TILE_SIZE * 2.5;

/** How close a player must be to scoop an item off the ground, in pixels. */
export const PICKUP_REACH = TILE_SIZE * 1.75;

/**
 * A window of item slots, wherever it physically lives.
 *
 * `length` is the number of addressable indices. Equipment views address exactly one
 * slot, so their only legal index is 0 (see {@link normalizeIndex}).
 */
export interface SlotView {
  readonly ref: ContainerRef;
  readonly length: number;
  get(index: number): ItemStack | null;
  set(index: number, stack: ItemStack | null): void;
  /** Replicate the change. Call once per command, after the last mutation. */
  commit(): void;
  /** The ground is write-only: you drop onto it, you never take a slot out of it. */
  readonly isGround: boolean;
  /** Set for equipment views; the slot they address. */
  readonly equipSlot: EquipSlot | null;
  /** Contiguous backing array, when the view has one. */
  readonly backing: InventoryState | null;
  /** Index inside {@link backing} of this view's slot 0. */
  readonly offset: number;
  /** Set for structure-container views. */
  readonly structure: StructureState | null;
}

export type ResolveResult = { ok: true; view: SlotView } | { ok: false; reason: string };

/** Options that tighten resolution for a particular command. */
export interface ResolveOptions {
  /**
   * Require the structure container to be the one the player has open. Reaching into
   * a container that was never opened would let a client skip the loot roll that
   * `openContainer` performs, so the moving commands demand it.
   */
  requireOpen?: boolean;
}

// ---------------------------------------------------------------------------
// Pocket windows
// ---------------------------------------------------------------------------

/** A worn container's pockets, expressed as a range of player inventory slots. */
export interface PocketWindow {
  slot: EquipSlot;
  defId: ItemDefId;
  /** First inventory index belonging to this pack. */
  start: number;
  length: number;
}

/**
 * Where each worn container's pockets sit inside the player's inventory.
 *
 * `ItemStack` has no nested slot array and never will - it has to stay a flat,
 * JSON-serializable record (Architecture Guard rule 6). So a backpack does not *hold*
 * items; it *extends* the inventory, and its pockets are the tail range it added. That
 * is what makes `{ kind: 'itemContainer' }` implementable: the ref names the first
 * inventory index of a pack's range, and the client can draw that range as the pack's
 * own grid while the simulation keeps one array.
 *
 * The ranges follow {@link EQUIP_SLOTS} order after the base slots, matching
 * `bonusInventorySlots`, so the same pack always owns the same range.
 */
export function pocketWindows(player: PlayerState, data: GameData): PocketWindow[] {
  const windows: PocketWindow[] = [];
  let start = BASE_INVENTORY_SLOTS;
  for (const slot of EQUIP_SLOTS) {
    const stack = player.equipment[slot];
    if (!stack) continue;
    const def = data.items.get(stack.defId);
    if (!def?.containerSlots) continue;
    windows.push({ slot, defId: stack.defId, start, length: def.containerSlots });
    start += def.containerSlots;
  }
  return windows;
}

/** Inventory capacity the player's current equipment implies. */
export function targetInventoryCapacity(player: PlayerState, data: GameData): number {
  let bonus = 0;
  for (const window of pocketWindows(player, data)) bonus += window.length;
  return BASE_INVENTORY_SLOTS + bonus;
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

function playerCommit(ctx: SimContext, player: PlayerState): void {
  recomputeCarryWeight(player, ctx.data);
  bump(player);
}

function inventoryView(
  ctx: SimContext,
  player: PlayerState,
  ref: ContainerRef,
  offset: number,
  length: number,
): SlotView {
  const inv = player.inventory;
  return {
    ref,
    length,
    get: (index) => inv.slots[offset + index] ?? null,
    set: (index, stack) => {
      inv.slots[offset + index] = stack;
    },
    commit: () => playerCommit(ctx, player),
    isGround: false,
    equipSlot: null,
    backing: inv,
    offset,
    structure: null,
  };
}

function equipmentView(
  ctx: SimContext,
  player: PlayerState,
  ref: ContainerRef,
  slot: EquipSlot,
): SlotView {
  return {
    ref,
    length: 1,
    get: () => player.equipment[slot] ?? null,
    set: (_index, stack) => {
      player.equipment[slot] = stack;
    },
    commit: () => playerCommit(ctx, player),
    isGround: false,
    equipSlot: slot,
    backing: null,
    offset: 0,
    structure: null,
  };
}

function structureView(
  ctx: SimContext,
  ref: ContainerRef,
  structure: StructureState,
  container: ContainerSubState,
): SlotView {
  return {
    ref,
    length: container.capacity,
    get: (index) => container.slots[index] ?? null,
    set: (index, stack) => {
      container.slots[index] = stack;
    },
    commit: () => {
      bump(structure);
      markStructureDirty(ctx.state, structure);
    },
    isGround: false,
    equipSlot: null,
    // A ContainerSubState is structurally an InventoryState, which lets the shared
    // inventory helpers work on a chest without a copy.
    backing: container,
    offset: 0,
    structure,
  };
}

function groundView(ref: ContainerRef): SlotView {
  return {
    ref,
    length: 0,
    get: () => null,
    set: () => {},
    commit: () => {},
    isGround: true,
    equipSlot: null,
    backing: null,
    offset: 0,
    structure: null,
  };
}

// ---------------------------------------------------------------------------
// Structure reach
// ---------------------------------------------------------------------------

/** Distance from a point to the nearest tile of a structure's footprint, in pixels. */
export function distanceToStructure(
  ctx: SimContext,
  structure: StructureState,
  x: number,
  y: number,
): number {
  const def = ctx.data.structures.get(structure.defId);
  const tiles = structureTiles(
    structure.tileX,
    structure.tileY,
    def?.width ?? 1,
    def?.height ?? 1,
    structure.rotation,
  );
  let best = Number.POSITIVE_INFINITY;
  for (const tile of tiles) {
    const d = distance(x, y, tileCenter(tile.tileX), tileCenter(tile.tileY));
    if (d < best) best = d;
  }
  return best;
}

/** Centre of a structure's footprint, for line-of-sight tests. */
export function structureFocus(
  ctx: SimContext,
  structure: StructureState,
): { x: number; y: number } {
  const def = ctx.data.structures.get(structure.defId);
  const swapped = structure.rotation % 2 === 1;
  const w = (swapped ? def?.height : def?.width) ?? 1;
  const h = (swapped ? def?.width : def?.height) ?? 1;
  return {
    x: tileCenter(structure.tileX) + ((w - 1) * TILE_SIZE) / 2,
    y: tileCenter(structure.tileY) + ((h - 1) * TILE_SIZE) / 2,
  };
}

/**
 * Whether the player can actually see the structure they are addressing.
 *
 * The plain sight test is not enough on its own, because the target is often the very
 * thing blocking the view: a closed door is opaque, and you have to be able to lock the
 * door you are standing in front of. So a blocked ray is re-tested, and accepted when
 * the thing it stopped on *is* the structure - which still refuses a chest on the far
 * side of a wall, where the ray stops on the wall instead.
 */
export function hasLineOfSightToStructure(
  ctx: SimContext,
  player: PlayerState,
  structure: StructureState,
): boolean {
  const focus = structureFocus(ctx, structure);
  if (ctx.world.hasLineOfSight(player.x, player.y, focus.x, focus.y)) return true;
  const hit = ctx.world.raycast(player.x, player.y, focus.x, focus.y);
  if (!hit) return false;
  return ctx.state.structureTiles[tileKey(hit.tileX, hit.tileY)] === structure.id;
}

/** Whether the player can see and reach a structure well enough to interact with it. */
export function canReachStructure(
  ctx: SimContext,
  player: PlayerState,
  structure: StructureState,
): { ok: true } | { ok: false; reason: string } {
  if (distanceToStructure(ctx, structure, player.x, player.y) > CONTAINER_REACH) {
    return { ok: false, reason: 'out of reach' };
  }
  if (!hasLineOfSightToStructure(ctx, player, structure)) {
    return { ok: false, reason: 'no line of sight' };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/** Turn a client-supplied {@link ContainerRef} into a validated {@link SlotView}. */
export function resolveRef(
  ctx: SimContext,
  player: PlayerState,
  ref: ContainerRef | undefined,
  options: ResolveOptions = {},
): ResolveResult {
  if (!ref || typeof ref !== 'object') return { ok: false, reason: 'malformed container ref' };
  switch (ref.kind) {
    case 'inventory':
      return { ok: true, view: inventoryView(ctx, player, ref, 0, player.inventory.slots.length) };

    case 'equipment': {
      if (!EQUIP_SLOTS.includes(ref.slot)) return { ok: false, reason: 'unknown equipment slot' };
      return { ok: true, view: equipmentView(ctx, player, ref, ref.slot) };
    }

    case 'structure': {
      const structure = ctx.state.structures[ref.structureId];
      if (!structure) return { ok: false, reason: 'no such structure' };
      const container = structure.container;
      if (!container) return { ok: false, reason: 'that structure has no container' };
      const reach = canReachStructure(ctx, player, structure);
      if (!reach.ok) return { ok: false, reason: reach.reason };
      // The lock belongs here and not only on `openContainer`. Every slot-level command -
      // moveItem, splitStack, dropItem, sortContainer, useItem - resolves its ref through
      // this function, so a lock checked only at opening time was no lock at all: an open
      // window is sticky (nothing closes it when the owner fits a lock), and a ref does not
      // require an open window in the first place. `takeAll` would answer "it is locked"
      // while `moveItem` emptied the same chest in the same tick.
      if (structure.door?.locked && structure.ownerId !== player.id) {
        return { ok: false, reason: 'it is locked' };
      }
      if (options.requireOpen && player.openContainerId !== structure.id) {
        return { ok: false, reason: 'container is not open' };
      }
      return { ok: true, view: structureView(ctx, ref, structure, container) };
    }

    case 'itemContainer': {
      const windows = pocketWindows(player, ctx.data);
      const window = windows.find((candidate) => candidate.start === ref.slotIndex);
      if (window) {
        return {
          ok: true,
          view: inventoryView(ctx, player, ref, window.start, window.length),
        };
      }
      const stowed = player.inventory.slots[ref.slotIndex];
      const def = stowed ? ctx.data.items.get(stowed.defId) : undefined;
      if (def?.containerSlots) return { ok: false, reason: 'that container is not being worn' };
      return { ok: false, reason: 'no such item container' };
    }

    case 'ground':
      return { ok: true, view: groundView(ref) };

    default:
      return { ok: false, reason: 'unknown container kind' };
  }
}

/**
 * Clamp a client index into a view.
 *
 * Equipment views address one slot, so any index a client sends for them means "that
 * slot"; rejecting non-zero indices there would only produce mystery failures in the
 * UI for no safety benefit.
 */
export function normalizeIndex(view: SlotView, index: number): number {
  if (view.equipSlot) return 0;
  return Math.trunc(index);
}

export function isValidIndex(view: SlotView, index: number): boolean {
  return Number.isInteger(index) && index >= 0 && index < view.length;
}

/** Whether two views address the same physical slots. */
export function sameView(a: SlotView, b: SlotView): boolean {
  if (a.equipSlot || b.equipSlot) return a.equipSlot === b.equipSlot;
  if (a.structure || b.structure) return a.structure === b.structure;
  return a.backing === b.backing && a.offset === b.offset && a.length === b.length;
}

// ---------------------------------------------------------------------------
// Placing items into a view
// ---------------------------------------------------------------------------

/**
 * Add a stack to a view: top up mergeable partial stacks first, then take empty
 * slots. Mutates `stack.count` down and returns what did not fit.
 *
 * This is `addToInventory` generalised to a window, so a pack's pockets and a chest
 * behave the same as the main grid.
 */
export function addToView(view: SlotView, stack: ItemStack, data: GameData): number {
  const def = data.items.get(stack.defId);
  if (!def) return stack.count;
  const size = maxStackSize(def);

  if (size > 1) {
    for (let i = 0; i < view.length && stack.count > 0; i++) {
      const slot = view.get(i);
      if (!slot) continue;
      if (mergeStacks(slot, stack, data) > 0) view.set(i, slot);
    }
  }
  for (let i = 0; i < view.length && stack.count > 0; i++) {
    if (view.get(i)) continue;
    const take = Math.min(size, stack.count);
    view.set(i, { ...stack, count: take });
    stack.count -= take;
  }
  return stack.count;
}

/** First index in a view that could accept any part of `stack`, or -1. */
export function firstAcceptingIndex(view: SlotView, stack: ItemStack, data: GameData): number {
  const def = data.items.get(stack.defId);
  if (!def) return -1;
  if (maxStackSize(def) > 1) {
    for (let i = 0; i < view.length; i++) {
      const slot = view.get(i);
      if (slot && canMerge(slot, stack, data) && slot.count < maxStackSize(def)) return i;
    }
  }
  for (let i = 0; i < view.length; i++) {
    if (!view.get(i)) return i;
  }
  return -1;
}

/** First empty index in a view, or -1. */
export function firstEmptyIndex(view: SlotView): number {
  for (let i = 0; i < view.length; i++) {
    if (!view.get(i)) return i;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

/**
 * Display order for sorting. Tools and weapons first because that is what a player
 * reaches for under pressure; raw resources last because they are bulk.
 */
const CATEGORY_RANK: readonly string[] = [
  'weapon',
  'tool',
  'ammo',
  'armor',
  'container',
  'medical',
  'food',
  'drink',
  'produce',
  'seed',
  'placeable',
  'fuel',
  'component',
  'resource',
  'misc',
];

function categoryRank(def: ItemDef | undefined): number {
  if (!def) return CATEGORY_RANK.length;
  const rank = CATEGORY_RANK.indexOf(def.category);
  return rank < 0 ? CATEGORY_RANK.length : rank;
}

/**
 * Compact, merge and sort a view in place.
 *
 * Deterministic by construction: the comparator falls through to the definition id
 * and then the count, so two servers given the same slots produce the same layout.
 */
export function sortView(view: SlotView, data: GameData): boolean {
  const stacks: (ItemStack | null)[] = [];
  for (let i = 0; i < view.length; i++) {
    const slot = view.get(i);
    if (slot) stacks.push(slot);
  }
  if (stacks.length === 0) return false;

  const before = stacks.map((stack) => `${stack?.defId}:${stack?.count}`).join('|');

  // Merge before sorting so two half stacks of nails become one.
  for (let i = 0; i < stacks.length; i++) {
    const target = stacks[i];
    if (!target) continue;
    for (let j = i + 1; j < stacks.length; j++) {
      const source = stacks[j];
      if (!source) continue;
      mergeStacks(target, source, data);
      if (source.count <= 0) stacks[j] = null;
    }
  }

  const live = stacks.filter((stack): stack is ItemStack => stack !== null && stack.count > 0);
  live.sort((a, b) => {
    const defA = data.items.get(a.defId);
    const defB = data.items.get(b.defId);
    return (
      categoryRank(defA) - categoryRank(defB) ||
      (a.defId < b.defId ? -1 : a.defId > b.defId ? 1 : 0) ||
      b.count - a.count
    );
  });

  for (let i = 0; i < view.length; i++) view.set(i, i < live.length ? (live[i] ?? null) : null);
  const after = live.map((stack) => `${stack.defId}:${stack.count}`).join('|');
  return before !== after;
}
