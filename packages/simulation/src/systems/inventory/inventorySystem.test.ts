import { describe, expect, it } from 'vitest';
import {
  BASE_INVENTORY_SLOTS,
  SIM_HZ,
  pixelToTile,
  tileCenter,
  type ContainerRef,
  type ItemStack,
  type PlayerState,
  type StructureState,
} from '@survive/protocol';
import { createTestSimulation, type TestSimulation } from '@survive/test-utils';
import { killPlayer } from '../../core/death';
import { createStack } from '../../core/items';
import { dropStack } from '../../core/loot';
import {
  DROP_PROTECTION_TICKS,
  createInventorySystem,
  equipSlotAccepts,
  isConsumable,
} from './inventorySystem';
import { CONTAINER_REACH, PICKUP_REACH, pocketWindows } from './containers';

/**
 * Item commands, driven exactly as a client drives them.
 *
 * `moveItem` gets the most attention because it is the most-used command in the game
 * and every one of its edge cases is a real bug someone would hit within an hour:
 * partial counts, merges, swaps, auto-place, and the four ways a ref can be a lie.
 * The rejections matter as much as the successes - a client that gets a silent no-op
 * shows the player an item that is not there.
 */

const INVENTORY: ContainerRef = { kind: 'inventory' };
const GROUND: ContainerRef = { kind: 'ground' };

function makeSim(patch?: Parameters<typeof createTestSimulation>[0]): TestSimulation {
  return createTestSimulation({ systems: [createInventorySystem()], ...patch });
}

/** Put a stack in an exact slot, for fixtures that care about slot numbers. */
function place(sim: TestSimulation, player: PlayerState, index: number, defId: string, count = 1) {
  const stack = createStack(sim.data, defId, count);
  player.inventory.slots[index] = stack;
  return stack;
}

function rejection(sim: TestSimulation): string | undefined {
  return sim.lastEvent('commandRejected')?.reason;
}

/** A container the player is standing next to, with a known set of contents. */
function placeBox(
  sim: TestSimulation,
  player: PlayerState,
  defId = 'storage_box',
  tileOffset = 1,
): StructureState {
  const structure = sim.placeStructure(
    defId,
    pixelToTile(player.x) + tileOffset,
    pixelToTile(player.y),
    0,
    player.id,
  );
  if (!structure) throw new Error(`could not place ${defId}`);
  return structure;
}

function boxRef(structure: StructureState): ContainerRef {
  return { kind: 'structure', structureId: structure.id };
}

function fillEverySlot(sim: TestSimulation, player: PlayerState): void {
  for (let i = 0; i < player.inventory.slots.length; i++) {
    player.inventory.slots[i] = createStack(sim.data, 'stone', 30);
  }
}

// ---------------------------------------------------------------------------
// moveItem
// ---------------------------------------------------------------------------

describe('moveItem', () => {
  it('moves a whole stack between inventory slots', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    place(sim, player, 0, 'wood_log', 7);

    sim.run(player, {
      type: 'moveItem',
      from: INVENTORY,
      fromIndex: 0,
      to: INVENTORY,
      toIndex: 5,
      count: null,
    });

    expect(player.inventory.slots[0]).toBeNull();
    expect(player.inventory.slots[5]).toMatchObject({ defId: 'wood_log', count: 7 });
    expect(sim.lastEvent('itemMoved')).toMatchObject({ defId: 'wood_log', count: 7 });
  });

  it('moves a partial count and leaves the remainder behind', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    place(sim, player, 0, 'wood_log', 7);

    sim.run(player, {
      type: 'moveItem',
      from: INVENTORY,
      fromIndex: 0,
      to: INVENTORY,
      toIndex: 1,
      count: 3,
    });

    expect(player.inventory.slots[0]?.count).toBe(4);
    expect(player.inventory.slots[1]?.count).toBe(3);
  });

  it('merges into a partial stack and returns what did not fit', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    place(sim, player, 0, 'wood_log', 18);
    place(sim, player, 1, 'wood_log', 5);

    sim.run(player, {
      type: 'moveItem',
      from: INVENTORY,
      fromIndex: 1,
      to: INVENTORY,
      toIndex: 0,
      count: null,
    });

    // wood_log stacks to 20: two units merge, three stay put.
    expect(player.inventory.slots[0]?.count).toBe(20);
    expect(player.inventory.slots[1]?.count).toBe(3);
    expect(sim.lastEvent('itemMoved')?.count).toBe(2);
  });

  it('refuses a merge into a stack that is already full', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    place(sim, player, 0, 'wood_log', 20);
    place(sim, player, 1, 'wood_log', 5);

    sim.run(player, {
      type: 'moveItem',
      from: INVENTORY,
      fromIndex: 1,
      to: INVENTORY,
      toIndex: 0,
      count: null,
    });

    expect(rejection(sim)).toMatch(/full/);
    expect(player.inventory.slots[0]?.count).toBe(20);
    expect(player.inventory.slots[1]?.count).toBe(5);
  });

  it('never lets one slot hold more than a full stack', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    // A 25-unit stack cannot exist through normal play, but a save or a future
    // content change could produce one; the move must not launder it into a slot.
    player.inventory.slots[0] = { defId: 'wood_log', count: 25 };

    sim.run(player, {
      type: 'moveItem',
      from: INVENTORY,
      fromIndex: 0,
      to: INVENTORY,
      toIndex: 3,
      count: null,
    });

    expect(player.inventory.slots[3]?.count).toBe(20);
    expect(player.inventory.slots[0]?.count).toBe(5);
  });

  it('swaps two different items when the whole stack moves', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    place(sim, player, 0, 'wood_log', 4);
    place(sim, player, 1, 'stone', 6);

    sim.run(player, {
      type: 'moveItem',
      from: INVENTORY,
      fromIndex: 0,
      to: INVENTORY,
      toIndex: 1,
      count: null,
    });

    expect(player.inventory.slots[0]).toMatchObject({ defId: 'stone', count: 6 });
    expect(player.inventory.slots[1]).toMatchObject({ defId: 'wood_log', count: 4 });
  });

  it('refuses a partial move onto an occupied slot, because the remainder has nowhere to go', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    place(sim, player, 0, 'wood_log', 4);
    place(sim, player, 1, 'stone', 6);

    sim.run(player, {
      type: 'moveItem',
      from: INVENTORY,
      fromIndex: 0,
      to: INVENTORY,
      toIndex: 1,
      count: 2,
    });

    expect(rejection(sim)).toMatch(/occupied/);
    expect(player.inventory.slots[0]?.count).toBe(4);
    expect(player.inventory.slots[1]?.count).toBe(6);
  });

  it('auto-places into a matching partial stack before an empty slot', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    const box = placeBox(sim, player);
    sim.run(player, { type: 'openContainer', structureId: box.id });

    const container = box.container;
    if (!container) throw new Error('no container');
    container.slots[4] = createStack(sim.data, 'nail', 30);
    place(sim, player, 0, 'nail', 12);

    sim.run(player, {
      type: 'moveItem',
      from: INVENTORY,
      fromIndex: 0,
      to: boxRef(box),
      toIndex: null,
      count: null,
    });

    expect(container.slots[4]?.count).toBe(42);
    expect(container.slots[0]).toBeNull();
    expect(player.inventory.slots[0]).toBeNull();
  });

  it('auto-places into the first empty slot when nothing can be merged', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    place(sim, player, 3, 'stone_hatchet');

    sim.run(player, {
      type: 'moveItem',
      from: INVENTORY,
      fromIndex: 3,
      to: INVENTORY,
      toIndex: null,
      count: null,
    });

    expect(player.inventory.slots[0]?.defId).toBe('stone_hatchet');
    expect(player.inventory.slots[3]).toBeNull();
  });

  it('rejects an auto-place into a container with no room, and puts the stack back', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    const box = placeBox(sim, player);
    sim.run(player, { type: 'openContainer', structureId: box.id });
    const container = box.container;
    if (!container) throw new Error('no container');
    for (let i = 0; i < container.slots.length; i++) {
      container.slots[i] = createStack(sim.data, 'stone', 30);
    }
    place(sim, player, 0, 'wood_log', 4);

    sim.run(player, {
      type: 'moveItem',
      from: INVENTORY,
      fromIndex: 0,
      to: boxRef(box),
      toIndex: null,
      count: null,
    });

    expect(rejection(sim)).toMatch(/full/);
    expect(player.inventory.slots[0]?.count).toBe(4);
  });

  it('rejects an invalid source index', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    place(sim, player, 0, 'wood_log', 2);

    sim.run(player, {
      type: 'moveItem',
      from: INVENTORY,
      fromIndex: 999,
      to: INVENTORY,
      toIndex: 1,
      count: null,
    });
    expect(rejection(sim)).toMatch(/source slot/);

    sim.run(player, {
      type: 'moveItem',
      from: INVENTORY,
      fromIndex: -1,
      to: INVENTORY,
      toIndex: 1,
      count: null,
    });
    expect(rejection(sim)).toMatch(/source slot/);
  });

  it('rejects an invalid destination index and an empty source', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    place(sim, player, 0, 'wood_log', 2);

    sim.run(player, {
      type: 'moveItem',
      from: INVENTORY,
      fromIndex: 0,
      to: INVENTORY,
      toIndex: 999,
      count: null,
    });
    expect(rejection(sim)).toMatch(/destination slot/);

    sim.run(player, {
      type: 'moveItem',
      from: INVENTORY,
      fromIndex: 7,
      to: INVENTORY,
      toIndex: 1,
      count: null,
    });
    expect(rejection(sim)).toMatch(/empty/);
  });

  it('rejects a non-positive count', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    place(sim, player, 0, 'wood_log', 5);

    sim.run(player, {
      type: 'moveItem',
      from: INVENTORY,
      fromIndex: 0,
      to: INVENTORY,
      toIndex: 1,
      count: 0,
    });

    expect(rejection(sim)).toMatch(/count/);
    expect(player.inventory.slots[0]?.count).toBe(5);
  });

  it('refuses to treat the ground as a source', () => {
    const sim = makeSim();
    const player = sim.addPlayer();

    sim.run(player, {
      type: 'moveItem',
      from: GROUND,
      fromIndex: 0,
      to: INVENTORY,
      toIndex: 0,
      count: null,
    });

    expect(rejection(sim)).toMatch(/ground is not a source/);
  });

  it('drops onto the ground as a real entity', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    place(sim, player, 0, 'wood_log', 6);

    sim.run(player, {
      type: 'moveItem',
      from: INVENTORY,
      fromIndex: 0,
      to: GROUND,
      toIndex: null,
      count: 2,
    });

    const items = Object.values(sim.sim.state.items);
    expect(items).toHaveLength(1);
    expect(items[0]?.stack).toMatchObject({ defId: 'wood_log', count: 2 });
    expect(items[0]?.droppedBy).toBe(player.id);
    expect(player.inventory.slots[0]?.count).toBe(4);
    expect(sim.lastEvent('itemDropped')?.stack.count).toBe(2);
  });

  it('equips through a move into an equipment slot', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    place(sim, player, 2, 'stone_hatchet');

    sim.run(player, {
      type: 'moveItem',
      from: INVENTORY,
      fromIndex: 2,
      to: { kind: 'equipment', slot: 'mainHand' },
      toIndex: 0,
      count: null,
    });

    expect(player.equipment.mainHand?.defId).toBe('stone_hatchet');
    expect(player.inventory.slots[2]).toBeNull();
  });

  it('refuses to wear an item in a slot its definition does not allow', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    place(sim, player, 0, 'wood_log', 3);

    sim.run(player, {
      type: 'moveItem',
      from: INVENTORY,
      fromIndex: 0,
      to: { kind: 'equipment', slot: 'head' },
      toIndex: 0,
      count: null,
    });

    expect(rejection(sim)).toMatch(/cannot be worn/);
    expect(player.equipment.head).toBeNull();
    expect(player.inventory.slots[0]?.count).toBe(3);
  });

  it('unequips through a move out of an equipment slot', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    sim.equip(player, 'stone_hatchet');

    sim.run(player, {
      type: 'moveItem',
      from: { kind: 'equipment', slot: 'mainHand' },
      fromIndex: 0,
      to: INVENTORY,
      toIndex: 4,
      count: null,
    });

    expect(player.equipment.mainHand).toBeNull();
    expect(player.inventory.slots[4]?.defId).toBe('stone_hatchet');
  });

  it('refuses to reach into a container that is not open', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    const box = placeBox(sim, player);
    place(sim, player, 0, 'wood_log', 3);

    sim.run(player, {
      type: 'moveItem',
      from: INVENTORY,
      fromIndex: 0,
      to: boxRef(box),
      toIndex: 0,
      count: null,
    });

    expect(rejection(sim)).toMatch(/not open/);
    expect(box.container?.slots[0]).toBeNull();
  });

  it('moves both ways once the container is open', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    const box = placeBox(sim, player);
    place(sim, player, 0, 'wood_log', 3);
    sim.run(player, { type: 'openContainer', structureId: box.id });

    sim.run(player, {
      type: 'moveItem',
      from: INVENTORY,
      fromIndex: 0,
      to: boxRef(box),
      toIndex: 2,
      count: null,
    });
    expect(box.container?.slots[2]).toMatchObject({ defId: 'wood_log', count: 3 });
    expect(player.inventory.slots[0]).toBeNull();

    sim.run(player, {
      type: 'moveItem',
      from: boxRef(box),
      fromIndex: 2,
      to: INVENTORY,
      toIndex: 1,
      count: 1,
    });
    expect(box.container?.slots[2]?.count).toBe(2);
    expect(player.inventory.slots[1]?.count).toBe(1);
  });

  it('refuses a container that is out of reach', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    const far = placeBox(sim, player, 'storage_box', 12);
    place(sim, player, 0, 'wood_log', 3);

    sim.run(player, { type: 'openContainer', structureId: far.id });
    expect(rejection(sim)).toMatch(/out of reach/);

    sim.run(player, {
      type: 'moveItem',
      from: INVENTORY,
      fromIndex: 0,
      to: boxRef(far),
      toIndex: 0,
      count: null,
    });
    expect(rejection(sim)).toMatch(/out of reach/);
  });

  it('refuses every item command from a dead player', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    place(sim, player, 0, 'wood_log', 3);
    player.alive = false;

    sim.run(player, {
      type: 'moveItem',
      from: INVENTORY,
      fromIndex: 0,
      to: INVENTORY,
      toIndex: 1,
      count: null,
    });

    expect(rejection(sim)).toMatch(/dead/);
    expect(player.inventory.slots[0]?.count).toBe(3);
  });

  it('treats a drag back onto the same slot as a no-op, not an error', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    place(sim, player, 0, 'wood_log', 3);
    sim.clearEvents();

    sim.run(player, {
      type: 'moveItem',
      from: INVENTORY,
      fromIndex: 0,
      to: INVENTORY,
      toIndex: 0,
      count: null,
    });

    expect(sim.eventsOf('commandRejected')).toHaveLength(0);
    expect(player.inventory.slots[0]?.count).toBe(3);
  });

  it('moves into a worn pack through its itemContainer ref', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    place(sim, player, 0, 'backpack_small');
    sim.run(player, { type: 'equipItem', inventorySlot: 0 });

    const windows = pocketWindows(player, sim.data);
    expect(windows).toHaveLength(1);
    const start = windows[0]?.start ?? -1;
    expect(start).toBe(BASE_INVENTORY_SLOTS);

    place(sim, player, 0, 'stone', 5);
    sim.run(player, {
      type: 'moveItem',
      from: INVENTORY,
      fromIndex: 0,
      to: { kind: 'itemContainer', slotIndex: start },
      toIndex: 0,
      count: null,
    });

    expect(player.inventory.slots[start]).toMatchObject({ defId: 'stone', count: 5 });
    expect(player.inventory.slots[0]).toBeNull();
  });

  it('refuses an itemContainer ref for a pack that is not being worn', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    place(sim, player, 0, 'backpack_small');

    sim.run(player, {
      type: 'moveItem',
      from: INVENTORY,
      fromIndex: 0,
      to: { kind: 'itemContainer', slotIndex: 0 },
      toIndex: 0,
      count: null,
    });

    expect(rejection(sim)).toMatch(/not being worn/);
  });
});

// ---------------------------------------------------------------------------
// splitStack / sortContainer
// ---------------------------------------------------------------------------

describe('splitStack', () => {
  it('splits into the first free slot', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    place(sim, player, 2, 'wood_log', 10);

    sim.run(player, { type: 'splitStack', ref: INVENTORY, index: 2, count: 4 });

    expect(player.inventory.slots[2]?.count).toBe(6);
    expect(player.inventory.slots[0]).toMatchObject({ defId: 'wood_log', count: 4 });
  });

  it('refuses to split off the whole stack, or nothing', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    place(sim, player, 0, 'wood_log', 4);

    sim.run(player, { type: 'splitStack', ref: INVENTORY, index: 0, count: 4 });
    expect(rejection(sim)).toMatch(/whole stack/);

    sim.run(player, { type: 'splitStack', ref: INVENTORY, index: 0, count: 0 });
    expect(rejection(sim)).toMatch(/count/);
    expect(player.inventory.slots[0]?.count).toBe(4);
  });

  it('refuses when there is no free slot to split into, and refuses equipment', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    fillEverySlot(sim, player);

    sim.run(player, { type: 'splitStack', ref: INVENTORY, index: 0, count: 5 });
    expect(rejection(sim)).toMatch(/free slot/);

    sim.equip(player, 'stone_hatchet');
    sim.run(player, {
      type: 'splitStack',
      ref: { kind: 'equipment', slot: 'mainHand' },
      index: 0,
      count: 1,
    });
    expect(rejection(sim)).toMatch(/equipment/);
  });
});

describe('sortContainer', () => {
  it('merges duplicates, compacts, and keeps the hotbar aimed at the same items', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    place(sim, player, 6, 'wood_log', 5);
    place(sim, player, 2, 'stone_hatchet');
    place(sim, player, 9, 'wood_log', 4);
    sim.run(player, { type: 'assignHotbar', hotbarIndex: 0, inventorySlot: 2 });

    sim.run(player, { type: 'sortContainer', ref: INVENTORY });

    expect(player.inventory.slots[0]?.defId).toBe('stone_hatchet');
    expect(player.inventory.slots[1]).toMatchObject({ defId: 'wood_log', count: 9 });
    expect(player.inventory.slots[6]).toBeNull();
    expect(player.inventory.slots[9]).toBeNull();
    // The hatchet moved from slot 2 to slot 0; the hotbar has to follow it.
    expect(player.hotbar[0]).toBe(0);
  });

  it('says so when there was nothing to tidy', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    place(sim, player, 0, 'wood_log', 5);
    sim.clearEvents();

    sim.run(player, { type: 'sortContainer', ref: INVENTORY });

    expect(sim.lastEvent('notification')?.text).toMatch(/tidy/i);
  });

  it('sorts a structure container that is open', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    const box = placeBox(sim, player);
    const container = box.container;
    if (!container) throw new Error('no container');
    container.slots[7] = createStack(sim.data, 'nail', 10);
    container.slots[11] = createStack(sim.data, 'nail', 10);
    sim.run(player, { type: 'openContainer', structureId: box.id });

    sim.run(player, { type: 'sortContainer', ref: boxRef(box) });

    expect(container.slots[0]).toMatchObject({ defId: 'nail', count: 20 });
    expect(container.slots[7]).toBeNull();
    expect(container.slots[11]).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// dropItem / pickUpItem / takeAll
// ---------------------------------------------------------------------------

describe('dropItem and pickUpItem', () => {
  it('drops near the player and picks the stack back up', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    place(sim, player, 0, 'wood_log', 5);

    sim.run(player, { type: 'dropItem', ref: INVENTORY, index: 0, count: 2 });
    const entity = Object.values(sim.sim.state.items)[0];
    if (!entity) throw new Error('nothing dropped');
    expect(Math.hypot(entity.x - player.x, entity.y - player.y)).toBeLessThanOrEqual(PICKUP_REACH);

    sim.run(player, { type: 'pickUpItem', itemEntityId: entity.id });

    expect(sim.sim.state.items[entity.id]).toBeUndefined();
    expect(player.inventory.slots[0]?.count).toBe(5);
    expect(sim.lastEvent('itemPickedUp')?.stack).toMatchObject({ count: 2 });
  });

  it('rejects an invalid slot and a bad count', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    place(sim, player, 0, 'wood_log', 5);

    sim.run(player, { type: 'dropItem', ref: INVENTORY, index: 400, count: null });
    expect(rejection(sim)).toMatch(/invalid slot/);

    sim.run(player, { type: 'dropItem', ref: INVENTORY, index: 1, count: null });
    expect(rejection(sim)).toMatch(/empty/);

    sim.run(player, { type: 'dropItem', ref: INVENTORY, index: 0, count: -3 });
    expect(rejection(sim)).toMatch(/count/);
    expect(Object.keys(sim.sim.state.items)).toHaveLength(0);
  });

  it('refuses a pickup that is out of reach, or of an item that is gone', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    const id = dropStack(
      sim.ctx,
      player.x + CONTAINER_REACH * 4,
      player.y,
      createStack(sim.data, 'wood_log', 1),
      undefined,
      0,
    );
    if (!id) throw new Error('no drop');

    sim.run(player, { type: 'pickUpItem', itemEntityId: id });
    expect(rejection(sim)).toMatch(/out of reach/);

    sim.run(player, { type: 'pickUpItem', itemEntityId: 'i:nope' });
    expect(rejection(sim)).toMatch(/gone/);
  });

  it("protects another player's fresh drop, briefly", () => {
    const sim = makeSim();
    const owner = sim.addPlayer({ id: 'owner' });
    const thief = sim.addPlayer({ id: 'thief' });
    place(sim, owner, 0, 'stone_hatchet');

    sim.run(owner, { type: 'dropItem', ref: INVENTORY, index: 0, count: null });
    const entity = Object.values(sim.sim.state.items)[0];
    if (!entity) throw new Error('nothing dropped');

    sim.run(thief, { type: 'pickUpItem', itemEntityId: entity.id });
    expect(rejection(sim)).toMatch(/not yours yet/);
    expect(sim.sim.state.items[entity.id]).toBeDefined();

    // The dropper is never locked out of their own mistake.
    sim.run(owner, { type: 'pickUpItem', itemEntityId: entity.id });
    expect(owner.inventory.slots.some((slot) => slot?.defId === 'stone_hatchet')).toBe(true);

    // ...and once the window lapses, it is finders-keepers.
    sim.run(owner, { type: 'dropItem', ref: INVENTORY, index: 0, count: null });
    const second = Object.values(sim.sim.state.items)[0];
    if (!second) throw new Error('nothing dropped');
    sim.step(DROP_PROTECTION_TICKS);
    sim.run(thief, { type: 'pickUpItem', itemEntityId: second.id });
    expect(thief.inventory.slots.some((slot) => slot?.defId === 'stone_hatchet')).toBe(true);
  });

  it('refuses a pickup with no room, and leaves the pile alone', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    fillEverySlot(sim, player);
    const id = dropStack(
      sim.ctx,
      player.x,
      player.y,
      createStack(sim.data, 'wood_log', 1),
      undefined,
      0,
    );
    if (!id) throw new Error('no drop');

    sim.run(player, { type: 'pickUpItem', itemEntityId: id });

    expect(rejection(sim)).toMatch(/no room/);
    expect(sim.sim.state.items[id]).toBeDefined();
  });

  it('picks up only what fits and leaves the rest on the floor', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    fillEverySlot(sim, player);
    // One slot with room for 5 more stone; the pile holds 12.
    player.inventory.slots[3] = createStack(sim.data, 'stone', 25);
    const id = dropStack(
      sim.ctx,
      player.x,
      player.y,
      createStack(sim.data, 'stone', 12),
      undefined,
      0,
    );
    if (!id) throw new Error('no drop');

    sim.run(player, { type: 'pickUpItem', itemEntityId: id });

    expect(player.inventory.slots[3]?.count).toBe(30);
    expect(sim.sim.state.items[id]?.stack.count).toBe(7);
  });
});

describe('takeAll', () => {
  it('empties a container into the inventory, rolling its loot first', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    const box = placeBox(sim, player);
    const container = box.container;
    if (!container) throw new Error('no container');
    container.rolled = false;
    container.lootTableId = 'house_kitchen';

    sim.run(player, { type: 'takeAll', structureId: box.id });

    expect(sim.eventsOf('lootRolled')).toHaveLength(1);
    expect(container.slots.every((slot) => slot === null)).toBe(true);
    expect(player.inventory.slots.some((slot) => slot !== null)).toBe(true);
    expect(container.rolled).toBe(true);
  });

  it('warns and leaves the rest when the inventory fills up', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    const box = placeBox(sim, player);
    const container = box.container;
    if (!container) throw new Error('no container');
    container.slots[0] = createStack(sim.data, 'wood_log', 20);
    container.slots[1] = createStack(sim.data, 'stone_hatchet');
    fillEverySlot(sim, player);
    player.inventory.slots[5] = null;

    sim.run(player, { type: 'takeAll', structureId: box.id });

    expect(container.slots[0]).toBeNull();
    expect(container.slots[1]?.defId).toBe('stone_hatchet');
    expect(sim.lastEvent('notification')?.text).toMatch(/filled up/i);
  });

  it('refuses an empty container and one that is out of reach', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    const box = placeBox(sim, player);

    sim.run(player, { type: 'takeAll', structureId: box.id });
    expect(rejection(sim)).toMatch(/empty/);

    const far = placeBox(sim, player, 'storage_box', 14);
    sim.run(player, { type: 'takeAll', structureId: far.id });
    expect(rejection(sim)).toMatch(/out of reach/);
  });
});

// ---------------------------------------------------------------------------
// equipItem / unequipItem
// ---------------------------------------------------------------------------

describe('equipItem and unequipItem', () => {
  it('uses the definition default slot', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    place(sim, player, 0, 'leather_cap');

    sim.run(player, { type: 'equipItem', inventorySlot: 0 });

    expect(player.equipment.head?.defId).toBe('leather_cap');
    expect(player.inventory.slots[0]).toBeNull();
    expect(equipSlotAccepts(sim.data.items.require('leather_cap'), 'head')).toBe(true);
  });

  it('swaps the previous item back into the slot it came from', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    sim.equip(player, 'stone_hatchet');
    place(sim, player, 3, 'stone_knife');

    sim.run(player, { type: 'equipItem', inventorySlot: 3 });

    expect(player.equipment.mainHand?.defId).toBe('stone_knife');
    expect(player.inventory.slots[3]?.defId).toBe('stone_hatchet');
  });

  it('rejects an empty slot, an unknown slot, and an unequippable item', () => {
    const sim = makeSim();
    const player = sim.addPlayer();

    sim.run(player, { type: 'equipItem', inventorySlot: 0 });
    expect(rejection(sim)).toMatch(/empty/);

    sim.run(player, { type: 'equipItem', inventorySlot: 900 });
    expect(rejection(sim)).toMatch(/invalid inventory slot/);

    place(sim, player, 0, 'stone_hatchet');
    sim.run(player, { type: 'equipItem', inventorySlot: 0, slot: 'feet' });
    expect(rejection(sim)).toMatch(/cannot be worn/);
  });

  it('gives a two-handed weapon the off-hand as well', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    player.equipment.offHand = createStack(sim.data, 'wood_log', 2);
    place(sim, player, 0, 'spear');

    sim.run(player, { type: 'equipItem', inventorySlot: 0 });

    expect(player.equipment.mainHand?.defId).toBe('spear');
    expect(player.equipment.offHand).toBeNull();
    // The displaced logs were stowed, not deleted.
    expect(player.inventory.slots.some((slot) => slot?.defId === 'wood_log')).toBe(true);

    place(sim, player, 1, 'stone_knife');
    sim.run(player, { type: 'equipItem', inventorySlot: 1, slot: 'offHand' });
    expect(rejection(sim)).toMatch(/both hands/);
    expect(player.equipment.offHand).toBeNull();
  });

  /**
   * The off-hand ban has to hold from both directions. Refusing to fill the off-hand
   * while a two-hander is wielded is not enough on its own: park the spear in the
   * off-hand first and a knife would slide into the main hand beside it, which is the
   * two-weapon loadout `twoHanded` exists to forbid.
   */
  it('never lets a two-handed weapon occupy the off-hand', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    place(sim, player, 0, 'spear');

    sim.run(player, { type: 'equipItem', inventorySlot: 0, slot: 'offHand' });
    expect(rejection(sim)).toMatch(/cannot be worn there/);
    expect(player.equipment.offHand).toBeNull();
    expect(player.inventory.slots[0]?.defId).toBe('spear');

    // Nor by wielding it properly and then shuffling it across.
    sim.run(player, { type: 'equipItem', inventorySlot: 0 });
    expect(player.equipment.mainHand?.defId).toBe('spear');

    sim.run(player, {
      type: 'moveItem',
      from: { kind: 'equipment', slot: 'mainHand' },
      fromIndex: 0,
      to: { kind: 'equipment', slot: 'offHand' },
      toIndex: 0,
      count: null,
    });
    expect(rejection(sim)).toMatch(/cannot be worn there/);
    expect(player.equipment.mainHand?.defId).toBe('spear');
    expect(player.equipment.offHand).toBeNull();
  });

  it('never lets a swap slide a two-hander into a main hand with a full off-hand', () => {
    // The destination side of a move goes through `equipInto`, which enforces the
    // two-handed rule. The *source* side of a swap writes straight into the slot the
    // source vacated, and its only guard asked `equipSlotAccepts` - which answers about one
    // slot in isolation and cannot see the off-hand. So a swap produced exactly the loadout
    // the test above forbids, by the one route that skipped the check.
    const sim = makeSim();
    const player = sim.addPlayer();
    player.equipment.offHand = createStack(sim.data, 'stone_hatchet');
    player.equipment.mainHand = createStack(sim.data, 'stone_knife');
    place(sim, player, 0, 'spear');

    // Swap the wielded knife with the spear in the pack: the spear would land in the main
    // hand while the hatchet is still in the off-hand.
    sim.run(player, {
      type: 'moveItem',
      from: { kind: 'equipment', slot: 'mainHand' },
      fromIndex: 0,
      to: { kind: 'inventory' },
      toIndex: 0,
      count: null,
    });

    expect(rejection(sim)).toMatch(/off-hand|both hands/);
    expect(player.equipment.mainHand?.defId).toBe('stone_knife');
    expect(player.equipment.offHand?.defId).toBe('stone_hatchet');
    expect(player.inventory.slots[0]?.defId).toBe('spear');
  });

  it('refuses a two-handed swap when there is nowhere to stow the off-hand item', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    player.equipment.offHand = createStack(sim.data, 'stone_hatchet');
    // The spear comes out of a chest, so equipping it frees no inventory slot: the
    // off-hand hatchet has genuinely nowhere to go.
    const box = placeBox(sim, player);
    const container = box.container;
    if (!container) throw new Error('no container');
    container.slots[0] = createStack(sim.data, 'spear');
    sim.run(player, { type: 'openContainer', structureId: box.id });
    fillEverySlot(sim, player);

    sim.run(player, {
      type: 'moveItem',
      from: boxRef(box),
      fromIndex: 0,
      to: { kind: 'equipment', slot: 'mainHand' },
      toIndex: 0,
      count: null,
    });

    expect(rejection(sim)).toMatch(/no room/);
    expect(player.equipment.mainHand).toBeNull();
    expect(player.equipment.offHand?.defId).toBe('stone_hatchet');
    expect(container.slots[0]?.defId).toBe('spear');
  });

  it('resizes the inventory for a backpack and spills what will not fit when it comes off', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    place(sim, player, 0, 'backpack_large');

    sim.run(player, { type: 'equipItem', inventorySlot: 0 });
    expect(player.inventory.capacity).toBe(BASE_INVENTORY_SLOTS + 16);
    expect(player.inventory.slots).toHaveLength(BASE_INVENTORY_SLOTS + 16);

    // Fill every slot, base grid and pockets alike, with something unmergeable.
    for (let i = 0; i < player.inventory.slots.length; i++) {
      player.inventory.slots[i] = createStack(sim.data, 'stone_hatchet');
    }

    sim.run(player, { type: 'unequipItem', slot: 'back' });

    expect(player.inventory.capacity).toBe(BASE_INVENTORY_SLOTS);
    // The pack itself is never the thing that gets thrown away.
    const onGround = Object.values(sim.sim.state.items);
    expect(onGround.length).toBeGreaterThan(0);
    expect(onGround.every((entity) => entity.stack.defId === 'stone_hatchet')).toBe(true);
    expect(player.inventory.slots.some((slot) => slot?.defId === 'backpack_large')).toBe(true);
    expect(sim.lastEvent('notification')?.text).toMatch(/ground/i);
  });

  /**
   * A player state does not always arrive through `equipItem` - it can come back from
   * persistence or be assembled by another system. If the grid did not match the pack
   * on join, `itemContainer` refs would address slots past the end of the array.
   */
  it('repairs a grid that does not match the worn pack, on join', () => {
    const sim = makeSim();
    const pack = createStack(sim.data, 'backpack_small', 1);
    const bonus = sim.data.items.require('backpack_small').containerSlots ?? 0;
    expect(bonus).toBeGreaterThan(0);

    // A pack worn without the resize that normally accompanies it.
    const player = sim.addPlayer({ id: 'restored' });
    player.equipment.back = pack;
    expect(player.inventory.capacity).toBe(BASE_INVENTORY_SLOTS);

    sim.sim.addPlayer(player);

    expect(player.inventory.capacity).toBe(BASE_INVENTORY_SLOTS + bonus);
    expect(player.inventory.slots).toHaveLength(BASE_INVENTORY_SLOTS + bonus);
    expect(pocketWindows(player, sim.data)).toEqual([
      { slot: 'back', defId: 'backpack_small', start: BASE_INVENTORY_SLOTS, length: bonus },
    ]);
    expect(player.carryWeight).toBeCloseTo(sim.data.items.require('backpack_small').weight, 6);
  });

  it('rejects unequipping an empty slot', () => {
    const sim = makeSim();
    const player = sim.addPlayer();

    sim.run(player, { type: 'unequipItem', slot: 'chest' });

    expect(rejection(sim)).toMatch(/nothing equipped/);
  });

  it('keeps carry weight equal to what is actually carried', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    const logWeight = sim.data.items.require('wood_log').weight;
    const hatchetWeight = sim.data.items.require('stone_hatchet').weight;
    place(sim, player, 0, 'wood_log', 4);
    place(sim, player, 1, 'stone_hatchet');

    sim.run(player, { type: 'equipItem', inventorySlot: 1 });
    expect(player.carryWeight).toBeCloseTo(logWeight * 4 + hatchetWeight, 5);

    sim.run(player, { type: 'dropItem', ref: INVENTORY, index: 0, count: 1 });
    expect(player.carryWeight).toBeCloseTo(logWeight * 3 + hatchetWeight, 5);

    sim.run(player, {
      type: 'moveItem',
      from: { kind: 'equipment', slot: 'mainHand' },
      fromIndex: 0,
      to: GROUND,
      toIndex: null,
      count: null,
    });
    expect(player.carryWeight).toBeCloseTo(logWeight * 3, 5);
  });
});

// ---------------------------------------------------------------------------
// Hotbar
// ---------------------------------------------------------------------------

describe('hotbar', () => {
  it('equips the referenced inventory slot into the main hand, swapping the old item back', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    place(sim, player, 4, 'stone_hatchet');
    place(sim, player, 5, 'stone_knife');
    sim.run(player, { type: 'assignHotbar', hotbarIndex: 0, inventorySlot: 4 });
    sim.run(player, { type: 'assignHotbar', hotbarIndex: 1, inventorySlot: 5 });

    sim.run(player, { type: 'selectHotbar', index: 0 });
    expect(player.activeHotbar).toBe(0);
    expect(player.equipment.mainHand?.defId).toBe('stone_hatchet');
    expect(player.inventory.slots[4]).toBeNull();

    sim.run(player, { type: 'selectHotbar', index: 1 });
    expect(player.equipment.mainHand?.defId).toBe('stone_knife');
    // The hatchet went back into the slot the knife vacated.
    expect(player.inventory.slots[5]?.defId).toBe('stone_hatchet');
  });

  it('stows what is held when an empty hotbar entry is selected', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    sim.equip(player, 'stone_hatchet');

    sim.run(player, { type: 'selectHotbar', index: 3 });

    expect(player.equipment.mainHand).toBeNull();
    expect(player.inventory.slots[0]?.defId).toBe('stone_hatchet');
  });

  it('rejects an out-of-range hotbar or inventory index', () => {
    const sim = makeSim();
    const player = sim.addPlayer();

    sim.run(player, { type: 'selectHotbar', index: 99 });
    expect(rejection(sim)).toMatch(/invalid hotbar slot/);

    sim.run(player, { type: 'assignHotbar', hotbarIndex: 99, inventorySlot: 0 });
    expect(rejection(sim)).toMatch(/invalid hotbar slot/);

    sim.run(player, { type: 'assignHotbar', hotbarIndex: 0, inventorySlot: 999 });
    expect(rejection(sim)).toMatch(/invalid inventory slot/);
  });

  it('never lets two hotbar keys fight over one inventory slot', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    place(sim, player, 2, 'stone_hatchet');

    sim.run(player, { type: 'assignHotbar', hotbarIndex: 0, inventorySlot: 2 });
    sim.run(player, { type: 'assignHotbar', hotbarIndex: 1, inventorySlot: 2 });
    expect(player.hotbar[0]).toBeNull();
    expect(player.hotbar[1]).toBe(2);

    sim.run(player, { type: 'assignHotbar', hotbarIndex: 1, inventorySlot: null });
    expect(player.hotbar[1]).toBeNull();
  });

  it('drops dangling hotbar entries when the grid shrinks', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    place(sim, player, 0, 'backpack_small');
    sim.run(player, { type: 'equipItem', inventorySlot: 0 });
    const pocket = BASE_INVENTORY_SLOTS + 2;
    player.inventory.slots[pocket] = createStack(sim.data, 'stone_hatchet');
    sim.run(player, { type: 'assignHotbar', hotbarIndex: 2, inventorySlot: pocket });
    expect(player.hotbar[2]).toBe(pocket);

    sim.run(player, { type: 'unequipItem', slot: 'back' });

    expect(player.inventory.capacity).toBe(BASE_INVENTORY_SLOTS);
    expect(player.hotbar[2]).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// useItem
// ---------------------------------------------------------------------------

describe('useItem', () => {
  it('eats food through the survival rules and clears an emptied slot', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    player.hunger = 60;
    place(sim, player, 0, 'apple', 2);

    sim.run(player, { type: 'useItem', ref: INVENTORY, index: 0 });

    expect(player.hunger).toBeLessThan(60);
    expect(player.inventory.slots[0]?.count).toBe(1);
    expect(sim.lastEvent('ateFood')?.itemDefId).toBe('apple');
    expect(player.useReadyTick).toBeGreaterThan(sim.sim.state.tick);

    // The busy window is enforced, not advisory.
    sim.run(player, { type: 'useItem', ref: INVENTORY, index: 0 });
    expect(rejection(sim)).toMatch(/busy/);

    sim.step(player.useReadyTick - sim.sim.state.tick);
    sim.run(player, { type: 'useItem', ref: INVENTORY, index: 0 });
    expect(player.inventory.slots[0]).toBeNull();
  });

  it('arms the build ghost for a placeable kit instead of consuming it', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    place(sim, player, 0, 'campfire_kit');

    sim.run(player, { type: 'useItem', ref: INVENTORY, index: 0 });

    expect(player.buildDefId).toBe(sim.data.items.require('campfire_kit').placesStructureDefId);
    expect(player.inventory.slots[0]?.defId).toBe('campfire_kit');
  });

  it('points seeds at a plot rather than eating them', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    place(sim, player, 0, 'seed_wheat', 3);

    sim.run(player, { type: 'useItem', ref: INVENTORY, index: 0 });

    expect(sim.lastEvent('notification')?.text).toMatch(/plot/i);
    expect(player.inventory.slots[0]?.count).toBe(3);
  });

  it('rejects an item with no use, an empty slot and a bad index', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    place(sim, player, 0, 'wood_log', 2);
    expect(isConsumable(sim.data.items.require('wood_log'))).toBe(false);

    sim.run(player, { type: 'useItem', ref: INVENTORY, index: 0 });
    expect(rejection(sim)).toMatch(/nothing happens/);

    sim.run(player, { type: 'useItem', ref: INVENTORY, index: 1 });
    expect(rejection(sim)).toMatch(/empty/);

    sim.run(player, { type: 'useItem', ref: INVENTORY, index: 777 });
    expect(rejection(sim)).toMatch(/invalid slot/);

    sim.run(player, { type: 'useItem', ref: GROUND, index: 0 });
    expect(rejection(sim)).toMatch(/nothing to use/);
  });

  it('drinks from a vessel without swallowing the vessel', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    player.thirst = 70;
    const bottle = createStack(sim.data, 'water_bottle');
    player.inventory.slots[0] = bottle;
    const fill = bottle.fill ?? 0;
    expect(fill).toBeGreaterThan(0);

    sim.run(player, { type: 'useItem', ref: INVENTORY, index: 0 });

    expect(player.thirst).toBeLessThan(70);
    expect(player.inventory.slots[0]?.defId).toBe('water_bottle');
    expect(player.inventory.slots[0]?.fill).toBe(fill - 1);
  });
});

// ---------------------------------------------------------------------------
// Containers
// ---------------------------------------------------------------------------

describe('openContainer', () => {
  it('rolls the loot table the first time and never again', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    const box = placeBox(sim, player);
    const container = box.container;
    if (!container) throw new Error('no container');
    container.rolled = false;
    container.lootTableId = 'house_kitchen';

    sim.run(player, { type: 'openContainer', structureId: box.id });
    const rolled = sim.eventsOf('lootRolled');
    expect(rolled).toHaveLength(1);
    expect(container.rolled).toBe(true);
    const contents = JSON.stringify(container.slots);
    expect(container.slots.some((slot) => slot !== null)).toBe(true);
    expect(container.viewers).toContain(player.id);
    expect(player.openContainerId).toBe(box.id);
    expect(sim.lastEvent('containerOpened')?.structureId).toBe(box.id);

    sim.run(player, { type: 'closeContainer' });
    expect(container.viewers).not.toContain(player.id);
    expect(player.openContainerId).toBeUndefined();
    expect(sim.lastEvent('containerClosed')?.structureId).toBe(box.id);

    sim.run(player, { type: 'openContainer', structureId: box.id });
    expect(sim.eventsOf('lootRolled')).toHaveLength(1);
    expect(JSON.stringify(container.slots)).toBe(contents);
  });

  it('closes itself when the player walks away', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    const box = placeBox(sim, player);
    sim.run(player, { type: 'openContainer', structureId: box.id });
    expect(player.openContainerId).toBe(box.id);

    player.x += CONTAINER_REACH * 3;
    sim.step(1);

    expect(player.openContainerId).toBeUndefined();
    expect(box.container?.viewers).toHaveLength(0);
    expect(sim.lastEvent('containerClosed')?.playerId).toBe(player.id);
  });

  it('closes itself when the player dies or the container is destroyed', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    const box = placeBox(sim, player);
    sim.run(player, { type: 'openContainer', structureId: box.id });

    player.alive = false;
    sim.step(1);
    expect(player.openContainerId).toBeUndefined();

    player.alive = true;
    sim.run(player, { type: 'openContainer', structureId: box.id });
    expect(player.openContainerId).toBe(box.id);
    delete sim.sim.state.structures[box.id];
    sim.step(1);
    expect(player.openContainerId).toBeUndefined();
  });

  it("takes the dead pack's pockets away with it", () => {
    // Capacity is derived from what is worn, and death strips equipment directly rather
    // than through a command. Nothing resynced afterwards, so the player kept the dead
    // pack's slots - usable, granted by nothing - through death and through respawn.
    const sim = makeSim();
    const player = sim.addPlayer();
    const base = player.inventory.capacity;

    const pack = sim.data.items
      .all()
      .find((def) => (def.containerSlots ?? 0) > 0 && def.armor?.slot === 'back');
    if (!pack) return; // no wearable pack in this data set
    sim.giveItem(player, pack.id, 1);
    const slot = player.inventory.slots.findIndex((entry) => entry?.defId === pack.id);
    sim.run(player, { type: 'equipItem', inventorySlot: slot });
    expect(player.inventory.capacity).toBeGreaterThan(base);

    // Killed through the pipeline, so the real strip-and-drop path runs.
    killPlayer(sim.ctx, player, 'blunt');
    sim.step(2);

    expect(player.equipment.back ?? null).toBeNull();
    expect(player.inventory.capacity).toBe(base);
    expect(player.inventory.slots).toHaveLength(base);
  });

  it('keeps a locked chest shut against every slot command, not just openContainer', () => {
    // The lock used to be checked only when opening. That was no lock at all: a window
    // already open stays open (nothing closes it when the owner fits a lock), and a
    // `{kind:'structure'}` ref does not need an open window anyway. `takeAll` answered
    // "it is locked" while `moveItem` emptied the same chest in the same tick.
    const sim = makeSim();
    const thief = sim.addPlayer();
    const box = placeBox(sim, thief);
    box.container!.slots[0] = createStack(sim.data, 'wood_log', 5);

    // Opened while it was still unlocked, the way a thief would.
    sim.run(thief, { type: 'openContainer', structureId: box.id });
    expect(thief.openContainerId).toBe(box.id);

    // The owner fits a lock.
    box.ownerId = 'someone_else';
    box.door = { open: false, locked: true, code: '1234' };
    sim.step(1);

    sim.clearEvents();
    sim.run(thief, {
      type: 'moveItem',
      from: { kind: 'structure', structureId: box.id },
      fromIndex: 0,
      to: { kind: 'inventory' },
      toIndex: null,
      count: null,
    });
    expect(rejection(sim)).toMatch(/locked/);
    expect(box.container!.slots[0]?.count).toBe(5);

    sim.clearEvents();
    sim.run(thief, {
      type: 'dropItem',
      ref: { kind: 'structure', structureId: box.id },
      index: 0,
      count: null,
    });
    expect(rejection(sim)).toMatch(/locked/);
    expect(box.container!.slots[0]?.count).toBe(5);

    // ...and the owner is not locked out of their own chest.
    box.ownerId = thief.id;
    sim.clearEvents();
    sim.run(thief, {
      type: 'moveItem',
      from: { kind: 'structure', structureId: box.id },
      fromIndex: 0,
      to: { kind: 'inventory' },
      toIndex: null,
      count: null,
    });
    expect(box.container!.slots[0]).toBeNull();
  });

  it('refuses an unknown structure, one with no container, and a locked one', () => {
    const sim = makeSim();
    const player = sim.addPlayer();

    sim.run(player, { type: 'openContainer', structureId: 's:nope' });
    expect(rejection(sim)).toMatch(/no such structure/);

    const wall = sim.placeStructure(
      'wall_wood',
      pixelToTile(player.x) + 1,
      pixelToTile(player.y) + 1,
      0,
      player.id,
    );
    if (!wall) throw new Error('no wall');
    sim.run(player, { type: 'openContainer', structureId: wall.id });
    expect(rejection(sim)).toMatch(/no container/);

    const box = placeBox(sim, player);
    box.ownerId = 'someone_else';
    box.door = { open: false, locked: true, code: 'hunter2' };
    sim.run(player, { type: 'openContainer', structureId: box.id });
    expect(rejection(sim)).toMatch(/locked/);
  });

  /**
   * Reach alone is not enough: a chest one tile beyond a wall is well inside
   * CONTAINER_REACH, and without the sight test a client could loot through masonry.
   * The wall is then removed to prove it was the wall doing the refusing and not the
   * distance.
   */
  it('refuses a container that is in reach but behind a wall', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    const tileX = pixelToTile(player.x);
    const tileY = pixelToTile(player.y);
    player.x = tileCenter(tileX);
    player.y = tileCenter(tileY);

    const box = placeBox(sim, player, 'storage_box', 2);
    sim.giveItem(player, 'wood_log', 1);
    sim.wall(tileX + 1, tileY, tileX + 1, tileY);

    sim.run(player, { type: 'openContainer', structureId: box.id });
    expect(rejection(sim)).toMatch(/line of sight/);
    expect(player.openContainerId).toBeUndefined();

    // The same gate protects every ref-resolving command, not just the open.
    sim.run(player, {
      type: 'moveItem',
      from: INVENTORY,
      fromIndex: 0,
      to: boxRef(box),
      toIndex: 0,
      count: null,
    });
    expect(rejection(sim)).toMatch(/line of sight/);
    expect(box.container?.slots[0] ?? null).toBeNull();

    sim.flatten(player.x, player.y, 4);
    sim.run(player, { type: 'openContainer', structureId: box.id });
    expect(player.openContainerId).toBe(box.id);
  });

  it('only lets one container be open at a time', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    const first = placeBox(sim, player, 'storage_box', 1);
    const second = placeBox(sim, player, 'storage_box', -1);

    sim.run(player, { type: 'openContainer', structureId: first.id });
    sim.run(player, { type: 'openContainer', structureId: second.id });

    expect(player.openContainerId).toBe(second.id);
    expect(first.container?.viewers).toHaveLength(0);
    expect(second.container?.viewers).toEqual([player.id]);
  });

  it('rolls the same loot for the same seed, and different loot for a different one', () => {
    const roll = (seed: number): string => {
      const sim = makeSim({ seed });
      const player = sim.addPlayer();
      const box = placeBox(sim, player);
      const container = box.container;
      if (!container) throw new Error('no container');
      container.rolled = false;
      container.lootTableId = 'house_kitchen';
      sim.run(player, { type: 'openContainer', structureId: box.id });
      return JSON.stringify(container.slots);
    };

    expect(roll(4242)).toBe(roll(4242));
    expect(roll(4242)).not.toBe(roll(9999));
  });

  it('scales loot with the abundance world setting', () => {
    const contents = (abundance: number): ItemStack[] => {
      const sim = makeSim({
        seed: 777,
        config: (config) => {
          config.world.lootAbundance = abundance;
        },
      });
      const player = sim.addPlayer();
      const box = placeBox(sim, player);
      const container = box.container;
      if (!container) throw new Error('no container');
      container.rolled = false;
      container.lootTableId = 'house_kitchen';
      sim.run(player, { type: 'openContainer', structureId: box.id });
      return container.slots.filter((slot): slot is ItemStack => slot !== null);
    };

    expect(contents(2).length).toBeGreaterThan(contents(0.2).length);
  });
});

describe('setLock', () => {
  it('locks and unlocks a container the player owns', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    const box = placeBox(sim, player);

    sim.run(player, { type: 'setLock', structureId: box.id, code: '1234' });
    expect(box.door?.locked).toBe(true);
    expect(box.door?.code).toBe('1234');

    sim.run(player, { type: 'setLock', structureId: box.id, code: null });
    expect(box.door?.locked).toBe(false);
    expect(box.door?.code).toBeUndefined();
  });

  it('refuses a structure the player does not own, an unlockable one, and a silly code', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    const box = placeBox(sim, player);
    box.ownerId = 'someone_else';
    sim.run(player, { type: 'setLock', structureId: box.id, code: '1' });
    expect(rejection(sim)).toMatch(/do not own/);

    const fence = sim.placeStructure(
      'fence_wood',
      pixelToTile(player.x),
      pixelToTile(player.y) + 1,
      0,
      player.id,
    );
    if (!fence) throw new Error('no fence');
    sim.run(player, { type: 'setLock', structureId: fence.id, code: '1' });
    expect(rejection(sim)).toMatch(/nowhere to fit a lock/);

    const own = placeBox(sim, player, 'storage_box', -2);
    sim.run(player, { type: 'setLock', structureId: own.id, code: '' });
    expect(rejection(sim)).toMatch(/invalid code/);
    expect(own.door?.locked).toBeUndefined();
  });

  it('locks a lockable door', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    const tileX = pixelToTile(player.x) + 1;
    const tileY = pixelToTile(player.y);
    const door = sim.placeStructure('door_metal', tileX, tileY, 0, player.id);
    if (!door) throw new Error('no door');
    // Stand right at it: a door blocks sight, so the reach test needs the near tile.
    player.x = tileCenter(tileX - 1);
    player.y = tileCenter(tileY);

    sim.run(player, { type: 'setLock', structureId: door.id, code: 'abc' });

    expect(door.door?.locked).toBe(true);
    expect(sim.lastEvent('notification')?.text).toMatch(/locked/i);
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe('determinism', () => {
  it('produces byte-identical state for the same seed and the same commands', () => {
    const script = (seed: number): string => {
      const sim = makeSim({ seed });
      const player = sim.addPlayer();
      const box = placeBox(sim, player);
      const container = box.container;
      if (!container) throw new Error('no container');
      container.rolled = false;
      container.lootTableId = 'shed';

      sim.run(player, { type: 'openContainer', structureId: box.id });
      sim.run(player, { type: 'takeAll', structureId: box.id });
      sim.run(player, { type: 'sortContainer', ref: INVENTORY });
      sim.run(player, { type: 'dropItem', ref: INVENTORY, index: 0, count: 1 });
      sim.step(SIM_HZ);
      return JSON.stringify({
        inventory: player.inventory,
        equipment: player.equipment,
        items: Object.keys(sim.sim.state.items)
          .sort()
          .map((id) => sim.sim.state.items[id]),
      });
    };

    expect(script(31337)).toBe(script(31337));
  });
});
