import { describe, expect, it } from 'vitest';
import {
  pixelToTile,
  type ItemStack,
  type PlayerState,
  type StructureState,
} from '@survive/protocol';
import { RECIPE_DEFS, createGameData, type GameData, type RecipeDef } from '@survive/game-data';
import { createTestSimulation, type TestSimulation } from '@survive/test-utils';
import { recomputeCarryWeight } from '../../core/items';
import { destroyStructure } from '../building/building';
import { canCraft, createCraftingSystem, craftTicksPerUnit, MAX_QUEUED_JOBS } from './crafting';
import { STATION_ACTION_TICKS, STATION_REACH } from './stations';

/**
 * Crafting behaviour, driven through commands exactly as a client would.
 *
 * Recipe ids and numbers come from the real content tables where a real recipe
 * exercises the rule (`craft_rope`, `cook_meat`, `smelt_iron_ingot`), and from four
 * synthetic recipes where the shipped tables have no example of the shape being
 * tested - tag-matched inputs, chance-gated outputs, a hand recipe with a skill gate.
 */

const TEST_RECIPES: RecipeDef[] = [
  {
    // Tag-matched input: any 2 units of anything tagged `wood`, preferring logs.
    id: 'test_wood_bundle',
    name: 'Wood Bundle',
    category: 'basic',
    inputs: [{ defId: 'wood_log', count: 2, tag: 'wood' }],
    tools: [],
    outputs: [{ defId: 'charcoal', count: 1 }],
    craftTicks: 40,
    xp: { skill: 'crafting', amount: 2 },
    unlockedByDefault: true,
  },
  {
    // Hand recipe with a skill gate: the shipped hand recipes have none.
    id: 'test_master_knot',
    name: 'Master Knot',
    category: 'basic',
    inputs: [{ defId: 'plant_fiber', count: 1 }],
    tools: [],
    outputs: [{ defId: 'rope', count: 1 }],
    craftTicks: 20,
    requiredSkill: { id: 'crafting', level: 3 },
    xp: { skill: 'crafting', amount: 2 },
    unlockedByDefault: true,
  },
  {
    // Chance-gated bonus output.
    id: 'test_lucky_scrape',
    name: 'Lucky Scrape',
    category: 'basic',
    inputs: [{ defId: 'plant_fiber', count: 1 }],
    tools: [],
    outputs: [
      { defId: 'cloth_rag', count: 1 },
      { defId: 'flint', count: 1, chance: 0.5 },
    ],
    craftTicks: 20,
    xp: { skill: 'crafting', amount: 1 },
    unlockedByDefault: true,
  },
  {
    // `consumeDurability` input: the shipped tables have no mould-style recipe, where
    // the input is carried and worn down rather than eaten.
    id: 'test_pressed_nails',
    name: 'Pressed Nails',
    category: 'basic',
    inputs: [
      { defId: 'scrap_metal', count: 1 },
      { defId: 'hammer', count: 1, consumeDurability: 40 },
    ],
    tools: [],
    outputs: [{ defId: 'nail', count: 6 }],
    craftTicks: 20,
    xp: { skill: 'crafting', amount: 1 },
    unlockedByDefault: true,
  },
  {
    // Two required tools, so the slower of the two can be shown to set the pace.
    id: 'test_two_tool_job',
    name: 'Two Tool Job',
    category: 'basic',
    inputs: [{ defId: 'wood_log', count: 1 }],
    tools: ['saw', 'hammer'],
    outputs: [{ defId: 'wood_plank', count: 1 }],
    craftTicks: 200,
    xp: { skill: 'crafting', amount: 1 },
    unlockedByDefault: true,
  },
];

let cachedData: GameData | null = null;

function testData(): GameData {
  cachedData ??= createGameData({ recipes: [...RECIPE_DEFS, ...TEST_RECIPES] });
  return cachedData;
}

interface Options {
  seed?: number;
  craftSpeed?: number;
}

function makeSim(options: Options = {}): TestSimulation {
  return createTestSimulation({
    seed: options.seed,
    data: testData(),
    systems: [createCraftingSystem()],
    config: (config) => {
      if (options.craftSpeed !== undefined) config.tuning.craftSpeed = options.craftSpeed;
    },
  });
}

/** Units of an item a player is carrying, across every slot. */
function countOf(player: PlayerState, defId: string): number {
  let total = 0;
  for (const slot of player.inventory.slots) {
    if (slot?.defId === defId) total += slot.count;
  }
  return total;
}

/** Put a station right next to the player and hand back the structure. */
function placeStationBeside(
  sim: TestSimulation,
  player: PlayerState,
  defId: string,
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

function groundStacks(sim: TestSimulation, defId: string): ItemStack[] {
  return Object.values(sim.sim.state.items)
    .filter((entity) => entity.stack.defId === defId)
    .map((entity) => entity.stack);
}

function lastFailure(sim: TestSimulation): string {
  return sim.lastEvent('craftFailed')?.reason ?? sim.lastEvent('commandRejected')?.reason ?? '';
}

/**
 * Step until the player's hands are free again.
 *
 * Feeding, lighting and dousing a station all spend the shared `useReadyTick` that
 * eating, building and gathering spend, so two station commands on consecutive ticks
 * would see the second rejected as "still busy" - see {@link STATION_ACTION_TICKS}.
 * Tests that walk a fire through refuel-then-ignite have to wait the same beat a real
 * player does. The wait is free for fuel arithmetic: an unlit station burns nothing.
 */
function waitForHands(sim: TestSimulation, player: PlayerState): void {
  const ticks = player.useReadyTick - sim.sim.state.tick;
  if (ticks > 0) sim.step(ticks);
}

/** Feed a station every unit of one fuel item the player is carrying. */
function refuelFrom(
  sim: TestSimulation,
  player: PlayerState,
  station: StructureState,
  defId: string,
): void {
  const slot = player.inventory.slots.findIndex((stack) => stack?.defId === defId);
  sim.run(player, { type: 'refuel', structureId: station.id, inventorySlot: slot });
}

// ---------------------------------------------------------------------------
// Hand crafting
// ---------------------------------------------------------------------------

describe('hand crafting', () => {
  it('consumes the inputs up front and produces the output after craftTicks', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    sim.giveItem(player, 'plant_fiber', 5);

    sim.run(player, { type: 'craft', recipeId: 'craft_rope', count: 1 });

    // Reserved immediately: the fibre is gone before a single rope exists.
    expect(countOf(player, 'plant_fiber')).toBe(0);
    expect(countOf(player, 'rope')).toBe(0);
    expect(sim.lastEvent('craftQueued')?.recipeId).toBe('craft_rope');

    const job = player.craftQueue[0];
    expect(job).toBeDefined();
    expect(job?.ticksPerUnit).toBe(80);
    expect(job?.remaining).toBe(1);

    // One tick short.
    sim.step(78);
    expect(countOf(player, 'rope')).toBe(0);
    sim.step(1);
    expect(countOf(player, 'rope')).toBe(1);
    expect(player.craftQueue).toHaveLength(0);
    expect(sim.lastEvent('craftCompleted')?.output.defId).toBe('rope');
    expect(player.stats.itemsCrafted).toBe(1);
  });

  it('grants the recipe xp on completion', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    sim.giveItem(player, 'plant_fiber', 5);
    sim.run(player, { type: 'craft', recipeId: 'craft_rope', count: 1 });
    sim.step(80);
    expect(sim.eventsOf('skillXp').some((event) => event.skill === 'crafting')).toBe(true);
    expect(player.skills.crafting.xp).toBeGreaterThan(0);
  });

  it('rejects a craft with missing inputs, naming what is short', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    sim.giveItem(player, 'plant_fiber', 4);

    sim.run(player, { type: 'craft', recipeId: 'craft_rope', count: 1 });

    expect(player.craftQueue).toHaveLength(0);
    expect(countOf(player, 'plant_fiber')).toBe(4);
    expect(lastFailure(sim)).toMatch(/needs 5 x Plant Fiber/);
  });

  it('rejects an unknown recipe with commandRejected', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    sim.run(player, { type: 'craft', recipeId: 'not_a_recipe', count: 1 });
    expect(sim.lastEvent('commandRejected')?.reason).toMatch(/no such recipe/);
  });

  it('rejects nonsense counts', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    sim.giveItem(player, 'plant_fiber', 20);

    sim.run(player, { type: 'craft', recipeId: 'craft_rope', count: 0 });
    expect(lastFailure(sim)).toMatch(/between 1 and/);
    sim.run(player, { type: 'craft', recipeId: 'craft_rope', count: 1000 });
    expect(lastFailure(sim)).toMatch(/between 1 and/);
    expect(player.craftQueue).toHaveLength(0);
    expect(countOf(player, 'plant_fiber')).toBe(20);
  });

  it('refuses to craft for a dead player', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    sim.giveItem(player, 'plant_fiber', 5);
    player.alive = false;

    sim.run(player, { type: 'craft', recipeId: 'craft_rope', count: 1 });
    expect(player.craftQueue).toHaveLength(0);
    expect(lastFailure(sim)).toMatch(/dead/);
  });

  it('gates a recipe behind its required skill level', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    sim.giveItem(player, 'plant_fiber', 4);

    sim.run(player, { type: 'craft', recipeId: 'test_master_knot', count: 1 });
    expect(lastFailure(sim)).toMatch(/crafting level 3/);
    expect(player.craftQueue).toHaveLength(0);

    player.skills.crafting.level = 3;
    sim.run(player, { type: 'craft', recipeId: 'test_master_knot', count: 1 });
    expect(player.craftQueue).toHaveLength(1);
  });

  it('gates a schematic recipe on carrying the schematic', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    const crossbow = sim.data.recipes.require('craft_crossbow');

    expect(canCraft(sim.ctx, player, crossbow).reason).toMatch(/not learned/);
    sim.giveItem(player, 'schematic_crossbow', 1);
    // Still not craftable - but no longer for want of the recipe itself.
    expect(canCraft(sim.ctx, player, crossbow).reason).not.toMatch(/not learned/);
  });

  it('crafts several units from one command', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    sim.giveItem(player, 'plant_fiber', 15);

    sim.run(player, { type: 'craft', recipeId: 'craft_rope', count: 3 });
    expect(countOf(player, 'plant_fiber')).toBe(0);
    expect(player.craftQueue[0]?.remaining).toBe(3);

    sim.step(80);
    expect(countOf(player, 'rope')).toBe(1);
    sim.step(80);
    expect(countOf(player, 'rope')).toBe(2);
    sim.step(80);
    expect(countOf(player, 'rope')).toBe(3);
    expect(player.craftQueue).toHaveLength(0);
    expect(sim.eventsOf('craftCompleted')).toHaveLength(3);
  });

  it('caps how many jobs one pair of hands may queue', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    sim.giveItem(player, 'plant_fiber', 50);

    for (let i = 0; i < MAX_QUEUED_JOBS; i++) {
      sim.run(player, { type: 'craft', recipeId: 'craft_rope', count: 1 });
    }
    expect(player.craftQueue).toHaveLength(MAX_QUEUED_JOBS);

    sim.run(player, { type: 'craft', recipeId: 'craft_rope', count: 1 });
    expect(player.craftQueue).toHaveLength(MAX_QUEUED_JOBS);
    expect(lastFailure(sim)).toMatch(/queue is full/);
  });

  it('only advances the job at the head of the queue', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    sim.giveItem(player, 'plant_fiber', 10);

    sim.run(player, { type: 'craft', recipeId: 'craft_rope', count: 1 });
    sim.run(player, { type: 'craft', recipeId: 'craft_rope', count: 1 });
    sim.step(40);

    expect(player.craftQueue[0]?.ticksLeft).toBeLessThan(41);
    expect(player.craftQueue[1]?.ticksLeft).toBe(player.craftQueue[1]?.ticksPerUnit);
  });

  it('emits progress events sparingly rather than every tick', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    sim.giveItem(player, 'plant_fiber', 5);
    sim.run(player, { type: 'craft', recipeId: 'craft_rope', count: 1 });
    sim.step(80);
    // 80 ticks of work, one event per 20 ticks, none on the completing tick.
    expect(sim.eventsOf('craftProgress')).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Reservation
// ---------------------------------------------------------------------------

describe('input reservation', () => {
  it('takes the materials at queue time, so a second job cannot reuse them', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    sim.giveItem(player, 'plant_fiber', 5);

    sim.run(player, { type: 'craft', recipeId: 'craft_rope', count: 1 });
    sim.run(player, { type: 'craft', recipeId: 'craft_rope', count: 1 });

    expect(player.craftQueue).toHaveLength(1);
    expect(lastFailure(sim)).toMatch(/needs 5 x Plant Fiber/);
  });

  it('finishes even if the player empties their pack mid-craft', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    sim.giveItem(player, 'plant_fiber', 10);

    sim.run(player, { type: 'craft', recipeId: 'craft_rope', count: 1 });
    sim.step(20);
    // Everything the player is carrying vanishes; the reserved craft does not.
    player.inventory.slots.fill(null);
    sim.step(60);

    expect(countOf(player, 'rope')).toBe(1);
  });

  it('still carries the weight of the materials it has reserved', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    sim.giveItem(player, 'wood_log', 10);
    const loaded = player.carryWeight;
    expect(loaded).toBeGreaterThan(0);

    // Reserving takes the logs out of the pack, but they have not gone anywhere - they
    // are in the same pack, spoken for. Queueing must not be an anti-gravity trick.
    sim.run(player, { type: 'craft', recipeId: 'craft_stick', count: 8 });
    expect(countOf(player, 'wood_log')).toBe(2);
    expect(player.carryWeight).toBeCloseTo(loaded, 5);

    // Any other system that touches the pack recomputes carry weight from the slots
    // alone and knows nothing about the queue, wiping the reserve out. Stand in for one
    // here - the crafting tick has to put it straight again.
    recomputeCarryWeight(player, sim.data);
    expect(player.carryWeight).toBeLessThan(loaded);
    sim.step(1);
    expect(player.carryWeight).toBeCloseTo(loaded, 5);
  });

  it('gives the reserved weight back as the job burns through it', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    sim.giveItem(player, 'wood_log', 4);
    const loaded = player.carryWeight;

    sim.run(player, { type: 'craft', recipeId: 'craft_stick', count: 4 });
    expect(player.carryWeight).toBeCloseTo(loaded, 5);

    // Sticks weigh less than the logs they came from, so finishing the lot has to leave
    // the player lighter than they started - proof the reserve is released, not leaked.
    sim.step(4 * 60 + 10);
    expect(player.craftQueue).toHaveLength(0);
    expect(player.carryWeight).toBeLessThan(loaded);
    expect(player.carryWeight).toBeGreaterThan(0);
  });

  it('matches tag inputs, spending the recipe’s own item first', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    sim.giveItem(player, 'wood_log', 2);
    sim.giveItem(player, 'stick', 2);

    sim.run(player, { type: 'craft', recipeId: 'test_wood_bundle', count: 1 });

    expect(countOf(player, 'wood_log')).toBe(0);
    expect(countOf(player, 'stick')).toBe(2);
    sim.step(40);
    expect(countOf(player, 'charcoal')).toBe(1);
  });

  it('accepts any tagged item when the named one is absent', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    sim.giveItem(player, 'stick', 2);

    sim.run(player, { type: 'craft', recipeId: 'test_wood_bundle', count: 1 });
    expect(player.craftQueue).toHaveLength(1);
    expect(countOf(player, 'stick')).toBe(0);
  });

  it('rejects a tag input the player cannot cover', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    sim.giveItem(player, 'stick', 1);

    sim.run(player, { type: 'craft', recipeId: 'test_wood_bundle', count: 1 });
    expect(player.craftQueue).toHaveLength(0);
    expect(lastFailure(sim)).toMatch(/needs 2 x/);
    expect(countOf(player, 'stick')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

describe('craft duration', () => {
  it('shortens with the craftSpeed tuning knob', () => {
    const fast = makeSim({ craftSpeed: 2 });
    const player = fast.addPlayer();
    fast.giveItem(player, 'plant_fiber', 5);
    fast.run(player, { type: 'craft', recipeId: 'craft_rope', count: 1 });

    expect(player.craftQueue[0]?.ticksPerUnit).toBe(40);
    fast.step(40);
    expect(countOf(player, 'rope')).toBe(1);
  });

  it('shortens with the practising skill', () => {
    const sim = makeSim();
    const novice = sim.addPlayer({ id: 'novice' });
    const master = sim.addPlayer({ id: 'master' });
    master.skills.crafting.level = 10;

    const rope = sim.data.recipes.require('craft_rope');
    expect(craftTicksPerUnit(sim.ctx, novice, rope)).toBe(80);
    // skillCostMultiplier floors at 0.5, so mastery halves the work and no more.
    expect(craftTicksPerUnit(sim.ctx, master, rope)).toBe(40);
  });

  it('stacks the tuning knob with the skill', () => {
    const sim = makeSim({ craftSpeed: 2 });
    const player = sim.addPlayer();
    player.skills.crafting.level = 10;
    const rope = sim.data.recipes.require('craft_rope');
    expect(craftTicksPerUnit(sim.ctx, player, rope)).toBe(20);
  });

  it('goes faster with a better tool', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    const block = sim.data.recipes.require('craft_stone_block');

    sim.giveItem(player, 'stone_pickaxe', 1);
    const withStone = craftTicksPerUnit(sim.ctx, player, block);
    player.inventory.slots.fill(null);
    sim.giveItem(player, 'steel_pickaxe', 1);
    const withSteel = craftTicksPerUnit(sim.ctx, player, block);

    expect(withStone).toBe(200);
    expect(withSteel).toBe(80);
  });

  it('runs at the pace of the worst tool a recipe needs', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    const job = sim.data.recipes.require('test_two_tool_job');

    // Multitool covers both roles at efficiency 2.2, so nothing is holding the job up.
    sim.giveItem(player, 'multitool', 1);
    const bothGood = craftTicksPerUnit(sim.ctx, player, job);

    // Put a plain saw in hand. A held tool wins over a stowed one, so the sawing half
    // of the job now runs at 1.6 while the hammering half still has the multitool -
    // and the whole job should slow to the pace of the worse of the two.
    sim.equip(player, 'saw');
    const sawBound = craftTicksPerUnit(sim.ctx, player, job);

    expect(bothGood).toBe(Math.round(200 / 2.2));
    expect(sawBound).toBe(Math.round(200 / 1.6));
    expect(sawBound).toBeGreaterThan(bothGood);
  });

  it('wears the tools it uses without consuming them', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    const bench = placeStationBeside(sim, player, 'workbench');
    const saw = sim.giveItem(player, 'saw', 1);
    sim.giveItem(player, 'wood_log', 1);

    sim.run(player, {
      type: 'craft',
      recipeId: 'craft_wood_plank',
      count: 1,
      stationId: bench.id,
    });
    sim.step(400);

    const held = player.inventory.slots.find((slot) => slot?.defId === 'saw');
    expect(held).toBeDefined();
    expect(held?.durability).toBeLessThan(saw.durability ?? 0);
    expect(countOf(player, 'wood_plank')).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// `consumeDurability` inputs: a mould is carried and worn, never eaten
// ---------------------------------------------------------------------------

describe('inputs consumed as durability', () => {
  it('keeps the item and spends its durability instead', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    const hammer = sim.giveItem(player, 'hammer', 1);
    sim.giveItem(player, 'scrap_metal', 1);

    sim.run(player, { type: 'craft', recipeId: 'test_pressed_nails', count: 1 });
    sim.step(40);

    expect(countOf(player, 'nail')).toBe(6);
    expect(countOf(player, 'scrap_metal')).toBe(0);
    // Still one hammer, 40 points lighter.
    expect(countOf(player, 'hammer')).toBe(1);
    const worn = player.inventory.slots.find((slot) => slot?.defId === 'hammer');
    expect(worn?.durability).toBe((hammer.durability ?? 0) - 40);
  });

  it('rejects the craft when the mould is missing entirely', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    sim.giveItem(player, 'scrap_metal', 1);

    sim.run(player, { type: 'craft', recipeId: 'test_pressed_nails', count: 1 });
    expect(lastFailure(sim)).toMatch(/needs a Hammer/);
    expect(player.craftQueue).toHaveLength(0);
    // Rejected before reservation, so the scrap is untouched.
    expect(countOf(player, 'scrap_metal')).toBe(1);
  });

  it('rejects the craft when the mould is too worn for even one unit', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    sim.giveItem(player, 'hammer', 1);
    // `giveItem` copies the stack into the inventory, so wear down the real one.
    const held = player.inventory.slots.find((slot) => slot?.defId === 'hammer');
    if (held) held.durability = 10;
    sim.giveItem(player, 'scrap_metal', 1);

    sim.run(player, { type: 'craft', recipeId: 'test_pressed_nails', count: 1 });
    expect(lastFailure(sim)).toMatch(/worn out/);
    expect(player.craftQueue).toHaveLength(0);
  });

  it('requires the whole job’s worth of durability up front', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    sim.giveItem(player, 'hammer', 1);
    sim.giveItem(player, 'scrap_metal', 10);

    // A full hammer is 260 points, so 6 units (240) fit and 7 (280) do not.
    sim.run(player, { type: 'craft', recipeId: 'test_pressed_nails', count: 7 });
    expect(lastFailure(sim)).toMatch(/will not last 7/);
    expect(countOf(player, 'scrap_metal')).toBe(10);

    sim.run(player, { type: 'craft', recipeId: 'test_pressed_nails', count: 6 });
    expect(player.craftQueue).toHaveLength(1);
    sim.step(6 * 20 + 5);
    expect(countOf(player, 'nail')).toBe(36);
    const worn = player.inventory.slots.find((slot) => slot?.defId === 'hammer');
    expect(worn?.durability).toBe(260 - 6 * 40);
  });
});

// ---------------------------------------------------------------------------
// Stations
// ---------------------------------------------------------------------------

describe('station requirements', () => {
  it('rejects a station recipe attempted by hand', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    sim.giveItem(player, 'wood_log', 1);
    sim.giveItem(player, 'saw', 1);

    sim.run(player, { type: 'craft', recipeId: 'craft_wood_plank', count: 1 });
    expect(lastFailure(sim)).toMatch(/needs a workbench/);
    expect(player.craftQueue).toHaveLength(0);
    expect(countOf(player, 'wood_log')).toBe(1);
  });

  it('rejects the wrong kind of station', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    const campfire = placeStationBeside(sim, player, 'campfire');
    sim.giveItem(player, 'wood_log', 1);
    sim.giveItem(player, 'saw', 1);

    sim.run(player, {
      type: 'craft',
      recipeId: 'craft_wood_plank',
      count: 2,
      stationId: campfire.id,
    });
    expect(lastFailure(sim)).toMatch(/needs a workbench/);
  });

  it('rejects a station that is out of reach', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    const bench = placeStationBeside(sim, player, 'workbench', 10);
    sim.giveItem(player, 'wood_log', 1);
    sim.giveItem(player, 'saw', 1);

    sim.run(player, {
      type: 'craft',
      recipeId: 'craft_wood_plank',
      count: 1,
      stationId: bench.id,
    });
    expect(lastFailure(sim)).toMatch(/too far/);
    expect(bench.station?.jobs).toHaveLength(0);
  });

  it('rejects an unfinished station', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    const bench = placeStationBeside(sim, player, 'workbench');
    bench.progress = 0.4;
    sim.giveItem(player, 'wood_log', 1);
    sim.giveItem(player, 'saw', 1);

    sim.run(player, {
      type: 'craft',
      recipeId: 'craft_wood_plank',
      count: 1,
      stationId: bench.id,
    });
    expect(lastFailure(sim)).toMatch(/not finished/);
  });

  it('rejects a missing tool even at the right station', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    const bench = placeStationBeside(sim, player, 'workbench');
    sim.giveItem(player, 'wood_log', 1);

    sim.run(player, {
      type: 'craft',
      recipeId: 'craft_wood_plank',
      count: 1,
      stationId: bench.id,
    });
    expect(lastFailure(sim)).toMatch(/needs a saw/);
  });

  it('queues the job on the station, not the player', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    const bench = placeStationBeside(sim, player, 'workbench');
    sim.giveItem(player, 'wood_log', 1);
    sim.giveItem(player, 'saw', 1);

    sim.run(player, {
      type: 'craft',
      recipeId: 'craft_wood_plank',
      count: 1,
      stationId: bench.id,
    });

    expect(player.craftQueue).toHaveLength(0);
    expect(bench.station?.jobs).toHaveLength(1);
    expect(bench.station?.jobs[0]?.stationId).toBe(bench.id);
  });

  it('keeps a station job running after the crafter walks away', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    const bench = placeStationBeside(sim, player, 'workbench');
    sim.giveItem(player, 'wood_log', 1);
    sim.giveItem(player, 'saw', 1);

    sim.run(player, {
      type: 'craft',
      recipeId: 'craft_wood_plank',
      count: 1,
      stationId: bench.id,
    });
    player.x += 2000;
    sim.step(400);

    // The work carried on with nobody watching it - that is the whole reason to build
    // a station rather than whittle by hand - and it finished.
    expect(bench.station?.jobs).toHaveLength(0);
    expect(sim.lastEvent('craftCompleted')?.output.count).toBe(3);
    // But the planks came out of the bench, not into a pack two thousand pixels
    // downwind. A station that posted its output to an absent owner would be a courier.
    expect(countOf(player, 'wood_plank')).toBe(0);
    expect(groundStacks(sim, 'wood_plank').reduce((n, stack) => n + stack.count, 0)).toBe(3);
  });

  it('hands a station job’s output straight to a crafter who stayed put', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    const bench = placeStationBeside(sim, player, 'workbench');
    sim.giveItem(player, 'wood_log', 1);
    sim.giveItem(player, 'saw', 1);

    sim.run(player, {
      type: 'craft',
      recipeId: 'craft_wood_plank',
      count: 1,
      stationId: bench.id,
    });
    sim.step(400);

    expect(countOf(player, 'wood_plank')).toBe(3);
    expect(groundStacks(sim, 'wood_plank')).toHaveLength(0);
  });

  it('leaves the output at the station when the crafter has left the world', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    const bench = placeStationBeside(sim, player, 'workbench');
    sim.giveItem(player, 'wood_log', 1);
    sim.giveItem(player, 'saw', 1);

    sim.run(player, {
      type: 'craft',
      recipeId: 'craft_wood_plank',
      count: 1,
      stationId: bench.id,
    });
    sim.sim.removePlayer(player.id);
    sim.step(400);

    expect(groundStacks(sim, 'wood_plank').length).toBeGreaterThan(0);
  });

  it('ignores a station passed along with a hand recipe', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    const bench = placeStationBeside(sim, player, 'workbench');
    sim.giveItem(player, 'plant_fiber', 5);

    sim.run(player, {
      type: 'craft',
      recipeId: 'craft_rope',
      count: 1,
      stationId: bench.id,
    });

    expect(player.craftQueue).toHaveLength(1);
    expect(bench.station?.jobs).toHaveLength(0);
  });

  it('measures reach from the footprint, so a 2x1 bench is usable from either end', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    const bench = placeStationBeside(sim, player, 'workbench');
    const plank = sim.data.recipes.require('craft_wood_plank');
    sim.giveItem(player, 'wood_log', 2);
    sim.giveItem(player, 'saw', 1);

    // Standing at the near end, where the bench was placed: obviously in reach.
    expect(canCraft(sim.ctx, player, plank, bench.id).ok).toBe(true);

    // Now walk round to the far side of the two-tile bench. The player is further from
    // the origin tile than STATION_REACH, but only half a tile from the far edge, so
    // measuring against the whole footprint is what keeps the bench usable.
    const bounds = { minX: bench.tileX * 32, maxX: (bench.tileX + 2) * 32 };
    player.x = bounds.maxX + 16;
    expect(player.x - bounds.minX).toBeGreaterThan(STATION_REACH);
    expect(canCraft(sim.ctx, player, plank, bench.id).ok).toBe(true);

    // Far enough off the far edge, though, and it is genuinely out of reach.
    player.x = bounds.maxX + STATION_REACH + 8;
    expect(canCraft(sim.ctx, player, plank, bench.id).reason).toMatch(/too far/);
  });
});

// ---------------------------------------------------------------------------
// Heat and fuel
// ---------------------------------------------------------------------------

describe('heat and fuel', () => {
  it('refuses a requiresHeat recipe at an unlit station', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    const campfire = placeStationBeside(sim, player, 'campfire');
    sim.giveItem(player, 'raw_meat', 1);

    sim.run(player, { type: 'craft', recipeId: 'cook_meat', count: 1, stationId: campfire.id });
    expect(lastFailure(sim)).toMatch(/not lit/);
    expect(campfire.station?.jobs).toHaveLength(0);
  });

  it('cooks once the fire is lit, burning fuel as it goes', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    const campfire = placeStationBeside(sim, player, 'campfire');
    sim.giveItem(player, 'raw_meat', 1);
    sim.giveItem(player, 'wood_log', 1);
    sim.giveItem(player, 'lighter', 1);

    refuelFrom(sim, player, campfire, 'wood_log');
    expect(campfire.station?.fuel).toBe(2400);

    waitForHands(sim, player);
    sim.run(player, { type: 'ignite', structureId: campfire.id });
    expect(campfire.station?.lit).toBe(true);

    sim.run(player, { type: 'craft', recipeId: 'cook_meat', count: 1, stationId: campfire.id });
    const before = campfire.station?.fuel ?? 0;
    sim.step(240);

    expect(countOf(player, 'cooked_meat')).toBe(1);
    expect(campfire.station?.fuel).toBeLessThan(before);
  });

  it('stalls a job with a reason when the fuel runs out, and resumes when refuelled', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    const furnace = placeStationBeside(sim, player, 'furnace');
    sim.giveItem(player, 'iron_ore', 2);
    sim.giveItem(player, 'stick', 1);
    sim.giveItem(player, 'lighter', 1);

    // One stick is 400 ticks of burn; an iron smelt costs 600 over 500 ticks.
    refuelFrom(sim, player, furnace, 'stick');
    waitForHands(sim, player);
    sim.run(player, { type: 'ignite', structureId: furnace.id });
    sim.run(player, {
      type: 'craft',
      recipeId: 'smelt_iron_ingot',
      count: 1,
      stationId: furnace.id,
    });

    sim.step(400);
    const stalled = furnace.station?.jobs[0];
    expect(stalled).toBeDefined();
    // The hopper is empty, so the complaint is about fuel and not about the flame.
    expect(stalled?.blockedReason).toBe('the station is out of fuel');
    expect(furnace.station?.lit).toBe(false);
    expect(furnace.station?.heat).toBe(0);
    expect(countOf(player, 'iron_ingot')).toBe(0);
    const frozenAt = stalled?.ticksLeft ?? 0;
    sim.step(50);
    expect(furnace.station?.jobs[0]?.ticksLeft).toBe(frozenAt);

    sim.giveItem(player, 'wood_log', 1);
    refuelFrom(sim, player, furnace, 'wood_log');
    waitForHands(sim, player);
    sim.run(player, { type: 'ignite', structureId: furnace.id });
    expect(furnace.station?.jobs[0]?.blockedReason).toBeUndefined();

    sim.step(400);
    expect(countOf(player, 'iron_ingot')).toBe(1);
  });

  it('blames the flame, not the fuel, when a stocked station is put out mid-job', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    const furnace = placeStationBeside(sim, player, 'furnace');
    sim.giveItem(player, 'iron_ore', 2);
    sim.giveItem(player, 'wood_log', 5);
    sim.giveItem(player, 'lighter', 1);

    refuelFrom(sim, player, furnace, 'wood_log');
    waitForHands(sim, player);
    sim.run(player, { type: 'ignite', structureId: furnace.id });
    sim.run(player, {
      type: 'craft',
      recipeId: 'smelt_iron_ingot',
      count: 1,
      stationId: furnace.id,
    });
    sim.step(50);
    expect(furnace.station?.jobs).toHaveLength(1);

    // Plenty of fuel left, but somebody smothered the fire.
    sim.run(player, { type: 'extinguish', structureId: furnace.id });
    sim.step(5);
    expect(furnace.station?.fuel).toBeGreaterThan(0);
    expect(furnace.station?.jobs[0]?.blockedReason).toBe('the station is not lit');

    // Relighting it, rather than refuelling it, is what gets the smelt moving again.
    waitForHands(sim, player);
    sim.run(player, { type: 'ignite', structureId: furnace.id });
    expect(furnace.station?.jobs[0]?.blockedReason).toBeUndefined();
    sim.step(600);
    expect(countOf(player, 'iron_ingot')).toBe(1);
  });

  it('charges a job exactly the fuelCost the recipe advertises', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    const furnace = placeStationBeside(sim, player, 'furnace');
    sim.giveItem(player, 'iron_ore', 2);
    sim.giveItem(player, 'wood_log', 5);
    sim.giveItem(player, 'lighter', 1);

    refuelFrom(sim, player, furnace, 'wood_log');
    waitForHands(sim, player);
    sim.run(player, { type: 'ignite', structureId: furnace.id });
    const start = furnace.station?.fuel ?? 0;

    sim.run(player, {
      type: 'craft',
      recipeId: 'smelt_iron_ingot',
      count: 1,
      stationId: furnace.id,
    });
    sim.step(499);

    expect(countOf(player, 'iron_ingot')).toBe(1);
    // 600 for the smelt, and nothing on top of it: the ambient burn is the same fire.
    expect(start - (furnace.station?.fuel ?? 0)).toBeCloseTo(600, 5);
  });

  it('burns a lit station down even with nothing queued, then goes out', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    const campfire = placeStationBeside(sim, player, 'campfire');
    sim.giveItem(player, 'bark', 1);
    sim.giveItem(player, 'lighter', 1);

    refuelFrom(sim, player, campfire, 'bark');
    waitForHands(sim, player);
    sim.run(player, { type: 'ignite', structureId: campfire.id });
    // Bark is 260 ticks of burn, less the one tick the fire has already been alight:
    // commands are dispatched before the crafting system runs, so the tick that lights
    // a fire is also a tick it burns.
    expect(campfire.station?.fuel).toBe(259);
    expect(campfire.light?.on).toBe(true);

    sim.step(100);
    expect(campfire.station?.fuel).toBeCloseTo(159, 5);

    sim.step(200);
    expect(campfire.station?.lit).toBe(false);
    expect(campfire.station?.fuel).toBe(0);
    expect(campfire.station?.heat).toBe(0);
    expect(campfire.light?.on).toBe(false);
    expect(sim.eventsOf('stationLit').at(-1)?.lit).toBe(false);
  });

  it('never asks a fuel-free station for fuel', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    const bench = placeStationBeside(sim, player, 'workbench');
    sim.giveItem(player, 'wood_log', 1);
    sim.giveItem(player, 'saw', 1);

    sim.run(player, {
      type: 'craft',
      recipeId: 'craft_wood_plank',
      count: 1,
      stationId: bench.id,
    });
    sim.step(400);

    expect(countOf(player, 'wood_plank')).toBe(3);
    expect(bench.station?.fuel).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Station commands
// ---------------------------------------------------------------------------

describe('refuel', () => {
  it('moves whole units of fuel out of the inventory and into the fire', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    const furnace = placeStationBeside(sim, player, 'furnace');
    sim.giveItem(player, 'wood_log', 3);

    const slot = player.inventory.slots.findIndex((stack) => stack?.defId === 'wood_log');
    sim.run(player, { type: 'refuel', structureId: furnace.id, inventorySlot: slot });

    expect(furnace.station?.fuel).toBe(7200);
    expect(countOf(player, 'wood_log')).toBe(0);
    expect(sim.lastEvent('notification')?.severity).toBe('success');
  });

  it('stops at maxFuel rather than overflowing', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    const campfire = placeStationBeside(sim, player, 'campfire');
    sim.giveItem(player, 'coal', 5);

    const slot = player.inventory.slots.findIndex((stack) => stack?.defId === 'coal');
    sim.run(player, { type: 'refuel', structureId: campfire.id, inventorySlot: slot });

    const maxFuel = campfire.station?.maxFuel ?? 0;
    expect(campfire.station?.fuel).toBeLessThanOrEqual(maxFuel);
    // 12 000 capacity, 6 000 a lump: exactly two lumps, three left in the pack.
    expect(campfire.station?.fuel).toBe(12000);
    expect(countOf(player, 'coal')).toBe(3);
  });

  it('rejects things that do not burn', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    const campfire = placeStationBeside(sim, player, 'campfire');
    sim.giveItem(player, 'stone', 2);

    const slot = player.inventory.slots.findIndex((stack) => stack?.defId === 'stone');
    sim.run(player, { type: 'refuel', structureId: campfire.id, inventorySlot: slot });

    expect(campfire.station?.fuel).toBe(0);
    expect(sim.lastEvent('commandRejected')?.reason).toMatch(/does not burn/);
    expect(countOf(player, 'stone')).toBe(2);
  });

  it('rejects an empty slot, a bad index and a station with no fire', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    const campfire = placeStationBeside(sim, player, 'campfire');
    const bench = placeStationBeside(sim, player, 'workbench', 2);

    sim.run(player, { type: 'refuel', structureId: campfire.id, inventorySlot: 0 });
    expect(sim.lastEvent('commandRejected')?.reason).toMatch(/empty/);

    sim.run(player, { type: 'refuel', structureId: campfire.id, inventorySlot: 999 });
    expect(sim.lastEvent('commandRejected')?.reason).toMatch(/no such inventory slot/);

    sim.giveItem(player, 'wood_log', 1);
    const slot = player.inventory.slots.findIndex((stack) => stack?.defId === 'wood_log');
    sim.run(player, { type: 'refuel', structureId: bench.id, inventorySlot: slot });
    expect(sim.lastEvent('commandRejected')?.reason).toMatch(/burns no fuel/);

    sim.run(player, { type: 'refuel', structureId: 'nope', inventorySlot: slot });
    expect(sim.lastEvent('commandRejected')?.reason).toMatch(/not a station/);
  });

  it('rejects refuelling from out of reach', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    const campfire = placeStationBeside(sim, player, 'campfire', 12);
    sim.giveItem(player, 'wood_log', 1);

    const slot = player.inventory.slots.findIndex((stack) => stack?.defId === 'wood_log');
    sim.run(player, { type: 'refuel', structureId: campfire.id, inventorySlot: slot });

    expect(campfire.station?.fuel).toBe(0);
    expect(sim.lastEvent('commandRejected')?.reason).toMatch(/too far/);
  });

  it('rejects topping up a station that is already full', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    const campfire = placeStationBeside(sim, player, 'campfire');
    if (campfire.station) campfire.station.fuel = campfire.station.maxFuel;
    sim.giveItem(player, 'wood_log', 1);

    const slot = player.inventory.slots.findIndex((stack) => stack?.defId === 'wood_log');
    sim.run(player, { type: 'refuel', structureId: campfire.id, inventorySlot: slot });
    expect(sim.lastEvent('commandRejected')?.reason).toMatch(/already full/);
    expect(countOf(player, 'wood_log')).toBe(1);
  });
});

describe('ignite and extinguish', () => {
  it('lights a fuelled station with a lighter, spending its durability', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    const campfire = placeStationBeside(sim, player, 'campfire');
    sim.giveItem(player, 'wood_log', 1);
    const lighter = sim.giveItem(player, 'lighter', 1);

    refuelFrom(sim, player, campfire, 'wood_log');
    waitForHands(sim, player);
    sim.run(player, { type: 'ignite', structureId: campfire.id });

    expect(campfire.station?.lit).toBe(true);
    expect(campfire.station?.heat).toBe(14);
    expect(sim.lastEvent('stationLit')).toEqual({
      type: 'stationLit',
      structureId: campfire.id,
      lit: true,
    });
    const held = player.inventory.slots.find((stack) => stack?.defId === 'lighter');
    expect(held?.durability).toBeLessThan(lighter.durability ?? 0);
  });

  it('refuses to light an empty station, a lit one, or one it cannot reach', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    const campfire = placeStationBeside(sim, player, 'campfire');
    sim.giveItem(player, 'lighter', 1);

    sim.run(player, { type: 'ignite', structureId: campfire.id });
    expect(sim.lastEvent('commandRejected')?.reason).toMatch(/no fuel/);

    if (campfire.station) campfire.station.fuel = 1000;
    sim.run(player, { type: 'ignite', structureId: campfire.id });
    expect(campfire.station?.lit).toBe(true);
    waitForHands(sim, player);
    sim.run(player, { type: 'ignite', structureId: campfire.id });
    expect(sim.lastEvent('commandRejected')?.reason).toMatch(/already lit/);

    const far = placeStationBeside(sim, player, 'campfire', 12);
    if (far.station) far.station.fuel = 1000;
    sim.run(player, { type: 'ignite', structureId: far.id });
    expect(far.station?.lit).toBe(false);
    expect(sim.lastEvent('commandRejected')?.reason).toMatch(/too far/);
  });

  it('makes a player finish one station action before starting the next', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    const campfire = placeStationBeside(sim, player, 'campfire');
    sim.giveItem(player, 'wood_log', 1);
    sim.giveItem(player, 'bark', 3);
    sim.giveItem(player, 'lighter', 1);

    // One command empties one slot into the fire and starts the shared hand cooldown.
    refuelFrom(sim, player, campfire, 'wood_log');
    expect(player.useReadyTick).toBe(sim.sim.state.tick + STATION_ACTION_TICKS);
    const fed = campfire.station?.fuel ?? 0;
    expect(fed).toBe(2400);

    // A client emptying slot after slot into the fire on consecutive ticks gets
    // nowhere. Without this gate a pack of twenty fuel slots is one tick's work, and
    // every `ignite` pays for the neighbouring-fire search as often as it is asked.
    refuelFrom(sim, player, campfire, 'bark');
    expect(sim.lastEvent('commandRejected')?.reason).toMatch(/still busy/);
    sim.run(player, { type: 'ignite', structureId: campfire.id });
    expect(sim.lastEvent('commandRejected')?.reason).toMatch(/still busy/);
    expect(campfire.station?.fuel).toBe(fed);
    expect(campfire.station?.lit).toBe(false);
    expect(countOf(player, 'bark')).toBe(3);

    waitForHands(sim, player);
    sim.run(player, { type: 'ignite', structureId: campfire.id });
    expect(campfire.station?.lit).toBe(true);
  });

  it('refuses to light anything with no ignition source', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    const campfire = placeStationBeside(sim, player, 'campfire');
    if (campfire.station) campfire.station.fuel = 1000;

    sim.run(player, { type: 'ignite', structureId: campfire.id });
    expect(campfire.station?.lit).toBe(false);
    expect(sim.lastEvent('commandRejected')?.reason).toMatch(/nothing to light it with/);
  });

  it('lights a fire for free from a neighbouring fire', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    const lit = placeStationBeside(sim, player, 'campfire', 1);
    const cold = placeStationBeside(sim, player, 'campfire', 2);
    if (lit.station) {
      lit.station.fuel = 1000;
      lit.station.lit = true;
    }
    if (cold.station) cold.station.fuel = 1000;

    sim.run(player, { type: 'ignite', structureId: cold.id });
    expect(cold.station?.lit).toBe(true);
  });

  it('refuses to light a station that has no fire at all', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    const bench = placeStationBeside(sim, player, 'workbench');
    sim.giveItem(player, 'lighter', 1);

    sim.run(player, { type: 'ignite', structureId: bench.id });
    expect(sim.lastEvent('commandRejected')?.reason).toMatch(/nothing to light/);
  });

  it('extinguishes a lit station and keeps its remaining fuel', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    const campfire = placeStationBeside(sim, player, 'campfire');
    if (campfire.station) {
      campfire.station.fuel = 1000;
      campfire.station.lit = true;
      campfire.station.heat = 14;
    }

    sim.run(player, { type: 'extinguish', structureId: campfire.id });

    expect(campfire.station?.lit).toBe(false);
    expect(campfire.station?.heat).toBe(0);
    expect(campfire.station?.fuel).toBe(1000);
    expect(sim.lastEvent('stationLit')?.lit).toBe(false);
  });

  it('rejects extinguishing something that is not burning', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    const campfire = placeStationBeside(sim, player, 'campfire');

    sim.run(player, { type: 'extinguish', structureId: campfire.id });
    expect(sim.lastEvent('commandRejected')?.reason).toMatch(/not lit/);
  });
});

// ---------------------------------------------------------------------------
// Cancelling
// ---------------------------------------------------------------------------

describe('reserved weight', () => {
  it("stops counting a finished job's inputs the moment the queue empties", () => {
    // Reserved materials still weigh what they weighed - they are in the same pack, spoken
    // for - so `carryWeight` counts them. The per-tick correction skipped an empty queue,
    // which is exactly the tick that needs it: the last unit's inputs were still counted
    // when the weight was last settled. The phantom kilos then stayed in replicated state
    // for good, and no amount of further play cleared them.
    const sim = createTestSimulation({ systems: [createCraftingSystem()] });
    const player = sim.addPlayer();
    sim.giveItem(player, 'plant_fiber', 10);

    sim.run(player, { type: 'craft', recipeId: 'craft_rope', count: 2 });
    expect(player.craftQueue).toHaveLength(1);

    // Long enough for both units to finish and the job to leave the queue.
    sim.step(400);
    expect(player.craftQueue).toHaveLength(0);

    const reported = player.carryWeight;
    recomputeCarryWeight(player, sim.data);
    expect(reported).toBeCloseTo(player.carryWeight, 5);
  });
});

describe('cancelCraft', () => {
  it('refunds the un-started remainder and forfeits the unit in progress', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    sim.giveItem(player, 'plant_fiber', 15);

    sim.run(player, { type: 'craft', recipeId: 'craft_rope', count: 3 });
    const jobId = player.craftQueue[0]?.jobId ?? '';
    sim.step(30);

    sim.run(player, { type: 'cancelCraft', jobId });

    // Two untouched units come back; the one under the hammer does not.
    expect(countOf(player, 'plant_fiber')).toBe(10);
    expect(player.craftQueue).toHaveLength(0);
    expect(sim.lastEvent('craftCancelled')?.recipeId).toBe('craft_rope');
  });

  it('gives back the same stale materials it took, not fresh ones', () => {
    // The refund used to be minted from the recipe's definitions, which meant full
    // freshness and full durability. Reservation takes the *worst* units the player holds
    // (`removeFromInventory` sorts by wear, then staleness), so queue-then-cancel was a
    // spoilage cure and - since the game has no item-repair mechanic at all - the only way
    // to restore a worn tool.
    //
    // Uses the shipped data rather than this file's mini set, because the bug is about an
    // item that genuinely carries per-item state: `raw_meat` is perishable, and inventing
    // a `freshness` on an item whose definition has none tests nothing.
    const sim = createTestSimulation({ systems: [createCraftingSystem()] });
    const player = sim.addPlayer();
    sim.giveItem(player, 'raw_meat', 3);
    for (const slot of player.inventory.slots) {
      if (slot?.defId === 'raw_meat') slot.freshness = 0.05;
    }

    const campfire = sim.placeStructure(
      'campfire',
      pixelToTile(player.x) + 1,
      pixelToTile(player.y),
    )!;
    campfire.progress = 1;
    campfire.station!.lit = true;
    campfire.station!.fuel = campfire.station!.maxFuel;

    sim.run(player, {
      type: 'craft',
      recipeId: 'cook_meat',
      count: 2,
      stationId: campfire.id,
    });
    const job = campfire.station!.jobs[0];
    expect(job, 'the job should be queued at the campfire').toBeDefined();

    sim.run(player, { type: 'cancelCraft', jobId: job!.jobId, stationId: campfire.id });

    // Back in the pack or on the floor beside it - either way, still nearly rotten.
    const returned = [
      ...player.inventory.slots.filter((slot) => slot?.defId === 'raw_meat'),
      ...Object.values(sim.sim.state.items)
        .filter((item) => item.stack.defId === 'raw_meat')
        .map((item) => item.stack),
    ];
    // Two units were reserved and one tick of work had started, so the unit under way is
    // forfeited and the untouched one comes back: 1 never reserved + 1 refunded.
    const total = returned.reduce((sum, stack) => sum + (stack?.count ?? 0), 0);
    expect(total).toBe(2);
    for (const stack of returned) expect(stack?.freshness).toBeCloseTo(0.05, 5);
  });

  it("spills a station job's materials when the station is demolished", () => {
    // The job's inputs left the player's pack at queue time and the station holds them.
    // Removing the structure used to delete the jobs array and the materials with it - a
    // workbench with a full queue was several stacks that simply stopped existing.
    const sim = createTestSimulation({ systems: [createCraftingSystem()] });
    const player = sim.addPlayer();
    sim.giveItem(player, 'raw_meat', 2);

    const campfire = sim.placeStructure(
      'campfire',
      pixelToTile(player.x) + 1,
      pixelToTile(player.y),
    )!;
    campfire.progress = 1;
    campfire.station!.lit = true;
    campfire.station!.fuel = campfire.station!.maxFuel;

    sim.run(player, { type: 'craft', recipeId: 'cook_meat', count: 2, stationId: campfire.id });
    expect(campfire.station!.jobs).toHaveLength(1);
    expect(countOf(player, 'raw_meat')).toBe(0);

    // Destroyed rather than cancelled: this is the path that used to lose them.
    destroyStructure(sim.ctx, campfire);

    const onGround = Object.values(sim.sim.state.items)
      .filter((item) => item.stack.defId === 'raw_meat')
      .reduce((total, item) => total + item.stack.count, 0);
    expect(onGround).toBe(2);
  });

  it('refunds a job in full when no work has started on it', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    sim.giveItem(player, 'plant_fiber', 10);

    sim.run(player, { type: 'craft', recipeId: 'craft_rope', count: 1 });
    sim.run(player, { type: 'craft', recipeId: 'craft_rope', count: 1 });
    const queued = player.craftQueue[1]?.jobId ?? '';
    sim.step(20);

    sim.run(player, { type: 'cancelCraft', jobId: queued });
    expect(countOf(player, 'plant_fiber')).toBe(5);
    expect(player.craftQueue).toHaveLength(1);
  });

  it('cancels a station job and puts the materials in the canceller’s pack', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    const bench = placeStationBeside(sim, player, 'workbench');
    sim.giveItem(player, 'wood_log', 3);
    sim.giveItem(player, 'saw', 1);

    sim.run(player, {
      type: 'craft',
      recipeId: 'craft_wood_plank',
      count: 3,
      stationId: bench.id,
    });
    const jobId = bench.station?.jobs[0]?.jobId ?? '';
    sim.step(10);
    sim.run(player, { type: 'cancelCraft', jobId, stationId: bench.id });

    expect(bench.station?.jobs).toHaveLength(0);
    expect(countOf(player, 'wood_log')).toBe(2);
  });

  it('rejects cancelling somebody else’s job', () => {
    const sim = makeSim();
    const owner = sim.addPlayer({ id: 'owner' });
    const thief = sim.addPlayer({ id: 'thief', x: owner.x, y: owner.y });
    const bench = sim.placeStructure(
      'workbench',
      pixelToTile(owner.x) + 1,
      pixelToTile(owner.y),
      0,
      'someone_else',
    );
    if (!bench) throw new Error('no bench');
    sim.giveItem(owner, 'wood_log', 1);
    sim.giveItem(owner, 'saw', 1);

    sim.run(owner, {
      type: 'craft',
      recipeId: 'craft_wood_plank',
      count: 1,
      stationId: bench.id,
    });
    const jobId = bench.station?.jobs[0]?.jobId ?? '';
    sim.run(thief, { type: 'cancelCraft', jobId, stationId: bench.id });

    expect(bench.station?.jobs).toHaveLength(1);
    expect(sim.lastEvent('commandRejected')?.reason).toMatch(/not your craft job/);
  });

  it('rejects an unknown job id', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    sim.run(player, { type: 'cancelCraft', jobId: 'c999' });
    expect(sim.lastEvent('commandRejected')?.reason).toMatch(/no such craft job/);
  });

  it('spills a refund that no longer fits on the floor', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    sim.giveItem(player, 'plant_fiber', 10);

    sim.run(player, { type: 'craft', recipeId: 'craft_rope', count: 2 });
    const jobId = player.craftQueue[0]?.jobId ?? '';
    // Every slot taken by something that cannot stack.
    sim.giveItem(player, 'stone_hatchet', player.inventory.capacity);
    sim.run(player, { type: 'cancelCraft', jobId });

    expect(countOf(player, 'plant_fiber')).toBe(0);
    expect(groundStacks(sim, 'plant_fiber')[0]?.count).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Output handling
// ---------------------------------------------------------------------------

describe('crafted output', () => {
  it('drops the result rather than destroying it when the pack fills up', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    sim.giveItem(player, 'wood_log', 1);

    sim.run(player, { type: 'craft', recipeId: 'craft_stick', count: 1 });
    // The log is gone and the slot is free; fill every slot before the craft lands.
    sim.giveItem(player, 'stone_hatchet', player.inventory.capacity);
    sim.step(60);

    expect(countOf(player, 'stick')).toBe(0);
    expect(groundStacks(sim, 'stick')[0]?.count).toBe(4);
    expect(sim.lastEvent('craftCompleted')?.output.count).toBe(4);
  });

  it('refuses to start a hand craft with no room for the result', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    // Every slot but one holds an unstackable hatchet; the last holds two logs, so
    // spending one of them does not free the slot and the sticks have nowhere to land.
    sim.giveItem(player, 'stone_hatchet', player.inventory.capacity - 1);
    sim.giveItem(player, 'wood_log', 2);

    sim.run(player, { type: 'craft', recipeId: 'craft_stick', count: 1 });
    expect(lastFailure(sim)).toMatch(/no room/);
    expect(player.craftQueue).toHaveLength(0);
    // Rejected before anything was reserved: both logs are still there.
    expect(countOf(player, 'wood_log')).toBe(2);
  });

  it('counts the space the reserved inputs free up before calling the pack full', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    // The log is the only thing in the last slot, so consuming it makes exactly the
    // room the four sticks need. Checking the inventory as it is rather than as it
    // will be would reject this craft, which would be wrong.
    sim.giveItem(player, 'stone_hatchet', player.inventory.capacity - 1);
    sim.giveItem(player, 'wood_log', 1);

    sim.run(player, { type: 'craft', recipeId: 'craft_stick', count: 1 });
    expect(player.craftQueue).toHaveLength(1);
    sim.step(60);
    expect(countOf(player, 'stick')).toBe(4);
  });

  it('rolls chance-gated outputs sometimes and not others', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    sim.giveItem(player, 'plant_fiber', 20);

    sim.run(player, { type: 'craft', recipeId: 'test_lucky_scrape', count: 20 });
    sim.step(20 * 20);

    expect(countOf(player, 'cloth_rag')).toBe(20);
    const flint = countOf(player, 'flint');
    expect(flint).toBeGreaterThan(2);
    expect(flint).toBeLessThan(18);
  });

  it('stamps quality on unstackable output and leaves stackables alone', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    sim.giveItem(player, 'stone', 1);
    sim.giveItem(player, 'stick', 1);
    sim.giveItem(player, 'plant_fiber', 3);

    sim.run(player, { type: 'craft', recipeId: 'craft_stone_hatchet', count: 1 });
    sim.step(160);

    const hatchet = player.inventory.slots.find((slot) => slot?.defId === 'stone_hatchet');
    expect(hatchet?.quality).toBeGreaterThan(0);
    expect(hatchet?.quality).toBeLessThanOrEqual(1);

    sim.giveItem(player, 'plant_fiber', 5);
    sim.run(player, { type: 'craft', recipeId: 'craft_rope', count: 1 });
    sim.step(80);
    const rope = player.inventory.slots.find((slot) => slot?.defId === 'rope');
    expect(rope?.quality).toBeUndefined();
  });

  it('makes better items in more practised hands', () => {
    const craftHatchet = (level: number): number => {
      const sim = makeSim({ seed: 99 });
      const player = sim.addPlayer();
      player.skills.crafting.level = level;
      sim.giveItem(player, 'stone', 1);
      sim.giveItem(player, 'stick', 1);
      sim.giveItem(player, 'plant_fiber', 3);
      sim.run(player, { type: 'craft', recipeId: 'craft_stone_hatchet', count: 1 });
      sim.step(200);
      const hatchet = player.inventory.slots.find((slot) => slot?.defId === 'stone_hatchet');
      return hatchet?.quality ?? -1;
    };

    const novice = craftHatchet(0);
    const master = craftHatchet(10);
    expect(novice).toBeGreaterThan(0);
    expect(master).toBeGreaterThan(novice);
  });
});

// ---------------------------------------------------------------------------
// canCraft and determinism
// ---------------------------------------------------------------------------

describe('canCraft', () => {
  it('agrees with what the command actually does', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    const rope = sim.data.recipes.require('craft_rope');

    expect(canCraft(sim.ctx, player, rope).ok).toBe(false);
    sim.run(player, { type: 'craft', recipeId: 'craft_rope', count: 1 });
    expect(player.craftQueue).toHaveLength(0);

    sim.giveItem(player, 'plant_fiber', 5);
    expect(canCraft(sim.ctx, player, rope).ok).toBe(true);
    sim.run(player, { type: 'craft', recipeId: 'craft_rope', count: 1 });
    expect(player.craftQueue).toHaveLength(1);
  });

  it('agrees about stations, reach and heat', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    const cook = sim.data.recipes.require('cook_meat');
    sim.giveItem(player, 'raw_meat', 1);

    expect(canCraft(sim.ctx, player, cook).reason).toMatch(/needs a campfire/);

    const far = placeStationBeside(sim, player, 'campfire', 12);
    expect(canCraft(sim.ctx, player, cook, far.id).reason).toMatch(/too far/);

    const near = placeStationBeside(sim, player, 'campfire', 1);
    expect(canCraft(sim.ctx, player, cook, near.id).reason).toMatch(/not lit/);

    if (near.station) {
      near.station.fuel = 1000;
      near.station.lit = true;
    }
    expect(canCraft(sim.ctx, player, cook, near.id).ok).toBe(true);

    sim.run(player, { type: 'craft', recipeId: 'cook_meat', count: 1, stationId: near.id });
    expect(near.station?.jobs).toHaveLength(1);
  });

  it('reports a full queue', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    sim.giveItem(player, 'plant_fiber', 50);
    const rope = sim.data.recipes.require('craft_rope');
    for (let i = 0; i < MAX_QUEUED_JOBS; i++) {
      sim.run(player, { type: 'craft', recipeId: 'craft_rope', count: 1 });
    }
    expect(canCraft(sim.ctx, player, rope).reason).toMatch(/queue is full/);
  });
});

describe('determinism', () => {
  it('produces identical results for the same seed and the same commands', () => {
    const run = () => {
      const sim = makeSim({ seed: 777 });
      const player = sim.addPlayer({ id: 'p1' });
      const furnace = placeStationBeside(sim, player, 'furnace');
      sim.giveItem(player, 'stone', 2);
      sim.giveItem(player, 'stick', 2);
      sim.giveItem(player, 'plant_fiber', 6);
      sim.giveItem(player, 'iron_ore', 4);
      sim.giveItem(player, 'wood_log', 2);
      sim.giveItem(player, 'lighter', 1);

      refuelFrom(sim, player, furnace, 'wood_log');
      waitForHands(sim, player);
      sim.run(player, { type: 'ignite', structureId: furnace.id });
      sim.run(player, { type: 'craft', recipeId: 'craft_stone_hatchet', count: 2 });
      sim.run(player, {
        type: 'craft',
        recipeId: 'smelt_iron_ingot',
        count: 2,
        stationId: furnace.id,
      });
      sim.step(1200);

      return {
        tick: sim.sim.state.tick,
        inventory: JSON.stringify(player.inventory.slots),
        fuel: furnace.station?.fuel,
        jobs: JSON.stringify(furnace.station?.jobs),
        events: sim.eventsOf('craftCompleted').map((event) => event.output),
      };
    };

    expect(run()).toEqual(run());
  });

  it('does not depend on the order players appear in the record', () => {
    const build = (ids: string[]) => {
      const sim = makeSim({ seed: 4242 });
      const players = ids.map((id) => {
        const player = sim.addPlayer({ id });
        sim.giveItem(player, 'stone', 1);
        sim.giveItem(player, 'stick', 1);
        sim.giveItem(player, 'plant_fiber', 3);
        sim.command(player, { type: 'craft', recipeId: 'craft_stone_hatchet', count: 1 });
        return player;
      });
      sim.step(200);
      return players
        .map((player) => {
          const hatchet = player.inventory.slots.find((slot) => slot?.defId === 'stone_hatchet');
          return `${player.id}:${hatchet?.quality ?? -1}`;
        })
        .sort()
        .join('|');
    };

    expect(build(['alpha', 'beta'])).toBe(build(['beta', 'alpha']));
  });
});
