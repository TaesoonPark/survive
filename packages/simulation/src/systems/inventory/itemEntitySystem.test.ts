import { describe, expect, it } from 'vitest';
import { SIM_HZ, Tile, pixelToTile, type ItemStack, type PlayerState } from '@survive/protocol';
import { ITEM_DEFS, createGameData, type GameData, type ItemSource } from '@survive/game-data';
import { createTestSimulation, type TestSimulation } from '@survive/test-utils';
import { createStack } from '../../core/items';
import { dropStack } from '../../core/loot';
import { createInventorySystem } from './inventorySystem';
import {
  COLD_AIR_COOLNESS,
  GROUND_SWEEP_TICKS,
  MERGE_RADIUS,
  SEALED_COOLNESS,
  SPOIL_CYCLE_TICKS,
  createItemEntitySystem,
  freshnessLossPerCycle,
  spoilRateMultiplier,
  storageCoolness,
} from './itemEntitySystem';

/**
 * Ground items and rot.
 *
 * Two things are being pinned down here. First, that food actually goes off wherever it
 * is kept - the whole point of the mechanic is that a chest full of meat is a clock,
 * not a solution. Second, that the staggering which makes that affordable does not
 * change the answer: a stack aged over a hundred ticks must have lost exactly the
 * freshness the model says it should, whichever phase it happens to sit on.
 *
 * Freshness is usually pre-set close to zero rather than waited out: raw meat takes a
 * day and a half of game time to rot, and a test that stepped 43,200 ticks to watch it
 * would be measuring the harness, not the rule.
 */

const SYSTEMS = () => [createInventorySystem(), createItemEntitySystem()];

function makeSim(patch?: Parameters<typeof createTestSimulation>[0]): TestSimulation {
  return createTestSimulation({ systems: SYSTEMS(), ...patch });
}

/**
 * The shipped tables have no perishable that leaves anything behind, so the
 * `spoiledDefId` path gets content of its own: meat rots into compost, and compost is
 * given a small stack size so the overflow branch is exercised too.
 */
function meatRotsToCompost(): GameData {
  const items: ItemSource[] = ITEM_DEFS.map((def) => {
    if (def.id === 'raw_meat' && def.perishable) {
      return { ...def, perishable: { ...def.perishable, spoiledDefId: 'compost' } };
    }
    if (def.id === 'compost') return { ...def, stackSize: 4 };
    return def;
  });
  return createGameData({ items });
}

function groundStacks(sim: TestSimulation): ItemStack[] {
  return Object.keys(sim.sim.state.items)
    .sort()
    .map((id) => sim.sim.state.items[id]?.stack)
    .filter((stack): stack is ItemStack => stack !== undefined);
}

function totalOf(stacks: readonly (ItemStack | null)[], defId: string): number {
  let total = 0;
  for (const stack of stacks) {
    if (stack?.defId === defId) total += stack.count;
  }
  return total;
}

function boxNextTo(sim: TestSimulation, player: PlayerState) {
  const structure = sim.placeStructure(
    'storage_box',
    pixelToTile(player.x) + 1,
    pixelToTile(player.y),
    0,
    player.id,
  );
  if (!structure?.container) throw new Error('no container');
  return { structure, container: structure.container };
}

// ---------------------------------------------------------------------------
// Despawning
// ---------------------------------------------------------------------------

describe('ground item despawn', () => {
  it('reaps a pile once its despawn tick passes', () => {
    const sim = makeSim({
      config: (config) => {
        config.tuning.itemDespawnTicks = 100;
      },
    });
    const player = sim.addPlayer();
    // A world starts at WORLD_START_TICK, not at zero, so every deadline here is
    // relative to the tick the drop actually happened on.
    const droppedAt = sim.sim.state.tick;
    const id = dropStack(sim.ctx, player.x, player.y, createStack(sim.data, 'wood_log', 1));
    if (!id) throw new Error('no drop');
    expect(sim.sim.state.items[id]?.despawnTick).toBe(droppedAt + 100);

    sim.step(90);
    expect(sim.sim.state.items[id]).toBeDefined();

    // The next sweep lands on the tick the pile's time is up.
    sim.step(GROUND_SWEEP_TICKS);
    expect(sim.sim.state.items[id]).toBeUndefined();
    // Removal is announced to the snapshot builder, not just deleted.
    expect(sim.sim.state.destroyed).toContain(id);
  });

  it('never reaps anything when the knob is off', () => {
    const sim = makeSim({
      config: (config) => {
        config.tuning.itemDespawnTicks = -1;
      },
    });
    const player = sim.addPlayer();
    const id = dropStack(sim.ctx, player.x, player.y, createStack(sim.data, 'wood_log', 1));
    if (!id) throw new Error('no drop');
    expect(sim.sim.state.items[id]?.despawnTick).toBe(-1);

    sim.step(SIM_HZ * 30);

    expect(sim.sim.state.items[id]).toBeDefined();
  });

  it('leaves an already-immortal pile alone after the knob is turned back on', () => {
    const sim = makeSim({
      config: (config) => {
        config.tuning.itemDespawnTicks = 40;
      },
    });
    const player = sim.addPlayer();
    const id = dropStack(sim.ctx, player.x, player.y, createStack(sim.data, 'wood_log', 1));
    if (!id) throw new Error('no drop');
    const entity = sim.sim.state.items[id];
    if (!entity) throw new Error('no entity');
    entity.despawnTick = -1;

    sim.step(200);

    expect(sim.sim.state.items[id]).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Merging
// ---------------------------------------------------------------------------

describe('ground pile merging', () => {
  it('folds two piles on the same spot into one entity', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    dropStack(sim.ctx, player.x, player.y, createStack(sim.data, 'wood_log', 5), undefined, 0);
    dropStack(sim.ctx, player.x, player.y, createStack(sim.data, 'wood_log', 4), undefined, 0);
    expect(Object.keys(sim.sim.state.items)).toHaveLength(2);

    sim.step(GROUND_SWEEP_TICKS);

    const stacks = groundStacks(sim);
    expect(stacks).toHaveLength(1);
    expect(stacks[0]).toMatchObject({ defId: 'wood_log', count: 9 });
  });

  it('leaves piles that are far apart, or of different items, alone', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    dropStack(sim.ctx, player.x, player.y, createStack(sim.data, 'wood_log', 5), undefined, 0);
    dropStack(
      sim.ctx,
      player.x + MERGE_RADIUS * 8,
      player.y,
      createStack(sim.data, 'wood_log', 5),
      undefined,
      0,
    );
    dropStack(sim.ctx, player.x, player.y, createStack(sim.data, 'stone', 5), undefined, 0);

    sim.step(GROUND_SWEEP_TICKS * 2);

    expect(Object.keys(sim.sim.state.items)).toHaveLength(3);
  });

  it('never merges a stack that would exceed a full stack', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    dropStack(sim.ctx, player.x, player.y, createStack(sim.data, 'wood_log', 18), undefined, 0);
    dropStack(sim.ctx, player.x, player.y, createStack(sim.data, 'wood_log', 6), undefined, 0);

    sim.step(GROUND_SWEEP_TICKS);

    const stacks = groundStacks(sim);
    expect(stacks).toHaveLength(2);
    expect(totalOf(stacks, 'wood_log')).toBe(24);
    expect(stacks.some((stack) => stack.count === 20)).toBe(true);
    expect(stacks.some((stack) => stack.count === 4)).toBe(true);
  });

  it("will not launder another player's protected drop into a shared pile", () => {
    const sim = makeSim();
    const owner = sim.addPlayer({ id: 'owner' });
    const other = sim.addPlayer({ id: 'other' });
    dropStack(sim.ctx, owner.x, owner.y, createStack(sim.data, 'wood_log', 3), owner.id, 0);
    dropStack(sim.ctx, owner.x, owner.y, createStack(sim.data, 'wood_log', 3), other.id, 0);

    sim.step(GROUND_SWEEP_TICKS);
    expect(Object.keys(sim.sim.state.items)).toHaveLength(2);

    // Once both windows lapse there is nothing left to protect.
    sim.step(SIM_HZ * 5);
    expect(groundStacks(sim)).toHaveLength(1);
  });

  it('merges one player’s own drops immediately', () => {
    const sim = makeSim();
    const owner = sim.addPlayer({ id: 'owner' });
    dropStack(sim.ctx, owner.x, owner.y, createStack(sim.data, 'nail', 10), owner.id, 0);
    dropStack(sim.ctx, owner.x, owner.y, createStack(sim.data, 'nail', 10), owner.id, 0);

    sim.step(GROUND_SWEEP_TICKS);

    const stacks = groundStacks(sim);
    expect(stacks).toHaveLength(1);
    expect(stacks[0]?.count).toBe(20);
  });

  it('gives the merged pile the longer of the two lifetimes', () => {
    const sim = makeSim({
      config: (config) => {
        config.tuning.itemDespawnTicks = 400;
      },
    });
    const player = sim.addPlayer();
    const droppedAt = sim.sim.state.tick;
    const first = dropStack(
      sim.ctx,
      player.x,
      player.y,
      createStack(sim.data, 'nail', 5),
      undefined,
      0,
    );
    if (!first) throw new Error('no drop');
    const firstDeadline = sim.sim.state.items[first]?.despawnTick;
    expect(firstDeadline).toBe(droppedAt + 400);

    sim.step(GROUND_SWEEP_TICKS * 3);
    dropStack(sim.ctx, player.x, player.y, createStack(sim.data, 'nail', 5), undefined, 0);
    sim.step(GROUND_SWEEP_TICKS);

    const survivors = Object.values(sim.sim.state.items);
    expect(survivors).toHaveLength(1);
    // The younger pile's deadline wins, so the merge cannot shorten anyone's life.
    expect(survivors[0]?.despawnTick).toBe(droppedAt + GROUND_SWEEP_TICKS * 3 + 400);
    expect(survivors[0]?.despawnTick).toBeGreaterThan(firstDeadline ?? 0);
  });
});

// ---------------------------------------------------------------------------
// Spoilage
// ---------------------------------------------------------------------------

describe('perishable decay', () => {
  it('ages food on the ground at the documented rate', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    const id = dropStack(sim.ctx, player.x, player.y, createStack(sim.data, 'apple', 2));
    if (!id) throw new Error('no drop');
    const perishable = sim.data.items.require('apple').perishable;
    if (!perishable) throw new Error('apples should perish');

    const cycles = 10;
    sim.step(SPOIL_CYCLE_TICKS * cycles);

    const freshness = sim.sim.state.items[id]?.stack.freshness ?? 1;
    expect(freshness).toBeCloseTo(1 - cycles * freshnessLossPerCycle(perishable, 0), 8);
    expect(freshness).toBeLessThan(1);
  });

  it('ages food in a chest more slowly than food on the floor', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    const { container } = boxNextTo(sim, player);
    container.slots[0] = createStack(sim.data, 'apple', 2);
    const onFloor = dropStack(sim.ctx, player.x, player.y, createStack(sim.data, 'apple', 2));
    if (!onFloor) throw new Error('no drop');

    sim.step(SPOIL_CYCLE_TICKS * 10);

    const stored = container.slots[0]?.freshness ?? 0;
    const exposed = sim.sim.state.items[onFloor]?.stack.freshness ?? 0;
    expect(stored).toBeGreaterThan(exposed);
    expect(stored).toBeLessThan(1);
  });

  it('keeps food longest in a cold, sheltered place', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    const { structure, container } = boxNextTo(sim, player);
    sim.world.setTile(structure.tileX, structure.tileY, Tile.FloorWood);
    sim.sim.state.weather.temperature = -4;
    container.slots[0] = createStack(sim.data, 'apple', 1);

    const perishable = sim.data.items.require('apple').perishable;
    if (!perishable) throw new Error('apples should perish');
    const coolness = storageCoolness(
      sim.ctx,
      structure.tileX * 32 + 16,
      structure.tileY * 32 + 16,
      true,
    );
    expect(coolness).toBe(1);
    expect(spoilRateMultiplier(perishable, coolness)).toBeCloseTo(
      perishable.refrigeratedMultiplier,
      8,
    );

    sim.step(SPOIL_CYCLE_TICKS * 10);

    expect(container.slots[0]?.freshness).toBeCloseTo(
      1 - 10 * freshnessLossPerCycle(perishable, 1),
      8,
    );
  });

  it('counts cold air even out in the open', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    sim.sim.state.weather.temperature = 2;

    expect(storageCoolness(sim.ctx, player.x, player.y, false)).toBeCloseTo(COLD_AIR_COOLNESS, 8);
    expect(storageCoolness(sim.ctx, player.x, player.y, true)).toBeCloseTo(
      COLD_AIR_COOLNESS + SEALED_COOLNESS,
      8,
    );
  });

  it('destroys food that rots with nothing to leave behind', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    const stack = createStack(sim.data, 'apple', 3);
    stack.freshness = 0.0001;
    const id = dropStack(sim.ctx, player.x, player.y, stack);
    if (!id) throw new Error('no drop');

    sim.step(SPOIL_CYCLE_TICKS);

    expect(sim.sim.state.items[id]).toBeUndefined();
    expect(sim.lastEvent('itemSpoiled')).toMatchObject({ entityId: id, defId: 'apple' });
  });

  it('turns a rotten stack into its spoiled item on the ground', () => {
    const sim = makeSim({ data: meatRotsToCompost() });
    const player = sim.addPlayer();
    const stack = createStack(sim.data, 'raw_meat', 3);
    stack.freshness = 0.0001;
    const id = dropStack(sim.ctx, player.x, player.y, stack);
    if (!id) throw new Error('no drop');

    sim.step(SPOIL_CYCLE_TICKS);

    // A ground pile is one entity holding one stack, so the whole count survives the
    // change of identity; splitting into slot-sized stacks happens on pickup.
    expect(sim.sim.state.items[id]?.stack).toMatchObject({ defId: 'compost', count: 3 });
    expect(sim.lastEvent('itemSpoiled')?.defId).toBe('raw_meat');
  });

  it('rots food inside a chest and reports the chest as the owner', () => {
    const sim = makeSim({ data: meatRotsToCompost() });
    const player = sim.addPlayer();
    const { structure, container } = boxNextTo(sim, player);
    const stack = createStack(sim.data, 'raw_meat', 2);
    stack.freshness = 0.0001;
    container.slots[3] = stack;
    const revBefore = structure.rev;

    sim.step(SPOIL_CYCLE_TICKS);

    expect(container.slots[3]).toMatchObject({ defId: 'compost', count: 2 });
    expect(structure.rev).toBeGreaterThan(revBefore);
    expect(sim.lastEvent('itemSpoiled')).toMatchObject({
      entityId: structure.id,
      defId: 'raw_meat',
    });
  });

  it('spreads rot that will not fit in one slot across the container', () => {
    const sim = makeSim({ data: meatRotsToCompost() });
    const player = sim.addPlayer();
    const { container } = boxNextTo(sim, player);
    // Ten meat rotting into a four-per-slot item needs three slots.
    const stack = createStack(sim.data, 'raw_meat', 10);
    stack.freshness = 0.0001;
    container.slots[0] = stack;

    sim.step(SPOIL_CYCLE_TICKS);

    expect(totalOf(container.slots, 'compost')).toBe(10);
    expect(container.slots.filter((slot) => slot?.defId === 'compost')).toHaveLength(3);
  });

  it('rots food in a carried pack and in the hand, and keeps carry weight honest', () => {
    const sim = makeSim({ data: meatRotsToCompost() });
    const player = sim.addPlayer();
    const carried = createStack(sim.data, 'raw_meat', 2);
    carried.freshness = 0.0001;
    player.inventory.slots[5] = carried;
    const held = createStack(sim.data, 'raw_meat', 1);
    held.freshness = 0.0001;
    player.equipment.mainHand = held;

    sim.step(SPOIL_CYCLE_TICKS);

    expect(player.inventory.slots[5]?.defId).toBe('compost');
    expect(player.equipment.mainHand?.defId).toBe('compost');
    const compostWeight = sim.data.items.require('compost').weight;
    expect(player.carryWeight).toBeCloseTo(compostWeight * 3, 6);
    expect(sim.eventsOf('itemSpoiled').every((event) => event.entityId === player.id)).toBe(true);
  });

  it('leaves things that do not perish exactly as they are', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    const id = dropStack(sim.ctx, player.x, player.y, createStack(sim.data, 'iron_ingot', 4));
    if (!id) throw new Error('no drop');
    const before = sim.sim.state.items[id]?.rev ?? 0;
    player.inventory.slots[0] = createStack(sim.data, 'stone_hatchet');
    const playerRev = player.rev;

    sim.step(SPOIL_CYCLE_TICKS * 5);

    const entity = sim.sim.state.items[id];
    expect(entity?.stack.freshness).toBeUndefined();
    expect(entity?.rev).toBe(before);
    expect(player.rev).toBe(playerRev);
    expect(sim.eventsOf('itemSpoiled')).toHaveLength(0);
  });

  it('staggers the work instead of walking everything every tick', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    const ids: string[] = [];
    for (let i = 0; i < 40; i++) {
      // Spread across tiles so the merge sweep leaves them as separate entities.
      const id = dropStack(
        sim.ctx,
        player.x + i * 64,
        player.y,
        createStack(sim.data, 'apple', 1),
        undefined,
        0,
      );
      if (id) ids.push(id);
    }
    expect(ids).toHaveLength(40);
    const aged = () =>
      ids.filter((id) => (sim.sim.state.items[id]?.stack.freshness ?? 1) < 1).length;

    sim.step(1);
    const afterOneTick = aged();
    expect(afterOneTick).toBeGreaterThan(0);
    expect(afterOneTick).toBeLessThan(40);

    sim.step(SPOIL_CYCLE_TICKS - 1);
    expect(aged()).toBe(40);
  });

  it('charges every stack the same total decay whatever phase it sits on', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) {
      const id = dropStack(
        sim.ctx,
        player.x + i * 64,
        player.y,
        createStack(sim.data, 'apple', 1),
        undefined,
        0,
      );
      if (id) ids.push(id);
    }

    sim.step(SPOIL_CYCLE_TICKS * 4);

    const values = new Set(
      ids.map((id) => (sim.sim.state.items[id]?.stack.freshness ?? 1).toFixed(10)),
    );
    expect(values.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe('determinism', () => {
  it('produces identical ground state from identical inputs', () => {
    const script = (seed: number): string => {
      const sim = makeSim({ seed, data: meatRotsToCompost() });
      const player = sim.addPlayer();
      for (let i = 0; i < 6; i++) {
        const stack = createStack(sim.data, 'raw_meat', 3);
        stack.freshness = i === 0 ? 0.0001 : 1;
        dropStack(sim.ctx, player.x + i * 8, player.y, stack, undefined, 4);
      }
      sim.step(SIM_HZ * 3);
      return JSON.stringify(
        Object.keys(sim.sim.state.items)
          .sort()
          .map((id) => sim.sim.state.items[id]),
      );
    };

    expect(script(2468)).toBe(script(2468));
  });
});
