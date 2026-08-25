import { describe, expect, it } from 'vitest';
import { SIM_HZ, TICKS_PER_GAME_HOUR, pixelToTile, type SimulationConfig } from '@survive/protocol';
import { createDefaultSystems } from '@survive/simulation';
import { createTestSimulation, type TestSimulation } from '@survive/test-utils';

/**
 * The whole loop, end to end.
 *
 * Gather -> craft -> build -> farm -> fight, driven only through the commands a real
 * client can send. If this passes, the game is playable; if a system quietly breaks, this
 * is the test that notices, because it is the only one that spans all of them.
 */

function fresh(seed = 31337): TestSimulation {
  return createTestSimulation({ seed, flattenRadius: 40 });
}

/**
 * A simulation with time compressed.
 *
 * These tests are about whether a mechanism *works*, not about whether the balance
 * numbers are pleasant, and the balance numbers are deliberately slow: starving takes
 * days, wheat takes a week. Turning the tuning knobs up lets the test exercise the same
 * code path in a fraction of a second, and the calibration itself is asserted separately
 * in the systems' own unit tests.
 */
function accelerated(tune: (config: SimulationConfig) => void, seed = 31337): TestSimulation {
  return createTestSimulation({ seed, flattenRadius: 40, config: tune });
}

/**
 * A simulation the test can hold at a chosen temperature.
 *
 * The weather system derives temperature from the seasonal curve every tick, so a test
 * that pokes `state.weather.temperature` is overwritten immediately, and walking the
 * calendar into summer costs half a million ticks. Dropping the weather system out
 * instead leaves the value where the test puts it - which is what a farming test wants,
 * since the temperature *model* has its own tests next door.
 */
function farmingSim(temperatureC: number, growthRate = 40, seed = 31337): TestSimulation {
  const systems = createDefaultSystems().filter((system) => system.id !== 'weather');
  const sim = createTestSimulation({
    seed,
    flattenRadius: 40,
    systems,
    config: (config) => {
      config.tuning.cropGrowthRate = growthRate;
    },
  });
  sim.sim.state.weather.temperature = temperatureC;
  sim.sim.state.weather.type = 'clear';
  sim.sim.state.weather.intensity = 0;
  return sim;
}

/**
 * Send a command and let the action cooldown clear before the next one.
 *
 * The server rate-limits interactions ("still busy"), which is correct - a player cannot
 * till and plant on the same tick - so a test that chains actions has to respect it just
 * as a human would.
 */
function act(
  sim: TestSimulation,
  player: { id: string },
  command: Parameters<TestSimulation['run']>[1],
  gapTicks = 24,
): void {
  const state = sim.sim.getPlayer(player.id);
  if (!state) throw new Error(`unknown player ${player.id}`);
  sim.run(state, command);
  sim.step(gapTicks);
}

/** Count a definition across the player's inventory. */
function count(sim: TestSimulation, playerId: string, defId: string): number {
  const player = sim.sim.getPlayer(playerId);
  if (!player) return 0;
  let total = 0;
  for (const slot of player.inventory.slots) {
    if (slot?.defId === defId) total += slot.count;
  }
  return total;
}

describe('gathering', () => {
  it('chops a tree down with an axe and yields wood', () => {
    const sim = fresh();
    const player = sim.addPlayer();
    sim.equip(player, 'stone_hatchet');

    const tileX = pixelToTile(player.x) + 1;
    const tileY = pixelToTile(player.y);
    const tree = sim.placeNode('tree_pine', tileX, tileY);
    expect(tree).not.toBeNull();

    // Swing until it falls, with the cooldown between hits.
    for (let i = 0; i < 80 && !tree!.depleted; i++) {
      act(sim, player, { type: 'gather', nodeId: tree!.id }, 12);
    }

    expect(tree!.depleted).toBe(true);
    expect(count(sim, player.id, 'wood_log')).toBeGreaterThan(0);
    expect(player.skills.woodcutting.xp + player.skills.woodcutting.level).toBeGreaterThan(0);
    // Chopping is loud - that is what makes gathering risky.
    expect(sim.eventsOf('noise').length).toBeGreaterThan(0);
  });

  it('refuses to let bare hands break a boulder', () => {
    const sim = fresh();
    const player = sim.addPlayer();
    const tileX = pixelToTile(player.x) + 1;
    const tileY = pixelToTile(player.y);
    const rock = sim.placeNode('rock_boulder', tileX, tileY);
    expect(rock).not.toBeNull();

    for (let i = 0; i < 30; i++) {
      act(sim, player, { type: 'gather', nodeId: rock!.id }, 12);
    }
    expect(rock!.depleted).toBe(false);
    expect(rock!.health).toBe(rock!.maxHealth);
    expect(sim.eventsOf('toolIneffective').length).toBeGreaterThan(0);
  });

  it('gathers fibre by hand, which is where every run starts', () => {
    const sim = fresh();
    const player = sim.addPlayer();
    const patch = sim.placeNode(
      'plant_fiber_patch',
      pixelToTile(player.x) + 1,
      pixelToTile(player.y),
    );
    expect(patch).not.toBeNull();
    for (let i = 0; i < 60 && !patch!.depleted; i++) {
      act(sim, player, { type: 'gather', nodeId: patch!.id }, 12);
    }
    expect(count(sim, player.id, 'plant_fiber')).toBeGreaterThan(0);
  });
});

describe('crafting', () => {
  it('crafts rope from fibre by hand', () => {
    const sim = fresh();
    const player = sim.addPlayer();
    const recipe = sim.data.recipes.require('craft_rope');
    for (const input of recipe.inputs) {
      sim.giveItem(player, input.defId, input.count * 2);
    }

    sim.run(player, { type: 'craft', recipeId: 'craft_rope', count: 1 });
    expect(player.craftQueue.length).toBe(1);
    sim.step(recipe.craftTicks + 20);

    const output = recipe.outputs[0]!;
    expect(count(sim, player.id, output.defId)).toBeGreaterThanOrEqual(output.count);
    expect(sim.eventsOf('craftCompleted').length).toBeGreaterThan(0);
  });

  it('rejects a craft with nothing to make it from', () => {
    const sim = fresh();
    const player = sim.addPlayer();
    sim.run(player, { type: 'craft', recipeId: 'craft_rope', count: 1 });
    expect(player.craftQueue).toHaveLength(0);
    const failures = [...sim.eventsOf('craftFailed'), ...sim.eventsOf('commandRejected')];
    expect(failures.length).toBeGreaterThan(0);
  });

  it('reserves the inputs up front, so dropping them mid-craft is not an exploit', () => {
    const sim = fresh();
    const player = sim.addPlayer();
    const recipe = sim.data.recipes.require('craft_rope');
    for (const input of recipe.inputs) sim.giveItem(player, input.defId, input.count);

    sim.run(player, { type: 'craft', recipeId: 'craft_rope', count: 1 });
    // The materials are gone the instant the job is queued.
    for (const input of recipe.inputs) {
      expect(count(sim, player.id, input.defId)).toBe(0);
    }
    // ...so a second job cannot be queued from the same materials.
    sim.run(player, { type: 'craft', recipeId: 'craft_rope', count: 1 });
    expect(player.craftQueue.length).toBe(1);
  });
});

describe('building', () => {
  it('places a wall, charges for it and blocks movement', () => {
    const sim = fresh();
    const player = sim.addPlayer();
    const def = sim.data.structures.require('wall_wood');
    for (const cost of def.cost) sim.giveItem(player, cost.defId, cost.count * 3);
    // A wooden wall needs a hammer in hand; that is the definition's `tool`.
    sim.equip(player, 'hammer');

    const tileX = pixelToTile(player.x) + 2;
    const tileY = pixelToTile(player.y);
    act(sim, player, { type: 'build', defId: 'wall_wood', tileX, tileY, rotation: 0 });

    const placed = Object.values(sim.sim.state.structures).find(
      (structure) => structure.tileX === tileX && structure.tileY === tileY,
    );
    expect(placed).toBeDefined();
    expect(placed!.ownerId).toBe(player.id);
    for (const cost of def.cost) {
      expect(count(sim, player.id, cost.defId)).toBe(cost.count * 3 - cost.count);
    }

    // Finish the blueprint, then it should be solid.
    sim.step(def.buildTicks + 40);
    expect(sim.world.isSolidTile(tileX, tileY)).toBe(true);
  });

  it('rejects a build with the materials but no tool', () => {
    const sim = fresh();
    const player = sim.addPlayer();
    const def = sim.data.structures.require('wall_wood');
    for (const cost of def.cost) sim.giveItem(player, cost.defId, cost.count * 3);
    // No hammer.
    const tileX = pixelToTile(player.x) + 2;
    const tileY = pixelToTile(player.y);
    act(sim, player, { type: 'build', defId: 'wall_wood', tileX, tileY, rotation: 0 });

    expect(
      Object.values(sim.sim.state.structures).some(
        (structure) => structure.tileX === tileX && structure.tileY === tileY,
      ),
    ).toBe(false);
    expect(sim.eventsOf('buildRejected').some((event) => event.reason === 'missingTool')).toBe(
      true,
    );
    // ...and nothing was charged for the failed attempt.
    for (const cost of def.cost) {
      expect(count(sim, player.id, cost.defId)).toBe(cost.count * 3);
    }
  });

  it('rejects a build with no materials and charges nothing', () => {
    const sim = fresh();
    const player = sim.addPlayer();
    const tileX = pixelToTile(player.x) + 2;
    const tileY = pixelToTile(player.y);
    sim.run(player, { type: 'build', defId: 'wall_stone', tileX, tileY, rotation: 0 });
    expect(
      Object.values(sim.sim.state.structures).some(
        (structure) => structure.tileX === tileX && structure.tileY === tileY,
      ),
    ).toBe(false);
    expect(sim.eventsOf('buildRejected').length).toBeGreaterThan(0);
  });

  it('rejects a build far out of reach', () => {
    const sim = fresh();
    const player = sim.addPlayer();
    const def = sim.data.structures.require('wall_wood');
    for (const cost of def.cost) sim.giveItem(player, cost.defId, cost.count * 3);
    sim.equip(player, 'hammer');

    act(sim, player, {
      type: 'build',
      defId: 'wall_wood',
      tileX: pixelToTile(player.x) + 200,
      tileY: pixelToTile(player.y),
      rotation: 0,
    });
    expect(sim.eventsOf('buildRejected').length).toBeGreaterThan(0);
  });

  it('opens and closes a door, and the collision follows', () => {
    const sim = fresh();
    const player = sim.addPlayer();
    const tileX = pixelToTile(player.x) + 1;
    const tileY = pixelToTile(player.y);
    const door = sim.placeStructure('door_wood', tileX, tileY, 0, player.id);
    expect(door).not.toBeNull();
    expect(sim.world.isSolidTile(tileX, tileY)).toBe(true);

    act(sim, player, { type: 'toggleDoor', structureId: door!.id });
    expect(door!.door?.open).toBe(true);
    expect(sim.world.isSolidTile(tileX, tileY)).toBe(false);

    act(sim, player, { type: 'toggleDoor', structureId: door!.id });
    expect(door!.door?.open).toBe(false);
    expect(sim.world.isSolidTile(tileX, tileY)).toBe(true);
  });
});

describe('farming', () => {
  it('runs the whole loop: till, plant, water, grow, harvest', () => {
    // Growth accelerated and the weather pinned warm: this is about the loop, not about
    // how long wheat takes or what spring feels like.
    const sim = farmingSim(20);
    const player = sim.addPlayer();
    sim.equip(player, 'hoe');

    const tileX = pixelToTile(player.x) + 1;
    const tileY = pixelToTile(player.y);
    act(sim, player, { type: 'farm', action: 'till', tileX, tileY });

    const plot = Object.values(sim.sim.state.structures).find(
      (structure) => structure.plot && structure.tileX === tileX && structure.tileY === tileY,
    );
    expect(plot, 'tilling should create a farm plot').toBeDefined();
    expect(plot!.plot!.tilled).toBe(true);

    // Plant something that grows in the current season.
    const season = sim.sim.state.time.season;
    const crop = sim.data.crops.all().find((candidate) => candidate.seasons.includes(season));
    expect(crop, `expected a crop for ${season}`).toBeDefined();
    sim.giveItem(player, crop!.seedDefId, 4);
    act(sim, player, { type: 'farm', action: 'plant', tileX, tileY, seedDefId: crop!.seedDefId });
    expect(plot!.plot!.crop).toBeDefined();
    expect(plot!.plot!.crop!.defId).toBe(crop!.id);

    // Keep it watered while it grows. A watering can comes empty - filling it from a
    // water source is its own path - so top it up directly here.
    const can = sim.giveItem(player, 'watering_can', 1);
    const canSlot = player.inventory.slots.findIndex((slot) => slot?.defId === 'watering_can');
    expect(canSlot).toBeGreaterThanOrEqual(0);

    for (let round = 0; round < 400; round += 1) {
      const held = player.inventory.slots[canSlot];
      if (held) held.fill = sim.data.items.require('watering_can').liquid?.capacity ?? 100;
      if ((plot!.plot!.moisture ?? 0) < 60) {
        act(sim, player, { type: 'farm', action: 'water', tileX, tileY });
      }
      sim.step(150);
      if (plot!.plot!.crop?.stage === crop!.stages - 1) break;
      if (plot!.plot!.crop?.dead) break;
    }

    const grown = plot!.plot!.crop;
    expect(grown, 'the crop should still be alive').toBeDefined();
    expect(grown!.dead).toBe(false);
    expect(grown!.stage).toBe(crop!.stages - 1);

    act(sim, player, { type: 'farm', action: 'harvest', tileX, tileY });
    expect(count(sim, player.id, crop!.produceDefId)).toBeGreaterThan(0);
    expect(sim.eventsOf('cropHarvested').length).toBeGreaterThan(0);
    // Watering actually happened, rather than every attempt being rejected.
    expect(sim.eventsOf('cropWatered').length).toBeGreaterThan(0);
    void can;
  });

  it('stalls or kills a crop that is never watered', () => {
    const sim = farmingSim(20);
    const player = sim.addPlayer();
    sim.equip(player, 'hoe');
    const tileX = pixelToTile(player.x) + 1;
    const tileY = pixelToTile(player.y);
    act(sim, player, { type: 'farm', action: 'till', tileX, tileY });
    const plot = Object.values(sim.sim.state.structures).find((s) => s.plot);
    expect(plot).toBeDefined();

    const season = sim.sim.state.time.season;
    const crop = sim.data.crops.all().find((candidate) => candidate.seasons.includes(season))!;
    sim.giveItem(player, crop.seedDefId, 1);
    act(sim, player, { type: 'farm', action: 'plant', tileX, tileY, seedDefId: crop.seedDefId });

    // Bake it dry and keep it dry. Growth is hard-gated below `minMoisture`, so a few
    // in-game hours is enough to show it makes no progress at all - and at 40x growth a
    // watered plot would have advanced several stages in the same span.
    const before = { ...plot!.plot!.crop! };
    for (let i = 0; i < 8; i++) {
      plot!.plot!.moisture = 0;
      if (plot!.plot!.crop) plot!.plot!.crop.water = 0;
      sim.step(TICKS_PER_GAME_HOUR / 2);
    }

    const after = plot!.plot!.crop;
    expect(after).toBeDefined();
    expect(after!.stage).toBe(before.stage);
    expect(after!.stageProgress).toBeCloseTo(before.stageProgress, 6);
    // ...and a parched crop loses condition rather than sitting there indefinitely.
    expect(after!.health).toBeLessThan(before.health);
  });
});

describe('survival pressure', () => {
  it('makes needs rise and eating relieve them', () => {
    const sim = accelerated((config) => {
      config.tuning.needRate = 12;
    });
    const player = sim.addPlayer();
    const startHunger = player.hunger;
    sim.advanceGameHours(2);
    expect(player.hunger).toBeGreaterThan(startHunger);
    expect(player.thirst).toBeGreaterThan(0);

    const hungry = player.hunger;
    sim.giveItem(player, 'berry', 5);
    const slot = player.inventory.slots.findIndex((entry) => entry?.defId === 'berry');
    sim.run(player, { type: 'useItem', ref: { kind: 'inventory' }, index: slot });
    sim.step(SIM_HZ * 2);
    expect(player.hunger).toBeLessThan(hungry);
  });

  it('kills a player who never eats or drinks', () => {
    // Fifty times the need rate: the same starvation path, in a second rather than a week.
    const sim = accelerated((config) => {
      config.tuning.needRate = 50;
    });
    const player = sim.addPlayer();
    for (let hour = 0; hour < 240 && player.alive; hour++) sim.advanceGameHours(1);
    expect(player.alive).toBe(false);
    expect(player.deathCause).toBeTruthy();
  });
});

describe('combat', () => {
  it('kills a zombie with a melee weapon and awards XP', () => {
    const sim = fresh();
    const player = sim.addPlayer();
    sim.equip(player, 'baseball_bat');
    const zombie = sim.spawnZombie('walker', player.x + 24, player.y);
    player.aimAngle = 0;

    for (let i = 0; i < 200 && zombie.ai !== 'dead'; i++) {
      // Keep the zombie in reach: it is trying to close on the player anyway.
      zombie.x = player.x + 22;
      zombie.y = player.y;
      sim.hold(player, { moveX: 0, moveY: 0, aimAngle: 0, buttons: 1 }, 1);
      sim.hold(player, { moveX: 0, moveY: 0, aimAngle: 0, buttons: 0 }, 1);
    }

    expect(zombie.ai).toBe('dead');
    expect(player.stats.zombieKills).toBe(1);
    expect(player.skills.melee.level + player.skills.melee.xp).toBeGreaterThan(0);
  });

  it('lets a zombie wound and infect a defenceless player', () => {
    const sim = fresh();
    const player = sim.addPlayer();
    const zombie = sim.spawnZombie('walker', player.x + 20, player.y);
    zombie.ai = 'pursue';
    zombie.targetId = player.id;

    sim.step(SIM_HZ * 30);
    expect(player.health).toBeLessThan(player.maxHealth);
    expect(sim.eventsOf('damage').length).toBeGreaterThan(0);
  });
});

describe('performance', () => {
  it('simulates a populated world well inside the tick budget', () => {
    const sim = fresh();
    for (let i = 0; i < 4; i++) sim.addPlayer({ id: `p${i}`, name: `P${i}` });
    for (let i = 0; i < 60; i++) {
      const angle = (i / 60) * Math.PI * 2;
      sim.spawnZombie(
        'walker',
        sim.spawn.x + Math.cos(angle) * 400,
        sim.spawn.y + Math.sin(angle) * 400,
      );
    }

    const ticks = 600;
    const started = process.hrtime.bigint();
    sim.step(ticks);
    const perTickMs = Number(process.hrtime.bigint() - started) / 1e6 / ticks;

    // The budget at 20 Hz is 50 ms. A generous ceiling here still catches a regression
    // that turns an O(1) lookup into a full-table scan.
    expect(perTickMs).toBeLessThan(12);
  });

  it('never produces a NaN or an out-of-range vital over a long run', () => {
    const sim = fresh();
    const player = sim.addPlayer();
    sim.spawnZombie('walker', player.x + 500, player.y);
    // Two in-game hours is 2400 ticks of the full system list against a populated world -
    // long enough for every rate, decay and accumulator to have run thousands of times,
    // which is what a NaN needs to surface.
    sim.step(TICKS_PER_GAME_HOUR * 2);

    for (const entity of Object.values(sim.sim.state.players)) {
      for (const key of [
        'x',
        'y',
        'health',
        'hunger',
        'thirst',
        'fatigue',
        'stamina',
        'blood',
        'temperature',
      ] as const) {
        expect(Number.isFinite(entity[key]), `${key} should be finite`).toBe(true);
      }
      expect(entity.hunger).toBeGreaterThanOrEqual(0);
      expect(entity.hunger).toBeLessThanOrEqual(100);
      expect(entity.thirst).toBeGreaterThanOrEqual(0);
      expect(entity.thirst).toBeLessThanOrEqual(100);
      expect(entity.blood).toBeGreaterThanOrEqual(0);
      expect(entity.blood).toBeLessThanOrEqual(100);
    }
    for (const zombie of Object.values(sim.sim.state.zombies)) {
      expect(Number.isFinite(zombie.x) && Number.isFinite(zombie.y)).toBe(true);
      expect(zombie.health).toBeGreaterThanOrEqual(0);
    }
    // And the whole thing still round-trips through JSON, which the save path relies on.
    expect(() => JSON.parse(JSON.stringify(sim.sim.state))).not.toThrow();
  });

  it('is deterministic: two identical runs end in identical state', () => {
    const run = () => {
      const sim = createTestSimulation({ seed: 90210, flattenRadius: 30 });
      const player = sim.addPlayer({ id: 'p1' });
      sim.equip(player, 'baseball_bat');
      sim.spawnZombie('walker', player.x + 120, player.y);
      sim.spawnZombie('shambler', player.x - 140, player.y + 60);
      for (let i = 0; i < 40; i++) {
        sim.hold(
          player,
          { moveX: Math.sin(i / 5), moveY: Math.cos(i / 7), buttons: i % 4 === 0 ? 1 : 0 },
          5,
        );
      }
      return JSON.stringify(sim.sim.state);
    };
    expect(run()).toBe(run());
  });
});
