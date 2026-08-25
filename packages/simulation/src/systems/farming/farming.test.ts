import { describe, expect, it } from 'vitest';
import {
  TICKS_PER_GAME_DAY,
  Tile,
  pixelToTile,
  tileCenter,
  type PlayerState,
  type StructureState,
} from '@survive/protocol';
import { CROP_DEFS, createGameData, type CropDef, type GameData } from '@survive/game-data';
import { DAYS_PER_SEASON, SEASONS, type Season } from '@survive/protocol';
import {
  TEMPERATURE_DIURNAL_AMPLITUDE_C,
  dailyTemperatureOffset,
  seasonalBaseTemperature,
} from '../time/weatherSystem';
import { seasonForDay } from '../time/timeSystem';

/** Any seed will do for the daily wobble: it is bounded, so the floor moves by at most its amplitude. */
const CLIMATE_PROBE_SEED = 1;
import { createTestSimulation, type TestSimulation } from '@survive/test-utils';
import {
  BLIGHT_CONTAGIOUS_AT,
  FARMLAND_WET_MOISTURE,
  blightRiskMultiplier,
  cropGrowthFraction,
  cropStageSprite,
  describePlot,
  evaporationRate,
  growthMultiplier,
  harvestYieldMultiplier,
  isCropHarvestable,
  matureStage,
  plotTileFor,
  rainfallRate,
  regrowthStage,
  stageTicks,
} from './crops';
import {
  FARM_ACTION_TICKS,
  FARM_REACH,
  FARM_TICK_STRIDE,
  MOISTURE_PER_FILL_UNIT,
  PLOT_INDEX_REFRESH_TICKS,
  canBeTilled,
  createFarmingSystem,
  plotBucket,
  sanitizePlot,
} from './farming';

/**
 * Farming, end to end.
 *
 * Everything here drives the real system through the real command router: a test asks
 * for `{ type: 'farm', action: 'plant' }` exactly as a client would, and asserts on the
 * plot's replicated state and the events that came out. Nothing pokes a private.
 *
 * Two deliberate conventions:
 *
 * - **Time is explicit.** These tests run farming *alone*, with no time or weather
 *   system, so `state.time` and `state.weather` hold whatever the test sets. That is
 *   the point: growth is a function of season, temperature, light and rain, and a test
 *   that cannot pin those down is testing the weather, not the crop.
 * - **`cropGrowthRate` is the fast-forward.** A real wheat crop takes five in-game days.
 *   Tests that care about the *growth curve* run at rate 1; tests that only need a
 *   mature plant to pick turn the knob up, which also exercises the knob.
 */

const SEED = 4242;

/** Ticks a plot is guaranteed to have been simulated at least once. */
const ONE_VISIT = FARM_TICK_STRIDE;

interface Bed {
  sim: TestSimulation;
  player: PlayerState;
  tileX: number;
  tileY: number;
  /** The farm plot, once one exists. */
  plot: StructureState;
}

interface SetupOptions {
  seed?: number;
  growthRate?: number;
  /** Structure to place. Omit to leave bare ground for a `till` test. */
  structure?: string | null;
  data?: GameData;
  season?: 'spring' | 'summer' | 'autumn' | 'winter';
  temperature?: number;
  lightLevel?: number;
}

/**
 * A player standing next to one farm plot.
 *
 * The plot is placed rather than tilled so that tests of the other five actions do not
 * all depend on `till` working; the `till` tests pass `structure: null` and dig their
 * own.
 */
function bed(options: SetupOptions = {}): Bed {
  const sim = createTestSimulation({
    seed: options.seed ?? SEED,
    systems: [createFarmingSystem()],
    data: options.data,
    config: (config) => {
      config.tuning.cropGrowthRate = options.growthRate ?? 1;
    },
  });
  const player = sim.addPlayer();
  if (options.season) sim.ctx.state.time.season = options.season;
  if (options.temperature !== undefined) sim.ctx.state.weather.temperature = options.temperature;
  if (options.lightLevel !== undefined) sim.ctx.state.time.lightLevel = options.lightLevel;

  const tileX = pixelToTile(player.x) + 1;
  const tileY = pixelToTile(player.y);

  const defId = options.structure === undefined ? 'farm_plot' : options.structure;
  let plot: StructureState | null = null;
  if (defId) {
    plot = sim.placeStructure(defId, tileX, tileY, 0, player.id);
    if (!plot) throw new Error(`could not place ${defId}`);
    // `placeStructure` bypasses `till`, which is what paints the soil.
    sim.world.setTile(tileX, tileY, Tile.FarmlandDry);
  }

  return { sim, player, tileX, tileY, plot: plot as StructureState };
}

/** Send a `farm` command, stepping past the action cooldown first. */
function farm(
  b: Bed,
  action: 'till' | 'plant' | 'water' | 'fertilize' | 'harvest' | 'clear',
  seedDefId?: string,
): ReturnType<TestSimulation['run']> {
  b.sim.step(FARM_ACTION_TICKS);
  b.sim.clearEvents();
  return b.sim.run(b.player, {
    type: 'farm',
    action,
    tileX: b.tileX,
    tileY: b.tileY,
    ...(seedDefId ? { seedDefId } : {}),
  });
}

/** The reason string of the rejection this command produced, or undefined. */
function rejection(events: ReturnType<TestSimulation['run']>): string | undefined {
  for (const event of events) {
    if (event.type === 'commandRejected') return event.reason;
  }
  return undefined;
}

function crop(b: Bed) {
  const state = b.plot.plot?.crop;
  if (!state) throw new Error('no crop in the plot');
  return state;
}

/** How many of a definition the player is carrying. */
function countOf(player: PlayerState, defId: string): number {
  let total = 0;
  for (const slot of player.inventory.slots) if (slot?.defId === defId) total += slot.count;
  return total;
}

function soil(b: Bed) {
  const state = b.plot.plot;
  if (!state) throw new Error('structure has no plot');
  return state;
}

/**
 * The player's actual stack of an item.
 *
 * `giveItem` copies the stack it returns into the inventory, so a test that wants to
 * fill a can or watch a bottle drain has to reach for the stored one.
 */
function held(b: Bed, defId: string) {
  for (const slot of b.player.inventory.slots) {
    if (slot?.defId === defId) return slot;
  }
  throw new Error(`the player is not carrying ${defId}`);
}

/** Rain hard enough to keep any plot saturated, so a growth test is not a water test. */
function makeItRain(b: Bed): void {
  b.sim.ctx.state.weather.type = 'rain';
  b.sim.ctx.state.weather.intensity = 1;
}

/** Step until the crop reaches its final stage, or give up. Returns ticks spent. */
function growToMaturity(b: Bed, def: CropDef, limitTicks = 200_000): number {
  const mature = matureStage(def);
  let spent = 0;
  while ((b.plot.plot?.crop?.stage ?? -1) < mature && spent < limitTicks) {
    b.sim.step(ONE_VISIT);
    spent += ONE_VISIT;
  }
  return spent;
}

/** Plant a crop and fast-forward it to pickable, the boring way. */
function readyToHarvest(b: Bed, cropId: string): CropDef {
  const def = b.sim.data.crops.require(cropId);
  b.sim.giveItem(b.player, def.seedDefId, 1);
  makeItRain(b);
  farm(b, 'plant', def.seedDefId);
  growToMaturity(b, def);
  return def;
}

/** Game data with one crop's blight chance turned up so it is testable in a few ticks. */
function blightyData(cropId: string, chance: number): GameData {
  return createGameData({
    crops: CROP_DEFS.map((def) => (def.id === cropId ? { ...def, blightChance: chance } : def)),
  });
}

/**
 * Game data in which one crop cannot catch blight.
 *
 * Used by the drought tests: the death *reason* is the thing under test there, and a
 * stray blight roll would flip it from `drought` to `blight` and make the assertion a
 * lie about what killed the plant.
 */
function blightFreeData(cropId: string): GameData {
  return blightyData(cropId, 0);
}

// ---------------------------------------------------------------------------
// till
// ---------------------------------------------------------------------------

describe('farm till', () => {
  it('turns tillable ground into a farm plot', () => {
    const b = bed({ structure: null });
    b.sim.equip(b.player, 'hoe');
    expect(b.sim.world.getTile(b.tileX, b.tileY)).toBe(Tile.Grass);

    const events = farm(b, 'till');

    const tilled = events.find((event) => event.type === 'plotTilled');
    expect(tilled).toBeDefined();
    const structure = b.sim.ctx.state.structures[tilled!.structureId];
    expect(structure?.defId).toBe('farm_plot');
    expect(structure?.plot?.tilled).toBe(true);
    expect(structure?.ownerId).toBe(b.player.id);
    // A fresh plot starts at 40 moisture, which must read as dry soil.
    expect(b.sim.world.getTile(b.tileX, b.tileY)).toBe(Tile.FarmlandDry);
    expect(events.some((event) => event.type === 'structurePlaced')).toBe(true);
  });

  it('costs hoe durability and grants farming xp', () => {
    const b = bed({ structure: null });
    const hoe = b.sim.equip(b.player, 'hoe');
    const before = hoe.durability ?? 0;

    const events = farm(b, 'till');

    expect(hoe.durability).toBeLessThan(before);
    const xp = events.find((event) => event.type === 'skillXp');
    expect(xp?.skill).toBe('farming');
    expect(xp?.amount).toBeGreaterThan(0);
  });

  it('makes a noise a zombie could hear', () => {
    const b = bed({ structure: null });
    b.sim.equip(b.player, 'hoe');
    const noise = farm(b, 'till').find((event) => event.type === 'noise');
    expect(noise?.radius).toBeGreaterThan(0);
    expect(noise?.sourceId).toBe(b.player.id);
  });

  it('refuses without a hoe', () => {
    const b = bed({ structure: null });
    expect(rejection(farm(b, 'till'))).toMatch(/hoe/i);
    expect(b.sim.world.getTile(b.tileX, b.tileY)).toBe(Tile.Grass);
    expect(Object.keys(b.sim.ctx.state.structures)).toHaveLength(0);
  });

  it('refuses ground that cannot be tilled', () => {
    const b = bed({ structure: null });
    b.sim.equip(b.player, 'hoe');
    b.sim.world.setTile(b.tileX, b.tileY, Tile.StoneGround);
    expect(rejection(farm(b, 'till'))).toMatch(/cannot be tilled/i);
  });

  it('refuses to hoe through a structure that is not a plot', () => {
    const b = bed({ structure: 'wall_wood' });
    b.sim.equip(b.player, 'hoe');
    b.sim.world.setTile(b.tileX, b.tileY, Tile.Grass);
    expect(rejection(farm(b, 'till'))).toMatch(/already built/i);
    expect(b.sim.ctx.state.structures[b.plot.id]?.defId).toBe('wall_wood');
  });

  it('refuses a plot that is already tilled, and tills one that is not', () => {
    const b = bed();
    b.sim.equip(b.player, 'hoe');
    expect(rejection(farm(b, 'till'))).toMatch(/already tilled/i);

    // A plot restored from an older save can arrive untilled; the hoe fixes it.
    soil(b).tilled = false;
    const events = farm(b, 'till');
    expect(rejection(events)).toBeUndefined();
    expect(soil(b).tilled).toBe(true);
    expect(events.some((event) => event.type === 'plotTilled')).toBe(true);
  });

  it('re-tills farmland whose plot has been destroyed', () => {
    const b = bed();
    b.sim.equip(b.player, 'hoe');
    // A zombie ate the planter: the soil tile survives, the structure does not.
    delete b.sim.ctx.state.structures[b.plot.id];
    delete b.sim.ctx.state.structureTiles[`${b.tileX},${b.tileY}`];
    expect(canBeTilled(b.sim.world.getTile(b.tileX, b.tileY))).toBe(true);

    const events = farm(b, 'till');

    expect(rejection(events)).toBeUndefined();
    const tilled = events.find((event) => event.type === 'plotTilled');
    expect(tilled).toBeDefined();
    b.plot = b.sim.ctx.state.structures[tilled!.structureId] as StructureState;
    b.sim.giveItem(b.player, 'seed_wheat', 1);
    expect(rejection(farm(b, 'plant', 'seed_wheat'))).toBeUndefined();
  });

  it('starts simulating a plot tilled long after the index was first built', () => {
    const b = bed({ structure: null, season: 'spring' });
    b.sim.equip(b.player, 'hoe');
    // Let the cached plot list settle on an empty world first.
    b.sim.step(PLOT_INDEX_REFRESH_TICKS * 2);

    farm(b, 'till');
    b.plot = b.sim.ctx.state.structures[
      b.sim.lastEvent('plotTilled')!.structureId
    ] as StructureState;
    b.sim.giveItem(b.player, 'seed_wheat', 1);
    farm(b, 'plant', 'seed_wheat');
    const moisture = soil(b).moisture;

    b.sim.step(ONE_VISIT * 3);

    // If the new plot were still missing from the index nothing about it would move.
    expect(soil(b).moisture).toBeLessThan(moisture);
  });

  it('refuses a tile out of reach', () => {
    const b = bed({ structure: null });
    b.sim.equip(b.player, 'hoe');
    const far = { ...b, tileX: b.tileX + 8 };
    expect(rejection(farm(far, 'till'))).toMatch(/too far/i);
    // Sanity: the rejection is about distance, not about the tile.
    expect(
      Math.hypot(b.player.x - tileCenter(far.tileX), b.player.y - tileCenter(far.tileY)),
    ).toBeGreaterThan(FARM_REACH);
  });

  it('refuses a dead player', () => {
    const b = bed({ structure: null });
    b.sim.equip(b.player, 'hoe');
    b.player.alive = false;
    expect(rejection(farm(b, 'till'))).toMatch(/dead/i);
  });

  it('enforces the action cooldown', () => {
    const b = bed({ structure: null });
    b.sim.equip(b.player, 'hoe');
    farm(b, 'till');
    // No `step` this time: the cooldown from the till is still running.
    const events = b.sim.run(b.player, {
      type: 'farm',
      action: 'water',
      tileX: b.tileX,
      tileY: b.tileY,
    });
    expect(rejection(events)).toMatch(/busy/i);
  });

  it('refuses a non-integer tile', () => {
    const b = bed({ structure: null });
    b.sim.equip(b.player, 'hoe');
    const events = b.sim.run(b.player, {
      type: 'farm',
      action: 'till',
      tileX: b.tileX + 0.5,
      tileY: b.tileY,
    });
    expect(rejection(events)).toMatch(/tile/i);
  });
});

// ---------------------------------------------------------------------------
// plant
// ---------------------------------------------------------------------------

describe('farm plant', () => {
  it('sows a seed, consuming exactly one', () => {
    const b = bed({ season: 'spring' });
    b.sim.giveItem(b.player, 'seed_wheat', 4);

    const events = farm(b, 'plant', 'seed_wheat');

    expect(events.find((event) => event.type === 'cropPlanted')?.cropDefId).toBe('wheat');
    expect(crop(b).stage).toBe(0);
    expect(crop(b).health).toBe(100);
    expect(crop(b).dead).toBe(false);
    expect(crop(b).harvestsLeft).toBe(1);
    expect(seedCount(b, 'seed_wheat')).toBe(3);
  });

  it('finds a seed in the pack when no seed id is given', () => {
    const b = bed({ season: 'spring' });
    b.sim.giveItem(b.player, 'seed_carrot', 1);
    expect(rejection(farm(b, 'plant'))).toBeUndefined();
    expect(crop(b).defId).toBe('carrot');
  });

  it('reaches past an out-of-season seed for one that will actually grow', () => {
    const b = bed({ season: 'winter' });
    // Corn sits in an earlier slot, but only cabbage grows in winter.
    b.sim.giveItem(b.player, 'seed_corn', 1);
    b.sim.giveItem(b.player, 'seed_cabbage', 1);

    expect(rejection(farm(b, 'plant'))).toBeUndefined();
    expect(crop(b).defId).toBe('cabbage');
    expect(seedCount(b, 'seed_corn')).toBe(1);
  });

  it('names the crop it tried when nothing in the pack is in season', () => {
    const b = bed({ season: 'winter' });
    b.sim.giveItem(b.player, 'seed_corn', 1);
    expect(rejection(farm(b, 'plant'))).toMatch(/corn/i);
  });

  it('rejects a player carrying no seeds at all', () => {
    const b = bed({ season: 'spring' });
    expect(rejection(farm(b, 'plant'))).toMatch(/no seed selected/i);
  });

  it('rejects a crop that will not grow this season', () => {
    const b = bed({ season: 'winter' });
    b.sim.giveItem(b.player, 'seed_corn', 1);

    const reason = rejection(farm(b, 'plant', 'seed_corn'));

    expect(reason).toMatch(/winter/i);
    expect(reason).toMatch(/summer/i);
    expect(soil(b).crop).toBeUndefined();
    // The seed is not eaten by a rejected command.
    expect(seedCount(b, 'seed_corn')).toBe(1);
  });

  it('rejects untilled ground', () => {
    const b = bed();
    soil(b).tilled = false;
    b.sim.giveItem(b.player, 'seed_wheat', 1);
    expect(rejection(farm(b, 'plant', 'seed_wheat'))).toMatch(/not tilled/i);
    expect(soil(b).crop).toBeUndefined();
  });

  it('rejects bare ground with no plot at all', () => {
    const b = bed({ structure: null });
    b.sim.giveItem(b.player, 'seed_wheat', 1);
    expect(rejection(farm(b, 'plant', 'seed_wheat'))).toMatch(/no plot/i);
  });

  it('rejects a seed the player does not have', () => {
    const b = bed();
    expect(rejection(farm(b, 'plant', 'seed_wheat'))).toMatch(/you have no/i);
    expect(soil(b).crop).toBeUndefined();
  });

  it('rejects an item that is not a seed', () => {
    const b = bed();
    b.sim.giveItem(b.player, 'wood_log', 1);
    expect(rejection(farm(b, 'plant', 'wood_log'))).toMatch(/not a seed/i);
  });

  it('rejects an unknown item id', () => {
    const b = bed();
    expect(rejection(farm(b, 'plant', 'seed_of_doubt'))).toMatch(/unknown seed/i);
  });

  it('rejects a plot that is already occupied', () => {
    const b = bed({ season: 'spring' });
    b.sim.giveItem(b.player, 'seed_wheat', 2);
    farm(b, 'plant', 'seed_wheat');
    expect(rejection(farm(b, 'plant', 'seed_wheat'))).toMatch(/already growing/i);
    expect(seedCount(b, 'seed_wheat')).toBe(1);
  });

  it('tells the player to clear a dead crop rather than that something is growing', () => {
    const b = bed({ season: 'spring' });
    b.sim.giveItem(b.player, 'seed_wheat', 2);
    farm(b, 'plant', 'seed_wheat');
    crop(b).dead = true;

    // The fix is `clear`, so the reason has to name it - and the seed stays in the pack.
    expect(rejection(farm(b, 'plant', 'seed_wheat'))).toMatch(/clear/i);
    expect(seedCount(b, 'seed_wheat')).toBe(1);
  });
});

function seedCount(b: Bed, defId: string): number {
  let total = 0;
  for (const slot of b.player.inventory.slots) {
    if (slot?.defId === defId) total += slot.count;
  }
  for (const slot of Object.values(b.player.equipment)) {
    if (slot?.defId === defId) total += slot.count;
  }
  return total;
}

// ---------------------------------------------------------------------------
// water
// ---------------------------------------------------------------------------

describe('farm water', () => {
  it('raises moisture, spends one fill and wets the soil', () => {
    const b = bed();
    const can = b.sim.equip(b.player, 'watering_can');
    can.fill = 20;
    const before = soil(b).moisture;

    const events = farm(b, 'water');

    const watered = events.find((event) => event.type === 'cropWatered');
    expect(watered?.moisture).toBeCloseTo(before + MOISTURE_PER_FILL_UNIT, 1);
    expect(soil(b).moisture).toBeGreaterThan(before);
    expect(can.fill).toBe(19);
    expect(b.sim.world.getTile(b.tileX, b.tileY)).toBe(Tile.FarmlandWet);
  });

  it('accepts a plain water vessel when there is no can', () => {
    const b = bed();
    b.sim.giveItem(b.player, 'water_bottle', 1);
    const bottle = held(b, 'water_bottle');
    expect(bottle.fill).toBe(4);

    farm(b, 'water');

    expect(soil(b).moisture).toBeGreaterThan(40);
    expect(bottle.fill).toBe(3);
  });

  it('prefers the watering can over drinking water', () => {
    const b = bed();
    const can = b.sim.equip(b.player, 'watering_can');
    can.fill = 5;
    b.sim.giveItem(b.player, 'water_bottle', 1);
    const bottle = held(b, 'water_bottle');

    farm(b, 'water');

    expect(can.fill).toBe(4);
    expect(bottle.fill).toBe(4);
  });

  it('rejects an empty can', () => {
    const b = bed();
    const can = b.sim.equip(b.player, 'watering_can');
    can.fill = 0;
    expect(rejection(farm(b, 'water'))).toMatch(/watering can|vessel/i);
    expect(soil(b).moisture).toBe(40);
  });

  it('rejects soil that is already soaked', () => {
    const b = bed();
    soil(b).moisture = 100;
    const can = b.sim.equip(b.player, 'watering_can');
    can.fill = 20;
    expect(rejection(farm(b, 'water'))).toMatch(/soaked/i);
    expect(can.fill).toBe(20);
  });

  it('rejects a tile with no plot', () => {
    const b = bed({ structure: null });
    const can = b.sim.equip(b.player, 'watering_can');
    can.fill = 20;
    expect(rejection(farm(b, 'water'))).toMatch(/no plot/i);
  });

  it('lets rain do the watering with no can at all', () => {
    const b = bed({ season: 'spring' });
    b.sim.giveItem(b.player, 'seed_wheat', 1);
    farm(b, 'plant', 'seed_wheat');
    soil(b).moisture = 5;
    makeItRain(b);

    b.sim.step(TICKS_PER_GAME_DAY / 12);

    expect(soil(b).moisture).toBeGreaterThan(FARMLAND_WET_MOISTURE);
    expect(b.sim.world.getTile(b.tileX, b.tileY)).toBe(Tile.FarmlandWet);
  });

  it('does not let snow water a frozen plot', () => {
    const snow = {
      type: 'snow' as const,
      intensity: 1,
      temperature: -5,
      windAngle: 0,
      windSpeed: 0,
      nextChangeTick: 0,
      lightning: false,
    };
    // Frozen water is not water. Above freezing the same fall melts into the soil.
    expect(rainfallRate(snow)).toBe(0);
    expect(rainfallRate({ ...snow, temperature: 3 })).toBeGreaterThan(0);
    // Even melting, snow is a trickle beside real rain.
    expect(rainfallRate({ ...snow, temperature: 3 })).toBeLessThan(
      rainfallRate({ ...snow, type: 'rain' }) / 4,
    );

    // So a winter crop under a blizzard still dries out and still needs the can.
    const b = bed({ season: 'winter', temperature: -5 });
    b.sim.ctx.state.weather.type = 'snow';
    b.sim.ctx.state.weather.intensity = 1;
    b.sim.giveItem(b.player, 'seed_cabbage', 1);
    farm(b, 'plant', 'seed_cabbage');
    const before = soil(b).moisture;

    b.sim.step(TICKS_PER_GAME_DAY);

    expect(soil(b).moisture).toBeLessThan(before);
  });

  it('dries a plot out under a clear sky', () => {
    const b = bed({ season: 'spring' });
    b.sim.giveItem(b.player, 'seed_wheat', 1);
    farm(b, 'plant', 'seed_wheat');
    const before = soil(b).moisture;

    b.sim.step(TICKS_PER_GAME_DAY);

    expect(soil(b).moisture).toBeLessThan(before);
  });
});

// ---------------------------------------------------------------------------
// fertilize
// ---------------------------------------------------------------------------

describe('farm fertilize', () => {
  it('restores fertility and boosts the standing crop', () => {
    const b = bed({ season: 'spring' });
    b.sim.giveItem(b.player, 'seed_wheat', 1);
    farm(b, 'plant', 'seed_wheat');
    soil(b).fertility = 40;
    b.sim.giveItem(b.player, 'fertilizer', 2);

    const events = farm(b, 'fertilize');

    expect(events.some((event) => event.type === 'cropFertilized')).toBe(true);
    expect(soil(b).fertility).toBeGreaterThan(40);
    expect(crop(b).fertilizedTicks).toBeGreaterThan(0);
    expect(seedCount(b, 'fertilizer')).toBe(1);
  });

  it('works on an empty plot, because fertility is the soil not the plant', () => {
    const b = bed();
    soil(b).fertility = 10;
    b.sim.giveItem(b.player, 'compost', 1);

    farm(b, 'fertilize');

    expect(soil(b).fertility).toBeGreaterThan(10);
  });

  it('never pushes fertility past what the plot type supports', () => {
    const b = bed();
    soil(b).fertility = 99;
    b.sim.giveItem(b.player, 'fertilizer', 1);
    farm(b, 'fertilize');
    expect(soil(b).fertility).toBeLessThanOrEqual(100);
  });

  it('rejects a player with no fertilizer', () => {
    const b = bed();
    soil(b).fertility = 10;
    expect(rejection(farm(b, 'fertilize'))).toMatch(/no fertilizer/i);
  });

  it('rejects soil that needs nothing', () => {
    const b = bed();
    b.sim.giveItem(b.player, 'fertilizer', 1);
    expect(rejection(farm(b, 'fertilize'))).toMatch(/needs nothing/i);
    expect(seedCount(b, 'fertilizer')).toBe(1);
  });

  it('speeds growth up measurably', () => {
    const measure = (fertilized: boolean): number => {
      const b = bed({ season: 'spring', growthRate: 2 });
      makeItRain(b);
      b.sim.giveItem(b.player, 'seed_wheat', 1);
      farm(b, 'plant', 'seed_wheat');
      if (fertilized) {
        b.sim.giveItem(b.player, 'fertilizer', 1);
        // Fertility is equalised afterwards so this measures the growth burst only,
        // not the (separate) fertility contribution.
        farm(b, 'fertilize');
        soil(b).fertility = 100;
      }
      b.sim.step(TICKS_PER_GAME_DAY / 4);
      const def = b.sim.data.crops.require('wheat');
      return cropGrowthFraction(crop(b), def);
    };

    expect(measure(true)).toBeGreaterThan(measure(false));
  });
});

// ---------------------------------------------------------------------------
// growth
// ---------------------------------------------------------------------------

describe('crop growth', () => {
  it('runs the whole loop: till, plant, water, grow, harvest', () => {
    const b = bed({ structure: null, season: 'spring', growthRate: 60 });
    b.sim.equip(b.player, 'hoe');
    b.sim.giveItem(b.player, 'seed_wheat', 1);
    b.sim.giveItem(b.player, 'watering_can', 1);
    held(b, 'watering_can').fill = 20;

    farm(b, 'till');
    const tilled = b.sim.lastEvent('plotTilled');
    expect(tilled).toBeDefined();
    const structure = b.sim.ctx.state.structures[tilled!.structureId];
    expect(structure).toBeDefined();
    b.plot = structure as StructureState;

    farm(b, 'plant', 'seed_wheat');
    farm(b, 'water');
    expect(soil(b).moisture).toBeGreaterThan(FARMLAND_WET_MOISTURE);

    const def = b.sim.data.crops.require('wheat');
    const spent = growToMaturity(b, def);
    expect(spent).toBeLessThan(200_000);
    expect(isCropHarvestable(crop(b), def)).toBe(true);
    expect(b.sim.eventsOf('cropStageAdvanced').length).toBeGreaterThanOrEqual(def.stages - 1);

    const events = farm(b, 'harvest');
    const harvested = events.find((event) => event.type === 'cropHarvested');
    expect(harvested).toBeDefined();
    expect(harvested!.playerId).toBe(b.player.id);

    const produce = harvested!.yields.find((stack) => stack.defId === 'wheat');
    expect(produce?.count).toBeGreaterThanOrEqual(def.yieldMin);
    expect(seedCount(b, 'seed_wheat')).toBeGreaterThanOrEqual(def.seedYield[0]);
    expect(soil(b).crop).toBeUndefined();
    expect(b.player.stats.cropsHarvested).toBe(1);
  });

  it('emits one stage event per transition, in order', () => {
    const b = bed({ season: 'spring', growthRate: 300 });
    makeItRain(b);
    const def = readyToHarvest(b, 'wheat');

    const stages = b.sim.eventsOf('cropStageAdvanced').map((event) => event.stage);
    expect(stages).toEqual([1, 2, 3, 4]);
    expect(stages).toHaveLength(def.stages - 1);
  });

  it('honours the cropGrowthRate tuning knob', () => {
    const progressAfter = (rate: number): number => {
      const b = bed({ season: 'spring', growthRate: rate });
      makeItRain(b);
      b.sim.giveItem(b.player, 'seed_wheat', 1);
      farm(b, 'plant', 'seed_wheat');
      b.sim.step(TICKS_PER_GAME_DAY / 4);
      return cropGrowthFraction(crop(b), b.sim.data.crops.require('wheat'));
    };

    const slow = progressAfter(1);
    const fast = progressAfter(4);
    expect(slow).toBeGreaterThan(0);
    expect(fast).toBeGreaterThan(slow * 3);

    // Rate zero is a stall, not a crash.
    expect(progressAfter(0)).toBe(0);
  });

  it('stalls outside the crop season without killing the plant', () => {
    const b = bed({ season: 'spring', growthRate: 200 });
    makeItRain(b);
    b.sim.giveItem(b.player, 'seed_wheat', 1);
    farm(b, 'plant', 'seed_wheat');
    b.sim.ctx.state.time.season = 'winter';
    b.sim.ctx.state.weather.temperature = 15;

    b.sim.step(TICKS_PER_GAME_DAY / 2);

    expect(crop(b).stage).toBe(0);
    expect(crop(b).stageProgress).toBe(0);
    expect(crop(b).dead).toBe(false);
  });

  it('stalls outside the ideal temperature band', () => {
    const b = bed({ season: 'spring', growthRate: 200 });
    makeItRain(b);
    b.sim.giveItem(b.player, 'seed_wheat', 1);
    farm(b, 'plant', 'seed_wheat');
    // Above wheat's ideal ceiling of 28, but well clear of its frost point.
    b.sim.ctx.state.weather.temperature = 40;

    b.sim.step(TICKS_PER_GAME_DAY / 2);

    expect(crop(b).stageProgress).toBe(0);
    expect(crop(b).dead).toBe(false);
  });

  it('grows faster in daylight than in the dark', () => {
    const progressAfter = (lightLevel: number): number => {
      const b = bed({ season: 'spring', growthRate: 20, lightLevel });
      makeItRain(b);
      b.sim.giveItem(b.player, 'seed_wheat', 1);
      farm(b, 'plant', 'seed_wheat');
      b.sim.step(TICKS_PER_GAME_DAY / 8);
      return cropGrowthFraction(crop(b), b.sim.data.crops.require('wheat'));
    };
    expect(progressAfter(1)).toBeGreaterThan(progressAfter(0));
  });
});

// ---------------------------------------------------------------------------
// health, drought and frost
// ---------------------------------------------------------------------------

describe('crop health', () => {
  it('stalls a thirsty crop and then kills it', () => {
    const b = bed({ season: 'spring', growthRate: 1, data: blightFreeData('wheat') });
    b.sim.giveItem(b.player, 'seed_wheat', 1);
    farm(b, 'plant', 'seed_wheat');
    const def = b.sim.data.crops.require('wheat');

    // Run dry: no rain, no can.
    let guard = 0;
    while (soil(b).moisture >= def.minMoisture && guard < 40) {
      b.sim.step(TICKS_PER_GAME_DAY / 4);
      guard++;
    }
    expect(soil(b).moisture).toBeLessThan(def.minMoisture);

    const stalledAt = cropGrowthFraction(crop(b), def);
    const healthAtStall = crop(b).health;
    b.sim.step(TICKS_PER_GAME_DAY / 4);
    expect(cropGrowthFraction(crop(b), def)).toBeCloseTo(stalledAt, 5);
    expect(crop(b).health).toBeLessThan(healthAtStall);

    const died = pushToDeath(b);
    expect(died?.reason).toBe('drought');
    expect(crop(b).dead).toBe(true);
    expect(crop(b).health).toBe(0);
  });

  it('recovers health when conditions come good again', () => {
    const b = bed({ season: 'spring' });
    b.sim.giveItem(b.player, 'seed_wheat', 1);
    farm(b, 'plant', 'seed_wheat');
    crop(b).health = 40;
    makeItRain(b);

    b.sim.step(TICKS_PER_GAME_DAY / 2);

    expect(crop(b).health).toBeGreaterThan(40);
    expect(crop(b).dead).toBe(false);
  });

  it('lets a frost kill a winter crop outright', () => {
    const b = bed({ season: 'winter', temperature: 6, growthRate: 20 });
    makeItRain(b);
    b.sim.giveItem(b.player, 'seed_cabbage', 1);
    farm(b, 'plant', 'seed_cabbage');
    b.sim.step(ONE_VISIT * 4);
    expect(crop(b).dead).toBe(false);
    expect(crop(b).health).toBe(100);

    // A hard frost: below cabbage's -8 tolerance.
    b.sim.ctx.state.weather.temperature = -12;
    b.sim.clearEvents();
    b.sim.step(ONE_VISIT * 2);

    const died = b.sim.lastEvent('cropDied');
    expect(died?.reason).toBe('frost');
    expect(crop(b).dead).toBe(true);
    // Full health the tick before: frost is an event, not a drain.
    expect(b.sim.eventsOf('cropDied')).toHaveLength(1);
  });

  it('spares a hardy crop a frost that would kill a tender one', () => {
    const cabbage = CROP_DEFS.find((def) => def.id === 'cabbage');
    const tomato = CROP_DEFS.find((def) => def.id === 'tomato');
    expect(cabbage?.frostTemperature).toBeLessThan(tomato?.frostTemperature ?? 0);

    const b = bed({ season: 'winter', temperature: -6, growthRate: 20 });
    makeItRain(b);
    b.sim.giveItem(b.player, 'seed_cabbage', 1);
    farm(b, 'plant', 'seed_cabbage');
    b.sim.step(TICKS_PER_GAME_DAY / 4);
    expect(crop(b).dead).toBe(false);
  });

  it('stops simulating a dead crop', () => {
    const b = bed({ season: 'spring' });
    b.sim.giveItem(b.player, 'seed_wheat', 1);
    farm(b, 'plant', 'seed_wheat');
    crop(b).dead = true;
    crop(b).health = 0;
    const stage = crop(b).stage;
    makeItRain(b);

    b.sim.step(TICKS_PER_GAME_DAY);

    expect(crop(b).stage).toBe(stage);
    expect(crop(b).health).toBe(0);
    expect(b.sim.eventsOf('cropDied')).toHaveLength(0);
  });
});

/** Step until the crop dies, or give up. Returns the death event. */
function pushToDeath(b: Bed, limitTicks = 20 * TICKS_PER_GAME_DAY) {
  let spent = 0;
  while (!(b.plot.plot?.crop?.dead ?? true) && spent < limitTicks) {
    b.sim.step(TICKS_PER_GAME_DAY / 8);
    spent += TICKS_PER_GAME_DAY / 8;
  }
  return b.sim.lastEvent('cropDied');
}

// ---------------------------------------------------------------------------
// harvest
// ---------------------------------------------------------------------------

describe('farm harvest', () => {
  it('returns produce and seeds and depletes the soil', () => {
    const b = bed({ season: 'spring', growthRate: 300 });
    const def = readyToHarvest(b, 'wheat');
    const fertilityBefore = soil(b).fertility;

    const events = farm(b, 'harvest');
    const harvested = events.find((event) => event.type === 'cropHarvested');

    expect(harvested).toBeDefined();
    expect(harvested!.yields.some((stack) => stack.defId === 'wheat')).toBe(true);
    expect(harvested!.yields.some((stack) => stack.defId === 'seed_wheat')).toBe(true);
    expect(soil(b).fertility).toBeCloseTo(fertilityBefore - def.fertilityCost, 3);
    expect(events.find((event) => event.type === 'skillXp')?.amount).toBe(def.xpPerHarvest);
  });

  it('scales the yield with the farming skill', () => {
    const yieldAt = (level: number): number => {
      const b = bed({ season: 'spring', growthRate: 300 });
      b.player.skills.farming.level = level;
      readyToHarvest(b, 'wheat');
      const events = farm(b, 'harvest');
      return produceOf(events, 'wheat');
    };

    expect(yieldAt(18)).toBeGreaterThan(yieldAt(0));
  });

  it('scales the yield with soil fertility', () => {
    const yieldAt = (fertility: number): number => {
      const b = bed({ season: 'spring', growthRate: 300 });
      readyToHarvest(b, 'wheat');
      soil(b).fertility = fertility;
      const events = farm(b, 'harvest');
      return produceOf(events, 'wheat');
    };

    expect(yieldAt(100)).toBeGreaterThan(yieldAt(0));
  });

  it('scales the yield with plant health', () => {
    const yieldAt = (health: number): number => {
      const b = bed({ season: 'spring', growthRate: 300 });
      readyToHarvest(b, 'wheat');
      crop(b).health = health;
      const events = farm(b, 'harvest');
      return produceOf(events, 'wheat');
    };

    expect(yieldAt(100)).toBeGreaterThan(yieldAt(10));
  });

  it('is deterministic for a given world seed', () => {
    const run = (): number[] => {
      const b = bed({ seed: 909, season: 'spring', growthRate: 300 });
      readyToHarvest(b, 'wheat');
      const events = farm(b, 'harvest');
      const harvested = events.find((event) => event.type === 'cropHarvested');
      return (harvested?.yields ?? []).map((stack) => stack.count);
    };

    const first = run();
    expect(first.length).toBeGreaterThan(0);
    expect(run()).toEqual(first);
    expect(run()).toEqual(first);
  });

  it('drops produce at the player when the pack is full', () => {
    const b = bed({ season: 'spring', growthRate: 300 });
    readyToHarvest(b, 'wheat');
    for (let i = 0; i < b.player.inventory.slots.length; i++) {
      b.player.inventory.slots[i] = { defId: 'stone', count: 1 };
    }

    farm(b, 'harvest');

    const dropped = Object.values(b.sim.ctx.state.items);
    expect(dropped.some((item) => item.stack.defId === 'wheat')).toBe(true);
  });

  it('picks a regrowing crop repeatedly and then finishes it', () => {
    const b = bed({ season: 'summer', temperature: 24, growthRate: 400 });
    const def = readyToHarvest(b, 'tomato');
    expect(def.regrows).toBe(true);
    expect(crop(b).harvestsLeft).toBe(def.harvestsPerPlant);

    for (let picking = def.harvestsPerPlant; picking > 1; picking--) {
      const events = farm(b, 'harvest');
      expect(rejection(events)).toBeUndefined();
      // The plant survives, one stage short of fruiting again.
      expect(soil(b).crop).toBeDefined();
      expect(crop(b).harvestsLeft).toBe(picking - 1);
      expect(crop(b).stage).toBe(regrowthStage(def));
      // ...and it will not give a second helping until it has grown back.
      expect(rejection(farm(b, 'harvest'))).toMatch(/not ready/i);
      growToMaturity(b, def);
    }

    const last = farm(b, 'harvest');
    expect(rejection(last)).toBeUndefined();
    expect(soil(b).crop).toBeUndefined();
    expect(b.player.stats.cropsHarvested).toBe(def.harvestsPerPlant);
  });

  it('rejects a crop that is not ready', () => {
    const b = bed({ season: 'spring' });
    b.sim.giveItem(b.player, 'seed_wheat', 1);
    farm(b, 'plant', 'seed_wheat');
    expect(rejection(farm(b, 'harvest'))).toMatch(/not ready/i);
    expect(soil(b).crop).toBeDefined();
  });

  it('rejects an empty plot and a dead crop', () => {
    const b = bed({ season: 'spring' });
    expect(rejection(farm(b, 'harvest'))).toMatch(/nothing is growing/i);

    b.sim.giveItem(b.player, 'seed_wheat', 1);
    farm(b, 'plant', 'seed_wheat');
    crop(b).dead = true;
    expect(rejection(farm(b, 'harvest'))).toMatch(/dead/i);
  });

  it('rejects a tile with no plot', () => {
    const b = bed({ structure: null });
    expect(rejection(farm(b, 'harvest'))).toMatch(/no plot/i);
  });
});

function produceOf(events: ReturnType<TestSimulation['run']>, defId: string): number {
  for (const event of events) {
    if (event.type !== 'cropHarvested') continue;
    for (const stack of event.yields) if (stack.defId === defId) return stack.count;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// blight
// ---------------------------------------------------------------------------

describe('blight', () => {
  it('appears on its own and is announced', () => {
    const b = bed({ season: 'spring', data: blightyData('wheat', 2e-3) });
    makeItRain(b);
    b.sim.giveItem(b.player, 'seed_wheat', 1);
    farm(b, 'plant', 'seed_wheat');
    b.sim.clearEvents();

    b.sim.step(TICKS_PER_GAME_DAY / 8);

    expect(b.sim.eventsOf('cropBlighted').length).toBeGreaterThan(0);
    expect(crop(b).blight).toBeGreaterThan(0);
  });

  it('is likelier in exhausted soil than in fresh soil', () => {
    const fresh = { tilled: true, moisture: 40, fertility: 100 };
    const exhausted = { tilled: true, moisture: 40, fertility: 0 };
    expect(blightRiskMultiplier(exhausted, 100)).toBeGreaterThan(
      blightRiskMultiplier(fresh, 100) * 3,
    );
    // Over-watering is its own small penalty.
    expect(blightRiskMultiplier({ ...fresh, moisture: 100 }, 100)).toBeGreaterThan(
      blightRiskMultiplier({ ...fresh, moisture: 0 }, 100),
    );
  });

  it('worsens over time and eventually kills the plant', () => {
    const b = bed({ season: 'spring' });
    b.sim.giveItem(b.player, 'seed_wheat', 1);
    farm(b, 'plant', 'seed_wheat');
    makeItRain(b);
    crop(b).blight = 40;
    b.sim.step(ONE_VISIT * 8);
    expect(crop(b).blight).toBeGreaterThan(40);

    const died = pushToDeath(b);
    expect(died?.reason).toBe('blight');
    expect(crop(b).blight).toBeGreaterThan(BLIGHT_CONTAGIOUS_AT);
  });

  it('spreads to the plot next door', () => {
    const b = bed({ season: 'spring' });
    makeItRain(b);
    const neighbour = b.sim.placeStructure('farm_plot', b.tileX + 1, b.tileY, 0, b.player.id);
    expect(neighbour?.plot).toBeDefined();

    b.sim.giveItem(b.player, 'seed_wheat', 2);
    farm(b, 'plant', 'seed_wheat');
    // Sow the neighbour directly: it is out of arm's reach on purpose, so that the
    // spread is the only thing that can put blight in it.
    neighbour!.plot!.crop = {
      defId: 'wheat',
      plantedTick: b.sim.ctx.state.tick,
      stage: 0,
      stageProgress: 0,
      water: 100,
      health: 100,
      blight: 0,
      fertilizedTicks: 0,
      harvestsLeft: 1,
      dead: false,
    };

    crop(b).blight = 100;
    b.sim.clearEvents();

    // The source is topped back up each round: blight kills its host in about two days,
    // and this test is about the jump to the next plot, not about how long that takes.
    let guard = 0;
    while ((neighbour!.plot!.crop?.blight ?? 0) <= 0 && guard < 3000) {
      crop(b).blight = 100;
      crop(b).health = 100;
      b.sim.step(ONE_VISIT);
      guard++;
    }

    expect(neighbour!.plot!.crop?.blight).toBeGreaterThan(0);
    expect(
      b.sim.eventsOf('cropBlighted').some((event) => event.structureId === neighbour!.id),
    ).toBe(true);
  });

  it('does not reinfect a plot that already has it', () => {
    const b = bed({ season: 'spring' });
    makeItRain(b);
    const neighbour = b.sim.placeStructure('farm_plot', b.tileX + 1, b.tileY, 0, b.player.id);
    b.sim.giveItem(b.player, 'seed_wheat', 1);
    farm(b, 'plant', 'seed_wheat');
    neighbour!.plot!.crop = { ...crop(b), blight: 90 };
    crop(b).blight = 100;
    b.sim.clearEvents();

    b.sim.step(ONE_VISIT * 40);

    // Both plots are heavily blighted, so no fresh infection has anywhere to land.
    expect(b.sim.eventsOf('cropBlighted')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// clear
// ---------------------------------------------------------------------------

describe('farm clear', () => {
  it('pulls up a dead crop for plant fibre', () => {
    const b = bed({ season: 'spring' });
    b.sim.giveItem(b.player, 'seed_wheat', 1);
    farm(b, 'plant', 'seed_wheat');
    crop(b).dead = true;

    const events = farm(b, 'clear');

    expect(rejection(events)).toBeUndefined();
    expect(soil(b).crop).toBeUndefined();
    expect(seedCount(b, 'plant_fiber')).toBeGreaterThan(0);
    expect(events.some((event) => event.type === 'notification')).toBe(true);
  });

  it('pulls up a living crop the player has changed their mind about', () => {
    const b = bed({ season: 'spring' });
    b.sim.giveItem(b.player, 'seed_wheat', 1);
    farm(b, 'plant', 'seed_wheat');

    farm(b, 'clear');

    expect(soil(b).crop).toBeUndefined();
    // ...and the plot is immediately reusable.
    b.sim.giveItem(b.player, 'seed_carrot', 1);
    expect(rejection(farm(b, 'plant', 'seed_carrot'))).toBeUndefined();
  });

  it('rejects an empty plot', () => {
    const b = bed();
    expect(rejection(farm(b, 'clear'))).toMatch(/nothing to clear/i);
  });

  it('rejects a tile with no plot', () => {
    const b = bed({ structure: null });
    expect(rejection(farm(b, 'clear'))).toMatch(/no plot/i);
  });
});

// ---------------------------------------------------------------------------
// robustness and determinism
// ---------------------------------------------------------------------------

describe('farming robustness', () => {
  it('leaves an unattended plot holding finite numbers after thirty in-game days', () => {
    const b = bed({ season: 'spring' });
    b.sim.giveItem(b.player, 'seed_wheat', 1);
    farm(b, 'plant', 'seed_wheat');

    b.sim.step(30 * TICKS_PER_GAME_DAY);

    const plot = soil(b);
    expect(Number.isFinite(plot.moisture)).toBe(true);
    expect(Number.isFinite(plot.fertility)).toBe(true);
    expect(plot.moisture).toBeGreaterThanOrEqual(0);
    expect(plot.moisture).toBeLessThanOrEqual(100);
    const dead = plot.crop;
    if (dead) {
      for (const value of [
        dead.stage,
        dead.stageProgress,
        dead.water,
        dead.health,
        dead.blight,
        dead.fertilizedTicks,
        dead.harvestsLeft,
      ]) {
        expect(Number.isFinite(value)).toBe(true);
      }
      expect(dead.dead).toBe(true);
    }
  });

  it('survives a plot whose crop definition has vanished from the tables', () => {
    const b = bed({ season: 'spring' });
    b.sim.giveItem(b.player, 'seed_wheat', 1);
    farm(b, 'plant', 'seed_wheat');
    crop(b).defId = 'crop_from_a_mod_you_uninstalled';

    expect(() => b.sim.step(ONE_VISIT * 4)).not.toThrow();
    expect(soil(b).crop).toBeUndefined();
  });

  it('scrubs NaN out of a plot rather than spreading it', () => {
    const plot = {
      tilled: true,
      moisture: Number.NaN,
      fertility: Number.POSITIVE_INFINITY,
      crop: {
        defId: 'wheat',
        plantedTick: Number.NaN,
        stage: Number.NaN,
        stageProgress: Number.NaN,
        water: Number.NaN,
        health: Number.NaN,
        blight: Number.NaN,
        fertilizedTicks: Number.NaN,
        harvestsLeft: Number.NaN,
        dead: false,
      },
    };

    sanitizePlot(
      plot,
      100,
      CROP_DEFS.find((def) => def.id === 'wheat'),
    );

    expect(plot.moisture).toBe(0);
    expect(plot.fertility).toBe(0);
    expect(plot.crop.stage).toBe(0);
    expect(plot.crop.health).toBe(0);
    expect(plot.crop.plantedTick).toBe(0);
  });

  it('produces identical state from identical inputs', () => {
    const snapshot = (): string => {
      const b = bed({ seed: 77, season: 'spring', growthRate: 12 });
      makeItRain(b);
      b.sim.giveItem(b.player, 'seed_wheat', 1);
      b.sim.giveItem(b.player, 'fertilizer', 1);
      farm(b, 'plant', 'seed_wheat');
      farm(b, 'fertilize');
      b.sim.step(3 * TICKS_PER_GAME_DAY);
      return JSON.stringify(b.sim.ctx.state.structures);
    };

    expect(snapshot()).toBe(snapshot());
  });

  it('staggers plots across the tick stride instead of walking them all', () => {
    const b = bed();
    const buckets = new Set<number>();
    for (let i = 0; i < 40; i++) {
      const structure = b.sim.placeStructure('farm_plot', b.tileX + 2 + i, b.tileY + 4, 0);
      expect(structure).not.toBeNull();
      const bucket = plotBucket(structure!.id);
      expect(bucket).toBeGreaterThanOrEqual(0);
      expect(bucket).toBeLessThan(FARM_TICK_STRIDE);
      buckets.add(bucket);
    }
    // Forty plots must not all land in one bucket, or the stagger buys nothing.
    expect(buckets.size).toBeGreaterThan(FARM_TICK_STRIDE / 3);
  });

  /**
   * Regression: a plot's rolls must not depend on how many other plots exist.
   *
   * Before `plotRng` was seeded from replicated state, every plot due on a tick drew
   * from one shared stream, so a field on the far side of the map consumed the rolls
   * that would otherwise have been yours: the observed plot caught blight at tick 340
   * with forty unrelated plots in the world and at 3840 without them. The decoys here
   * are forty tiles away, which is far outside blight's cardinal spread, so the only
   * channel left between them and the plot under observation is the RNG itself.
   */
  it('rolls a plot independently of unrelated plots elsewhere in the world', () => {
    const onsetTick = (decoys: number): number => {
      const b = bed({ seed: 99, season: 'spring', data: blightyData('wheat', 2e-4) });
      makeItRain(b);
      b.sim.giveItem(b.player, 'seed_wheat', 1);
      farm(b, 'plant', 'seed_wheat');

      for (let i = 0; i < decoys; i++) {
        const decoy = b.sim.placeStructure('farm_plot', b.tileX + 40 + i * 3, b.tileY + 40, 0);
        decoy!.plot!.crop = { ...crop(b), blight: 0 };
      }

      for (let tick = 0; tick < 40_000; tick += ONE_VISIT) {
        b.sim.step(ONE_VISIT);
        if ((soil(b).crop?.blight ?? 0) > 0) return tick;
      }
      return -1;
    };

    const alone = onsetTick(0);
    expect(alone).toBeGreaterThan(0);
    expect(onsetTick(40)).toBe(alone);
  });

  /**
   * Regression: the plot-index rebuild is anchored to the world clock.
   *
   * A plot placed by another system (the build menu, not a `farm` command) cannot
   * invalidate farming's cache, so it waits for the next rebuild. Which *world tick* that
   * is has to depend only on the tick, never on how long ago this system last rebuilt -
   * otherwise a world resumed from a save picks the plot up on a different tick than the
   * run that saved it, permanently. Both runs below place their external plot on the same
   * world tick and differ only in when a `farm` command last invalidated the cache.
   */
  it('picks up an externally placed plot on a tick fixed by the world clock', () => {
    const noticedAt = (tillOffset: number): number => {
      const b = bed({ structure: null, season: 'spring' });
      b.sim.equip(b.player, 'hoe');

      // Till at differing times: this is what sets the cache's phase.
      b.sim.step(tillOffset);
      farm(b, 'till');

      // Then place a plot the way the build menu would, on a fixed world tick, far
      // enough away that nothing but the index can connect the two.
      const placeTick = b.sim.ctx.state.tick + PLOT_INDEX_REFRESH_TICKS;
      while (b.sim.ctx.state.tick < placeTick) b.sim.step(1);
      const external = b.sim.placeStructure('farm_plot', b.tileX + 30, b.tileY + 30, 0);
      const start = external!.plot!.moisture;

      // Evaporation is the tell: the plot's moisture cannot move until the pass sees it.
      for (let i = 0; i < PLOT_INDEX_REFRESH_TICKS * 3; i++) {
        b.sim.step(1);
        if (external!.plot!.moisture !== start) return b.sim.ctx.state.tick;
      }
      return -1;
    };

    const early = noticedAt(FARM_ACTION_TICKS);
    expect(early).toBeGreaterThan(0);
    expect(noticedAt(FARM_ACTION_TICKS + 37)).toBe(early);
  });

  /**
   * Regression: farming must not draw from the master generator.
   *
   * Forking it would make every other system's rolls depend on whether a farm happened
   * to have a plot due this tick - and, through the plot-index cache, on whether the
   * world had just been reloaded. Growing crops must leave the master stream untouched.
   */
  it('leaves the master random stream untouched while crops grow', () => {
    const b = bed({ season: 'spring', growthRate: 20, data: blightyData('wheat', 2e-3) });
    makeItRain(b);
    b.sim.giveItem(b.player, 'seed_wheat', 1);
    farm(b, 'plant', 'seed_wheat');

    const before = b.sim.ctx.rng.getState();
    b.sim.step(TICKS_PER_GAME_DAY);

    expect(crop(b).stage).toBeGreaterThan(0);
    expect(b.sim.ctx.rng.getState()).toEqual(before);
  });

  it('simulates a whole field without dropping any of it', () => {
    const b = bed({ season: 'spring', growthRate: 40 });
    makeItRain(b);
    const field: StructureState[] = [];
    for (let i = 0; i < 12; i++) {
      const structure = b.sim.placeStructure('farm_plot', b.tileX + 3 + i, b.tileY + 6, 0);
      structure!.plot!.crop = {
        defId: 'wheat',
        plantedTick: 0,
        stage: 0,
        stageProgress: 0,
        water: 100,
        health: 100,
        blight: 0,
        fertilizedTicks: 0,
        harvestsLeft: 1,
        dead: false,
      };
      field.push(structure!);
    }

    b.sim.step(TICKS_PER_GAME_DAY / 2);

    for (const structure of field) {
      expect(structure.plot?.crop?.stage).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// the pure model the client shares
// ---------------------------------------------------------------------------

describe('crop model helpers', () => {
  const wheat = CROP_DEFS.find((def) => def.id === 'wheat') as CropDef;

  it('names a sprite per visible stage and a dead one for a failure', () => {
    const base = {
      defId: 'wheat',
      plantedTick: 0,
      stage: 0,
      stageProgress: 0,
      water: 50,
      health: 100,
      blight: 0,
      fertilizedTicks: 0,
      harvestsLeft: 1,
      dead: false,
    };
    expect(cropStageSprite(base, wheat)).toBe('crop_wheat_0');
    expect(cropStageSprite({ ...base, stage: 3 }, wheat)).toBe('crop_wheat_3');
    // Clamped to the last real stage, never past the end of the atlas.
    expect(cropStageSprite({ ...base, stage: 99 }, wheat)).toBe(`crop_wheat_${matureStage(wheat)}`);
    expect(cropStageSprite({ ...base, dead: true }, wheat)).toBe('crop_wheat_dead');
  });

  it('describes every state a plot can be in', () => {
    const untilled = { tilled: false, moisture: 20, fertility: 100 };
    expect(describePlot(untilled)).toMatch(/hoe/i);

    const empty = { tilled: true, moisture: 55, fertility: 90 };
    expect(describePlot(empty)).toMatch(/ready for seed/i);
    expect(describePlot(empty)).toContain('55% moisture');
    expect(describePlot(empty)).toContain('90% fertility');

    const growing = {
      ...empty,
      crop: {
        defId: 'wheat',
        plantedTick: 0,
        stage: 1,
        stageProgress: 0.5,
        water: 55,
        health: 100,
        blight: 0,
        fertilizedTicks: 0,
        harvestsLeft: 1,
        dead: false,
      },
    };
    expect(describePlot(growing, wheat)).toContain('Wheat');
    expect(describePlot(growing, wheat)).toContain(`stage 2 of ${wheat.stages}`);
    expect(describePlot(growing, wheat)).toContain('healthy');

    const ripe = { ...growing, crop: { ...growing.crop, stage: matureStage(wheat) } };
    expect(describePlot(ripe, wheat)).toMatch(/ready to harvest/i);

    const sick = {
      ...growing,
      crop: { ...growing.crop, health: 45, blight: 60, fertilizedTicks: 500 },
    };
    expect(describePlot(sick, wheat)).toContain('failing');
    expect(describePlot(sick, wheat)).toContain('blighted 60%');
    expect(describePlot(sick, wheat)).toContain('fertilized');

    const tomato = CROP_DEFS.find((def) => def.id === 'tomato') as CropDef;
    const ratoon = {
      ...empty,
      crop: { ...growing.crop, defId: 'tomato', stage: 2, harvestsLeft: 3 },
    };
    expect(describePlot(ratoon, tomato)).toContain('3 pickings left');

    const gone = { ...growing, crop: { ...growing.crop, dead: true } };
    expect(describePlot(gone, wheat)).toMatch(/dead wheat/i);
    // It still says something useful with no definition to hand.
    expect(describePlot(growing)).toContain('wheat');
  });

  it('knows what a hoe can break', () => {
    expect(canBeTilled(Tile.Grass)).toBe(true);
    expect(canBeTilled(Tile.Dirt)).toBe(true);
    expect(canBeTilled(Tile.StoneGround)).toBe(false);
    expect(canBeTilled(Tile.Sand)).toBe(false);
    // Already-worked soil is re-tillable so a destroyed plot is repairable.
    expect(canBeTilled(Tile.FarmlandDry)).toBe(true);
    expect(canBeTilled(Tile.FarmlandWet)).toBe(true);
  });

  it('flips the soil tile at the wet threshold', () => {
    expect(plotTileFor({ tilled: true, moisture: 0, fertility: 100 })).toBe(Tile.FarmlandDry);
    expect(plotTileFor({ tilled: true, moisture: FARMLAND_WET_MOISTURE - 1, fertility: 100 })).toBe(
      Tile.FarmlandDry,
    );
    expect(plotTileFor({ tilled: true, moisture: FARMLAND_WET_MOISTURE, fertility: 100 })).toBe(
      Tile.FarmlandWet,
    );
  });

  it('reports growth as a fraction that reaches exactly one at maturity', () => {
    const base = {
      defId: 'wheat',
      plantedTick: 0,
      stage: 0,
      stageProgress: 0,
      water: 50,
      health: 100,
      blight: 0,
      fertilizedTicks: 0,
      harvestsLeft: 1,
      dead: false,
    };
    expect(cropGrowthFraction(base, wheat)).toBe(0);
    expect(cropGrowthFraction({ ...base, stage: matureStage(wheat) }, wheat)).toBe(1);
    expect(cropGrowthFraction({ ...base, stage: 2 }, wheat)).toBeGreaterThan(0);
    expect(cropGrowthFraction({ ...base, stage: 2 }, wheat)).toBeLessThan(1);
  });

  it('reads ticksPerStage as transitions, not stages', () => {
    expect(wheat.ticksPerStage).toHaveLength(wheat.stages - 1);
    expect(stageTicks(wheat, 0)).toBeGreaterThan(0);
    // The mature stage has no transition out of it, and asking never divides by zero.
    expect(stageTicks(wheat, matureStage(wheat))).toBe(0);
    expect(stageTicks(wheat, -1)).toBe(0);
  });

  it('gates growth on season, temperature and moisture, and scales it otherwise', () => {
    const good = {
      moisture: 60,
      fertility: 100,
      nominalFertility: 100,
      temperature: 18,
      season: 'spring' as const,
      lightLevel: 1,
      fertilized: false,
      growthRateTuning: 1,
    };
    expect(growthMultiplier(wheat, good)).toBeGreaterThan(0);
    expect(growthMultiplier(wheat, { ...good, season: 'winter' })).toBe(0);
    expect(growthMultiplier(wheat, { ...good, temperature: 50 })).toBe(0);
    expect(growthMultiplier(wheat, { ...good, moisture: 0 })).toBe(0);
    expect(growthMultiplier(wheat, { ...good, fertilized: true })).toBeGreaterThan(
      growthMultiplier(wheat, good),
    );
    expect(growthMultiplier(wheat, { ...good, fertility: 0 })).toBeLessThan(
      growthMultiplier(wheat, good),
    );
    // A nonsense tuning value must not produce a nonsense rate.
    expect(growthMultiplier(wheat, { ...good, growthRateTuning: Number.NaN })).toBeGreaterThan(0);
    expect(growthMultiplier(wheat, { ...good, growthRateTuning: -5 })).toBe(0);
  });

  it('spans a wide but bounded yield multiplier', () => {
    const plot = { tilled: true, moisture: 50, fertility: 100 };
    const healthy = {
      defId: 'wheat',
      plantedTick: 0,
      stage: 4,
      stageProgress: 0,
      water: 50,
      health: 100,
      blight: 0,
      fertilizedTicks: 0,
      harvestsLeft: 1,
      dead: false,
    };
    const neglected = { ...healthy, health: 10, blight: 100 };

    const best = harvestYieldMultiplier(healthy, plot, 100, 20);
    const worst = harvestYieldMultiplier(neglected, { ...plot, fertility: 0 }, 100, 0);
    expect(best).toBeGreaterThan(1.5);
    expect(worst).toBeLessThan(0.5);
    expect(best / worst).toBeGreaterThan(4);
  });

  it('dries a sunlit plot faster than a shaded, humid one', () => {
    const clear = {
      type: 'clear' as const,
      intensity: 0,
      temperature: 28,
      windAngle: 0,
      windSpeed: 0,
      nextChangeTick: 0,
      lightning: false,
    };
    expect(evaporationRate(clear, 1, 1)).toBeGreaterThan(evaporationRate(clear, 0, 1));
    expect(evaporationRate(clear, 1, 1)).toBeGreaterThan(
      evaporationRate({ ...clear, type: 'overcast' }, 1, 1),
    );
    // A raised bed holds its water.
    expect(evaporationRate(clear, 1, 0.55)).toBeLessThan(evaporationRate(clear, 1, 1));
    // ...and a cold plot barely dries at all.
    expect(evaporationRate({ ...clear, temperature: -10 }, 1, 1)).toBeLessThan(
      evaporationRate(clear, 1, 1),
    );
  });

  it('rains harder in a storm than in a shower, and not at all in the sun', () => {
    const base = {
      intensity: 0.5,
      temperature: 15,
      windAngle: 0,
      windSpeed: 0,
      nextChangeTick: 0,
      lightning: false,
    };
    expect(rainfallRate({ ...base, type: 'clear' })).toBe(0);
    expect(rainfallRate({ ...base, type: 'cloudy' })).toBe(0);
    expect(rainfallRate({ ...base, type: 'overcast' })).toBe(0);
    expect(rainfallRate({ ...base, type: 'fog' })).toBe(0);
    expect(rainfallRate({ ...base, type: 'storm' })).toBeGreaterThan(
      rainfallRate({ ...base, type: 'rain' }),
    );
    expect(rainfallRate({ ...base, type: 'rain', intensity: 1 })).toBeGreaterThan(
      rainfallRate({ ...base, type: 'rain', intensity: 0 }),
    );

    // Whatever the curve says, a plot under real rain must gain water faster than the
    // sun takes it away, or rain would be decoration.
    const pouring = { ...base, type: 'rain' as const, intensity: 1 };
    expect(rainfallRate(pouring)).toBeGreaterThan(evaporationRate(pouring, 1, 1));
  });
});

// ---------------------------------------------------------------------------
// planter boxes
// ---------------------------------------------------------------------------

describe('planter boxes', () => {
  it('start damp, hold their water and are richer soil', () => {
    const raised = bed({ structure: 'planter_box', season: 'spring' });
    const dug = bed({ structure: 'farm_plot', season: 'spring' });
    expect(soil(raised).moisture).toBeGreaterThan(soil(dug).moisture);
    expect(soil(raised).fertility).toBeGreaterThan(soil(dug).fertility);

    for (const b of [raised, dug]) {
      b.sim.giveItem(b.player, 'seed_wheat', 1);
      farm(b, 'plant', 'seed_wheat');
      b.sim.step(TICKS_PER_GAME_DAY);
    }

    const raisedLoss = 70 - soil(raised).moisture;
    const dugLoss = 40 - soil(dug).moisture;
    expect(raisedLoss).toBeLessThan(dugLoss);
  });

  it('refuses to burn a fertilizer on a full plot holding a dead crop', () => {
    // The no-op guard asked "is the soil full AND is the crop full?", and a dead crop is
    // never "full" - its boost counter sits at zero. So the guard passed, the item was
    // consumed, and the boost below then skipped the crop because it was dead: a fertilizer
    // destroyed for nothing, repeatable for as long as the player had them.
    const b = bed({ structure: 'farm_plot' });
    soil(b).fertility = 100;
    b.sim.giveItem(b.player, 'seed_wheat', 1);
    farm(b, 'plant', 'seed_wheat');
    const crop = soil(b).crop;
    expect(crop).toBeDefined();
    crop!.dead = true;
    soil(b).fertility = b.sim.sim.data.structures.require('farm_plot').plot!.fertility;

    b.sim.giveItem(b.player, 'fertilizer', 2);
    const before = countOf(b.player, 'fertilizer');
    b.sim.clearEvents();
    farm(b, 'fertilize');

    expect(countOf(b.player, 'fertilizer')).toBe(before);
    expect(
      b.sim
        .eventsOf('commandRejected')
        .map((e) => e.reason)
        .join(' '),
    ).toMatch(/needs nothing/);
  });

  it('caps fertilizer at the richer soil the box supports', () => {
    const b = bed({ structure: 'planter_box' });
    soil(b).fertility = 120;
    b.sim.giveItem(b.player, 'fertilizer', 2);
    farm(b, 'fertilize');
    expect(soil(b).fertility).toBeGreaterThan(120);
    expect(soil(b).fertility).toBeLessThanOrEqual(130);
  });
});

/**
 * Content invariant: a crop must be growable in every season it lists.
 *
 * Frost is lethal on contact - `isFrostKilling` kills outright rather than draining
 * health - so a crop whose `frostTemperature` sits above the nightly low of a season it
 * advertises cannot be grown that season at all. Nothing else catches this: the crop
 * table and the climate model are authored independently, both are internally sensible,
 * and the contradiction only shows up as a player planting seeds and watching them die.
 *
 * Measured against the *middle half* of each season rather than its coldest night. The
 * quarter of a season that borders winter is a shoulder, and losing a tender crop to a
 * late or early frost there is the mechanic working - it is why `frostTemperature` varies
 * between crops. What must never happen is the middle of a crop's own season killing it.
 */
describe('crops can survive the seasons they list', () => {
  /** Coldest ordinary night in the middle half of each season, per the climate model. */
  function midSeasonNightFloor(): Map<Season, number> {
    const floors = new Map<Season, number>();
    for (let day = 0; day < DAYS_PER_SEASON * SEASONS.length; day++) {
      const dayOfSeason = day % DAYS_PER_SEASON;
      if (dayOfSeason < DAYS_PER_SEASON * 0.25) continue;
      if (dayOfSeason > DAYS_PER_SEASON * 0.75) continue;
      const season = seasonForDay(day);
      // The pre-dawn low, with no weather offset: rain and snow push below this, and
      // weather is the risk the shoulder rule above already accounts for.
      const low =
        seasonalBaseTemperature(day) -
        TEMPERATURE_DIURNAL_AMPLITUDE_C +
        dailyTemperatureOffset(CLIMATE_PROBE_SEED, day);
      floors.set(season, Math.min(floors.get(season) ?? Number.POSITIVE_INFINITY, low));
    }
    return floors;
  }

  const floors = midSeasonNightFloor();

  it('has a nightly floor for every season', () => {
    expect([...floors.keys()].sort()).toEqual([...SEASONS].sort());
  });

  it.each(CROP_DEFS.map((def) => [def.id, def] as const))(
    '%s survives the middle of every season it lists',
    (_id, def) => {
      for (const season of def.seasons) {
        const floor = floors.get(season);
        expect(floor).toBeDefined();
        // A full degree of margin. Two crops once missed by 0.1C and 1.6C respectively,
        // which is exactly the kind of drift an exact-boundary assertion lets through.
        expect(def.frostTemperature).toBeLessThan(floor! - 1);
      }
    },
  );
});
