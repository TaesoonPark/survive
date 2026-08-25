import {
  createEmptyInventory,
  EQUIP_SLOTS,
  type EquipSlot,
  type EquipmentState,
  type InventoryState,
  type ItemDefId,
  type ItemStack,
  type PlayerState,
} from '@survive/protocol';
import type { GameData, ItemDef, ToolKind } from '@survive/game-data';

/**
 * Item and inventory primitives.
 *
 * Shared vocabulary for every system that touches items: crafting, looting,
 * gathering, farming, building and the inventory commands themselves. Pure functions
 * over plain state, so they unit-test without a simulation.
 */

/** Create a fresh stack, initialising the per-item state a definition implies. */
export function createStack(data: GameData, defId: ItemDefId, count = 1): ItemStack {
  const def = data.items.require(defId);
  const stack: ItemStack = { defId, count: Math.max(1, Math.floor(count)) };
  if (def.maxDurability !== undefined) stack.durability = def.maxDurability;
  if (def.perishable) stack.freshness = 1;
  if (def.weapon?.kind === 'ranged') {
    stack.ammo = 0;
  }
  if (def.liquid) {
    stack.fill = def.liquid.contentDefId ? def.liquid.capacity : 0;
    if (def.liquid.contentDefId) stack.contentDefId = def.liquid.contentDefId;
  }
  return stack;
}

/** Effective max stack size, honouring per-item state that forces singletons. */
export function maxStackSize(def: ItemDef): number {
  if (def.maxDurability !== undefined) return 1;
  if (def.weapon) return 1;
  if (def.armor) return 1;
  if (def.liquid) return 1;
  return Math.max(1, def.stackSize);
}

/**
 * Whether two stacks can merge.
 *
 * Anything carrying per-item state (durability, freshness, loaded ammo, a label)
 * stays separate, otherwise a pristine axe would absorb a broken one.
 */
export function canMerge(a: ItemStack, b: ItemStack, data: GameData): boolean {
  if (a.defId !== b.defId) return false;
  const def = data.items.get(a.defId);
  if (!def) return false;
  if (maxStackSize(def) <= 1) return false;
  if (a.durability !== undefined || b.durability !== undefined) return false;
  if (a.ammo || b.ammo) return false;
  if (a.label !== b.label) return false;
  if (a.contentDefId !== b.contentDefId) return false;
  if (a.fill !== undefined || b.fill !== undefined) return false;
  // Perishables merge only when their freshness is close, so a fresh apple is not
  // silently aged by a nearly-rotten one.
  if (a.freshness !== undefined || b.freshness !== undefined) {
    const fa = a.freshness ?? 1;
    const fb = b.freshness ?? 1;
    if (Math.abs(fa - fb) > 0.1) return false;
  }
  return true;
}

/** Merge `source` into `target` in place. Returns how many units moved. */
export function mergeStacks(target: ItemStack, source: ItemStack, data: GameData): number {
  if (!canMerge(target, source, data)) return 0;
  const def = data.items.require(target.defId);
  const space = maxStackSize(def) - target.count;
  if (space <= 0) return 0;
  const moved = Math.min(space, source.count);
  target.count += moved;
  source.count -= moved;
  if (target.freshness !== undefined && source.freshness !== undefined) {
    // Weighted average so mixing does not create freshness out of nothing.
    const total = target.count + moved;
    target.freshness =
      total > 0
        ? (target.freshness * (target.count - moved) + source.freshness * moved) / target.count
        : target.freshness;
  }
  return moved;
}

/**
 * Add a stack to an inventory, filling partial stacks first and then empty slots.
 * Mutates `stack.count` down as it goes. Returns the number of units left over.
 */
export function addToInventory(inv: InventoryState, stack: ItemStack, data: GameData): number {
  const def = data.items.get(stack.defId);
  if (!def) return stack.count;

  if (maxStackSize(def) > 1) {
    for (let i = 0; i < inv.slots.length && stack.count > 0; i++) {
      const slot = inv.slots[i];
      if (!slot) continue;
      mergeStacks(slot, stack, data);
    }
  }

  for (let i = 0; i < inv.slots.length && stack.count > 0; i++) {
    if (inv.slots[i]) continue;
    const size = maxStackSize(def);
    const take = Math.min(size, stack.count);
    const placed: ItemStack = { ...stack, count: take };
    inv.slots[i] = placed;
    stack.count -= take;
  }

  return stack.count;
}

/** Can the whole stack fit? Non-mutating. */
export function canFit(inv: InventoryState, stack: ItemStack, data: GameData): boolean {
  const def = data.items.get(stack.defId);
  if (!def) return false;
  const size = maxStackSize(def);
  let remaining = stack.count;
  if (size > 1) {
    for (const slot of inv.slots) {
      if (!slot) continue;
      if (canMerge(slot, stack, data)) remaining -= Math.max(0, size - slot.count);
      if (remaining <= 0) return true;
    }
  }
  for (const slot of inv.slots) {
    if (slot) continue;
    remaining -= size;
    if (remaining <= 0) return true;
  }
  return remaining <= 0;
}

/** Total units of a definition held in an inventory. */
export function countItem(inv: InventoryState, defId: ItemDefId): number {
  let total = 0;
  for (const slot of inv.slots) {
    if (slot && slot.defId === defId) total += slot.count;
  }
  return total;
}

/** Total units matching a tag, for tag-based recipe inputs. */
export function countTag(inv: InventoryState, tag: string, data: GameData): number {
  let total = 0;
  for (const slot of inv.slots) {
    if (!slot) continue;
    const def = data.items.get(slot.defId);
    if (def?.tags.includes(tag)) total += slot.count;
  }
  return total;
}

/**
 * Remove up to `count` units of a definition. Returns how many were actually removed.
 * Consumes the most-used (lowest durability, least fresh) stacks first.
 *
 * `taken` collects what actually left the pack, worst-first, so a caller that may have to
 * give it back can return the same items rather than freshly minted ones. Crafting needs
 * that: a refund built with `createStack` hands back full durability and full freshness,
 * which turns queue-then-cancel into a repair bench and a spoilage cure.
 */
export function removeFromInventory(
  inv: InventoryState,
  defId: ItemDefId,
  count: number,
  taken?: ItemStack[],
): number {
  if (count <= 0) return 0;
  const indices: number[] = [];
  for (let i = 0; i < inv.slots.length; i++) {
    if (inv.slots[i]?.defId === defId) indices.push(i);
  }
  indices.sort((a, b) => {
    const sa = inv.slots[a] as ItemStack;
    const sb = inv.slots[b] as ItemStack;
    const wear = (s: ItemStack) => s.durability ?? Number.POSITIVE_INFINITY;
    const fresh = (s: ItemStack) => s.freshness ?? Number.POSITIVE_INFINITY;
    return wear(sa) - wear(sb) || fresh(sa) - fresh(sb) || sa.count - sb.count;
  });

  let remaining = count;
  for (const index of indices) {
    if (remaining <= 0) break;
    const slot = inv.slots[index];
    if (!slot) continue;
    const take = Math.min(slot.count, remaining);
    if (taken) taken.push({ ...slot, count: take });
    slot.count -= take;
    remaining -= take;
    if (slot.count <= 0) inv.slots[index] = null;
  }
  return count - remaining;
}

/** Remove up to `count` units matching a tag. Returns how many were removed. */
export function removeByTag(
  inv: InventoryState,
  tag: string,
  count: number,
  data: GameData,
  taken?: ItemStack[],
): number {
  let remaining = count;
  for (let i = 0; i < inv.slots.length && remaining > 0; i++) {
    const slot = inv.slots[i];
    if (!slot) continue;
    const def = data.items.get(slot.defId);
    if (!def?.tags.includes(tag)) continue;
    const take = Math.min(slot.count, remaining);
    if (taken) taken.push({ ...slot, count: take });
    slot.count -= take;
    remaining -= take;
    if (slot.count <= 0) inv.slots[i] = null;
  }
  return count - remaining;
}

/** Take up to `count` units out of one slot, returning the removed stack. */
export function takeFromSlot(
  inv: InventoryState,
  index: number,
  count: number | null,
): ItemStack | null {
  const slot = inv.slots[index];
  if (!slot) return null;
  const take = count === null ? slot.count : Math.min(slot.count, Math.max(0, Math.floor(count)));
  if (take <= 0) return null;
  if (take >= slot.count) {
    inv.slots[index] = null;
    return slot;
  }
  slot.count -= take;
  return { ...slot, count: take };
}

/** First empty slot index, or -1. */
export function firstEmptySlot(inv: InventoryState): number {
  for (let i = 0; i < inv.slots.length; i++) {
    if (!inv.slots[i]) return i;
  }
  return -1;
}

/** Resize an inventory, preserving contents. Shrinking returns the displaced stacks. */
export function resizeInventory(inv: InventoryState, capacity: number): ItemStack[] {
  const displaced: ItemStack[] = [];
  if (capacity < inv.capacity) {
    for (let i = capacity; i < inv.slots.length; i++) {
      const slot = inv.slots[i];
      if (slot) displaced.push(slot);
    }
    inv.slots.length = capacity;
  } else {
    while (inv.slots.length < capacity) inv.slots.push(null);
  }
  inv.capacity = capacity;
  return displaced;
}

// ---------------------------------------------------------------------------
// Durability
// ---------------------------------------------------------------------------

/**
 * Spend durability. Returns true when the item broke and should be discarded.
 * Quality slows wear: a well-made axe lasts longer.
 */
export function spendDurability(stack: ItemStack, amount: number): boolean {
  if (stack.durability === undefined || amount <= 0) return false;
  const quality = stack.quality ?? 0.5;
  const wear = amount * (1.25 - quality * 0.5);
  stack.durability = Math.max(0, stack.durability - wear);
  return stack.durability <= 0;
}

/** Durability as a 0..1 fraction. Items without durability report 1. */
export function durabilityFraction(stack: ItemStack, data: GameData): number {
  if (stack.durability === undefined) return 1;
  const def = data.items.get(stack.defId);
  const max = def?.maxDurability ?? 0;
  if (max <= 0) return 1;
  return Math.max(0, Math.min(1, stack.durability / max));
}

/** Effectiveness multiplier: worn tools work worse, well-crafted ones better. */
export function conditionMultiplier(stack: ItemStack, data: GameData): number {
  const wear = durabilityFraction(stack, data);
  const quality = stack.quality ?? 0.5;
  // Never drop below 40%: a battered axe is still an axe.
  return (0.4 + wear * 0.6) * (0.85 + quality * 0.3);
}

// ---------------------------------------------------------------------------
// Weight
// ---------------------------------------------------------------------------

export function stackWeight(stack: ItemStack, data: GameData): number {
  const def = data.items.get(stack.defId);
  if (!def) return 0;
  return def.weight * stack.count;
}

export function inventoryWeight(inv: InventoryState, data: GameData): number {
  let total = 0;
  for (const slot of inv.slots) {
    if (slot) total += stackWeight(slot, data);
  }
  return total;
}

export function equipmentWeight(equipment: EquipmentState, data: GameData): number {
  let total = 0;
  for (const slot of EQUIP_SLOTS) {
    const stack = equipment[slot];
    if (stack) total += stackWeight(stack, data);
  }
  return total;
}

/** Recompute and store the player's carry weight. */
export function recomputeCarryWeight(player: PlayerState, data: GameData): void {
  player.carryWeight =
    inventoryWeight(player.inventory, data) + equipmentWeight(player.equipment, data);
}

// ---------------------------------------------------------------------------
// Equipment and tools
// ---------------------------------------------------------------------------

/** Default slot an item wants to occupy, or null when it is not equippable. */
export function defaultEquipSlot(def: ItemDef): EquipSlot | null {
  if (def.armor) return def.armor.slot;
  if (def.weapon) return 'mainHand';
  if (def.tool) return 'mainHand';
  if (def.containerSlots) return 'back';
  return null;
}

/** The item in the player's main hand, or null. */
export function heldItem(player: PlayerState): ItemStack | null {
  return player.equipment.mainHand ?? null;
}

/** Definition of the held item, or null. */
export function heldItemDef(player: PlayerState, data: GameData): ItemDef | null {
  const stack = heldItem(player);
  if (!stack) return null;
  return data.items.get(stack.defId) ?? null;
}

/**
 * Find a tool of the given role. Checks the hands first, then the backpack, so a
 * player with an axe stowed can still chop, just as a convenience.
 */
export function findTool(
  player: PlayerState,
  kind: ToolKind,
  data: GameData,
):
  | { stack: ItemStack; where: 'equipment'; slot: EquipSlot }
  | { stack: ItemStack; where: 'inventory'; index: number }
  | null {
  for (const slot of ['mainHand', 'offHand'] as const) {
    const stack = player.equipment[slot];
    if (!stack) continue;
    const def = data.items.get(stack.defId);
    if (def?.tool?.kinds.includes(kind)) return { stack, where: 'equipment', slot };
  }
  let best: { stack: ItemStack; index: number; tier: number } | null = null;
  for (let i = 0; i < player.inventory.slots.length; i++) {
    const stack = player.inventory.slots[i];
    if (!stack) continue;
    const def = data.items.get(stack.defId);
    const tool = def?.tool;
    if (!tool?.kinds.includes(kind)) continue;
    if (!best || tool.tier > best.tier) best = { stack, index: i, tier: tool.tier };
  }
  return best ? { stack: best.stack, where: 'inventory', index: best.index } : null;
}

/** True when the player has any tool filling the given role. */
export function hasTool(player: PlayerState, kind: ToolKind, data: GameData): boolean {
  return findTool(player, kind, data) !== null;
}

/** Best tier available for a tool role, or 0 when the player has none. */
export function toolTier(player: PlayerState, kind: ToolKind, data: GameData): number {
  const found = findTool(player, kind, data);
  if (!found) return 0;
  const def = data.items.get(found.stack.defId);
  return def?.tool?.tier ?? 0;
}

/** Extra inventory slots granted by the equipped backpack. */
export function bonusInventorySlots(player: PlayerState, data: GameData): number {
  let bonus = 0;
  for (const slot of EQUIP_SLOTS) {
    const stack = player.equipment[slot];
    if (!stack) continue;
    const def = data.items.get(stack.defId);
    if (def?.containerSlots) bonus += def.containerSlots;
  }
  return bonus;
}

/** Build a container inventory of the given size. */
export function createContainerInventory(capacity: number): InventoryState {
  return createEmptyInventory(capacity);
}
