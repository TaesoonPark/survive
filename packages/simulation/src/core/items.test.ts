import { beforeEach, describe, expect, it } from 'vitest';
import {
  createEmptyEquipment,
  createEmptyInventory,
  type ItemStack,
  type PlayerState,
} from '@survive/protocol';
import {
  addToInventory,
  bonusInventorySlots,
  canFit,
  canMerge,
  conditionMultiplier,
  countItem,
  countTag,
  createStack,
  defaultEquipSlot,
  durabilityFraction,
  findTool,
  firstEmptySlot,
  hasTool,
  inventoryWeight,
  maxStackSize,
  mergeStacks,
  removeFromInventory,
  resizeInventory,
  spendDurability,
  takeFromSlot,
  toolTier,
} from './items';
import { createMiniGameData } from './testing';

const data = createMiniGameData();

describe('createStack', () => {
  it('initialises durability for tools', () => {
    const axe = createStack(data, 'axe');
    expect(axe).toMatchObject({ defId: 'axe', count: 1, durability: 100 });
  });

  it('initialises freshness for perishables', () => {
    expect(createStack(data, 'apple', 3)).toMatchObject({ count: 3, freshness: 1 });
  });

  it('initialises a liquid container to full when it has default contents', () => {
    expect(createStack(data, 'bottle')).toMatchObject({ fill: 100, contentDefId: 'water' });
  });

  it('never creates a zero or negative stack', () => {
    expect(createStack(data, 'wood', 0).count).toBe(1);
    expect(createStack(data, 'wood', -5).count).toBe(1);
  });

  it('throws on an unknown definition instead of creating a ghost item', () => {
    expect(() => createStack(data, 'nope')).toThrow(/Unknown item/);
  });
});

describe('stacking rules', () => {
  it('forces items with per-item state to be singletons', () => {
    expect(maxStackSize(data.items.require('wood'))).toBe(100);
    expect(maxStackSize(data.items.require('axe'))).toBe(1);
    expect(maxStackSize(data.items.require('club'))).toBe(1);
    expect(maxStackSize(data.items.require('vest'))).toBe(1);
    expect(maxStackSize(data.items.require('bottle'))).toBe(1);
  });

  it('merges plain resources', () => {
    const a: ItemStack = { defId: 'wood', count: 5 };
    const b: ItemStack = { defId: 'wood', count: 3 };
    expect(canMerge(a, b, data)).toBe(true);
    expect(mergeStacks(a, b, data)).toBe(3);
    expect(a.count).toBe(8);
    expect(b.count).toBe(0);
  });

  it('refuses to merge different items', () => {
    expect(canMerge({ defId: 'wood', count: 1 }, { defId: 'stone', count: 1 }, data)).toBe(false);
  });

  it('never merges tools, so a pristine axe cannot absorb a broken one', () => {
    const good = createStack(data, 'axe');
    const broken = createStack(data, 'axe');
    broken.durability = 1;
    expect(canMerge(good, broken, data)).toBe(false);
    expect(mergeStacks(good, broken, data)).toBe(0);
    expect(good.durability).toBe(100);
  });

  it('keeps differently-aged perishables apart', () => {
    const fresh = createStack(data, 'apple', 2);
    const stale = createStack(data, 'apple', 2);
    stale.freshness = 0.3;
    expect(canMerge(fresh, stale, data)).toBe(false);
  });

  it('merges similarly-aged perishables and averages their freshness', () => {
    const a = createStack(data, 'apple', 2);
    a.freshness = 0.9;
    const b = createStack(data, 'apple', 2);
    b.freshness = 0.85;
    expect(canMerge(a, b, data)).toBe(true);
    mergeStacks(a, b, data);
    expect(a.count).toBe(4);
    expect(a.freshness).toBeLessThan(0.9);
    expect(a.freshness).toBeGreaterThan(0.8);
  });

  it('respects labels so a marked stack is not absorbed', () => {
    expect(
      canMerge({ defId: 'wood', count: 1, label: 'mine' }, { defId: 'wood', count: 1 }, data),
    ).toBe(false);
  });

  it('stops at the stack ceiling', () => {
    const full: ItemStack = { defId: 'apple', count: 10 };
    const more: ItemStack = { defId: 'apple', count: 5 };
    expect(mergeStacks(full, more, data)).toBe(0);
    expect(more.count).toBe(5);
  });
});

describe('inventory', () => {
  let inv = createEmptyInventory(4);

  beforeEach(() => {
    inv = createEmptyInventory(4);
  });

  it('fills partial stacks before opening new slots', () => {
    inv.slots[0] = { defId: 'apple', count: 8 };
    const leftover = addToInventory(inv, { defId: 'apple', count: 5 }, data);
    expect(leftover).toBe(0);
    expect(inv.slots[0]).toMatchObject({ count: 10 });
    expect(inv.slots[1]).toMatchObject({ count: 3 });
  });

  it('splits a large stack across slots', () => {
    const leftover = addToInventory(inv, { defId: 'apple', count: 25 }, data);
    expect(leftover).toBe(0);
    expect(inv.slots.filter(Boolean)).toHaveLength(3);
    expect(countItem(inv, 'apple')).toBe(25);
  });

  it('reports what did not fit rather than deleting it', () => {
    const stack: ItemStack = { defId: 'apple', count: 100 };
    const leftover = addToInventory(inv, stack, data);
    expect(leftover).toBe(60); // 4 slots x 10 per stack
    expect(stack.count).toBe(60);
    expect(countItem(inv, 'apple')).toBe(40);
  });

  it('canFit agrees with addToInventory', () => {
    expect(canFit(inv, { defId: 'apple', count: 40 }, data)).toBe(true);
    expect(canFit(inv, { defId: 'apple', count: 41 }, data)).toBe(false);
    inv.slots[0] = { defId: 'apple', count: 5 };
    expect(canFit(inv, { defId: 'apple', count: 35 }, data)).toBe(true);
  });

  it('canFit is non-mutating', () => {
    const stack: ItemStack = { defId: 'apple', count: 5 };
    canFit(inv, stack, data);
    expect(stack.count).toBe(5);
    expect(inv.slots.every((slot) => slot === null)).toBe(true);
  });

  it('removes across multiple slots and clears emptied ones', () => {
    addToInventory(inv, { defId: 'apple', count: 25 }, data);
    expect(removeFromInventory(inv, 'apple', 12)).toBe(12);
    expect(countItem(inv, 'apple')).toBe(13);
    expect(removeFromInventory(inv, 'apple', 100)).toBe(13);
    expect(countItem(inv, 'apple')).toBe(0);
    expect(inv.slots.every((slot) => slot === null)).toBe(true);
  });

  it('consumes the most worn tool first, keeping the good one', () => {
    const good = createStack(data, 'axe');
    const worn = createStack(data, 'axe');
    worn.durability = 5;
    inv.slots[0] = good;
    inv.slots[1] = worn;
    expect(removeFromInventory(inv, 'axe', 1)).toBe(1);
    expect(inv.slots[0]).toBe(good);
    expect(inv.slots[1]).toBeNull();
  });

  it('takes a partial amount out of one slot', () => {
    inv.slots[0] = { defId: 'wood', count: 10 };
    const taken = takeFromSlot(inv, 0, 4);
    expect(taken).toMatchObject({ defId: 'wood', count: 4 });
    expect(inv.slots[0]).toMatchObject({ count: 6 });
  });

  it('takes the whole slot when count is null', () => {
    inv.slots[0] = { defId: 'wood', count: 10 };
    expect(takeFromSlot(inv, 0, null)).toMatchObject({ count: 10 });
    expect(inv.slots[0]).toBeNull();
  });

  it('returns null for empty slots and non-positive counts', () => {
    expect(takeFromSlot(inv, 0, 5)).toBeNull();
    inv.slots[0] = { defId: 'wood', count: 3 };
    expect(takeFromSlot(inv, 0, 0)).toBeNull();
    expect(takeFromSlot(inv, 99, 1)).toBeNull();
  });

  it('finds the first empty slot', () => {
    expect(firstEmptySlot(inv)).toBe(0);
    inv.slots[0] = { defId: 'wood', count: 1 };
    expect(firstEmptySlot(inv)).toBe(1);
    for (let i = 0; i < inv.slots.length; i++) inv.slots[i] = { defId: 'wood', count: 1 };
    expect(firstEmptySlot(inv)).toBe(-1);
  });

  it('grows without losing contents and shrinks by displacing them', () => {
    inv.slots[3] = { defId: 'wood', count: 7 };
    expect(resizeInventory(inv, 8)).toEqual([]);
    expect(inv.capacity).toBe(8);
    expect(inv.slots).toHaveLength(8);
    expect(inv.slots[3]).toMatchObject({ count: 7 });

    const displaced = resizeInventory(inv, 2);
    expect(displaced).toHaveLength(1);
    expect(displaced[0]).toMatchObject({ defId: 'wood', count: 7 });
    expect(inv.slots).toHaveLength(2);
  });

  it('counts by tag', () => {
    inv.slots[0] = { defId: 'wood', count: 4 };
    expect(countTag(inv, 'nothing', data)).toBe(0);
  });

  it('sums weight from the definition table', () => {
    inv.slots[0] = { defId: 'wood', count: 4 }; // 1kg each
    inv.slots[1] = { defId: 'stone', count: 2 }; // 2kg each
    expect(inventoryWeight(inv, data)).toBeCloseTo(8, 6);
  });
});

describe('durability', () => {
  it('wears down and reports breakage exactly once at zero', () => {
    const axe = createStack(data, 'axe');
    axe.quality = 0.5;
    expect(spendDurability(axe, 50)).toBe(false);
    expect(axe.durability).toBeCloseTo(50, 6);
    expect(spendDurability(axe, 50)).toBe(true);
    expect(axe.durability).toBe(0);
  });

  it('makes better-quality items last longer', () => {
    const cheap = createStack(data, 'axe');
    cheap.quality = 0;
    const fine = createStack(data, 'axe');
    fine.quality = 1;
    spendDurability(cheap, 10);
    spendDurability(fine, 10);
    expect(fine.durability!).toBeGreaterThan(cheap.durability!);
  });

  it('ignores items without durability', () => {
    const wood: ItemStack = { defId: 'wood', count: 1 };
    expect(spendDurability(wood, 10)).toBe(false);
    expect(durabilityFraction(wood, data)).toBe(1);
  });

  it('never lets a worn tool become useless', () => {
    const axe = createStack(data, 'axe');
    axe.durability = 1;
    expect(conditionMultiplier(axe, data)).toBeGreaterThan(0.3);
    expect(conditionMultiplier(axe, data)).toBeLessThan(1);
  });
});

describe('equipment and tools', () => {
  it('picks a default slot from the definition', () => {
    expect(defaultEquipSlot(data.items.require('vest'))).toBe('chest');
    expect(defaultEquipSlot(data.items.require('club'))).toBe('mainHand');
    expect(defaultEquipSlot(data.items.require('axe'))).toBe('mainHand');
    expect(defaultEquipSlot(data.items.require('pack'))).toBe('back');
    expect(defaultEquipSlot(data.items.require('wood'))).toBeNull();
  });

  function makePlayer() {
    return {
      inventory: createEmptyInventory(6),
      equipment: createEmptyEquipment(),
    } as never as PlayerState;
  }

  it('prefers a tool in hand over one in the pack', () => {
    const player = makePlayer();
    player.equipment.mainHand = createStack(data, 'axe');
    player.inventory.slots[0] = createStack(data, 'good_axe');
    const found = findTool(player, 'axe', data);
    expect(found?.where).toBe('equipment');
  });

  it('falls back to the best tool in the pack', () => {
    const player = makePlayer();
    player.inventory.slots[0] = createStack(data, 'axe');
    player.inventory.slots[1] = createStack(data, 'good_axe');
    const found = findTool(player, 'axe', data);
    expect(found?.where).toBe('inventory');
    expect(found?.stack.defId).toBe('good_axe');
    expect(toolTier(player, 'axe', data)).toBe(3);
  });

  it('reports no tool when there is none', () => {
    const player = makePlayer();
    expect(findTool(player, 'pickaxe', data)).toBeNull();
    expect(hasTool(player, 'pickaxe', data)).toBe(false);
    expect(toolTier(player, 'pickaxe', data)).toBe(0);
  });

  it('counts backpack slots from equipped containers only', () => {
    const player = makePlayer();
    expect(bonusInventorySlots(player, data)).toBe(0);
    player.inventory.slots[0] = createStack(data, 'pack');
    expect(bonusInventorySlots(player, data)).toBe(0);
    player.equipment.back = createStack(data, 'pack');
    expect(bonusInventorySlots(player, data)).toBe(8);
  });
});
