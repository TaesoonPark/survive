import { describe, expect, it } from 'vitest';
import {
  CHUNK_SIZE,
  SIM_HZ,
  TICKS_PER_GAME_HOUR,
  chunkKey,
  chunkKeyAtPixel,
  distance,
  pixelToChunk,
  rngForCoord,
  type ChunkActivity,
  type PlayerState,
} from '@survive/protocol';
import { createTestSimulation, type TestSimulation } from '@survive/test-utils';
import { ensureChunkRuntime } from '../../core/queries';
import { animalBudgetForChunk, createChunkPopulationSystem } from './chunkPopulation';
import { killZombie } from '../../core/death';
import {
  BASE_ZOMBIES_PER_CHUNK,
  CORPSE_LIFETIME_TICKS,
  HORDE_SALT,
  MAX_SPAWNS_PER_ROLL,
  MIN_SPAWN_DISTANCE,
  SPAWN_ROLL_INTERVAL_TICKS,
  ZOMBIE_DESPAWN_DISTANCE,
  createSpawnSystem,
  cullZombies,
  hordeChance,
  hordeSize,
  isConcealedSpawn,
  isFarFromPlayers,
  zombieBudgetForChunk,
} from './spawn';

/**
 * Population pressure.
 *
 * The tests below are mostly about two promises. The first is that nothing ever appears
 * where a player could be looking: every `zombieSpawned` event in this file is checked
 * against every living player for distance and sightline, because a walker fading in
 * eight metres ahead is the bug this whole subsystem exists to avoid. The second is that
 * population is a budget rather than a stream, so a long session trims itself instead of
 * accumulating.
 *
 * The flat test world is an open plain with no cover at all, which is the hardest case
 * for the concealment rule: the only thing that can hide a spawn out here is distance.
 */

/** Where the player stands: dead centre of chunk (100, 100), for clean arithmetic. */
const HOME = { cx: 100, cy: 100 } as const;
const HOME_X = HOME.cx * CHUNK_SIZE + CHUNK_SIZE / 2;
const HOME_Y = HOME.cy * CHUNK_SIZE + CHUNK_SIZE / 2;

interface Fixture {
  sim: TestSimulation;
  player: PlayerState;
  /** Wake every loaded chunk, which is normally the chunk system's job. */
  wake(activity?: ChunkActivity): void;
}

function fixture(
  options: {
    seed?: number;
    zombieDensity?: number;
    animalDensity?: number;
    day?: number;
    night?: boolean;
    withChunkSystem?: boolean;
  } = {},
): Fixture {
  const sim = createTestSimulation({
    seed: options.seed ?? 1234,
    spawn: { x: HOME_X, y: HOME_Y },
    systems: options.withChunkSystem
      ? [createSpawnSystem(), createChunkPopulationSystem()]
      : [createSpawnSystem()],
    config: (config) => {
      if (options.zombieDensity !== undefined) config.world.zombieDensity = options.zombieDensity;
      if (options.animalDensity !== undefined) config.world.animalDensity = options.animalDensity;
    },
  });
  const player = sim.addPlayer({ x: HOME_X, y: HOME_Y });
  if (options.day !== undefined) sim.sim.state.time.day = options.day;
  if (options.night !== undefined) sim.sim.state.time.isNight = options.night;

  return {
    sim,
    player,
    wake(activity: ChunkActivity = 'active') {
      // Without the chunk-population system nobody assigns an activity tier, and a
      // dormant chunk never rolls - so a spawn test that forgot this would pass by
      // spawning nothing at all.
      for (const runtime of Object.values(sim.sim.state.chunks)) {
        runtime.activity = activity;
        runtime.populated = true;
      }
    },
  };
}

/** Assert the concealment promise against every spawn the run produced. */
function expectAllSpawnsConcealed(fix: Fixture): number {
  const spawns = fix.sim.eventsOf('zombieSpawned');
  const aoi = fix.sim.config.network.aoiRadius;
  for (const spawn of spawns) {
    const away = distance(fix.player.x, fix.player.y, spawn.x, spawn.y);
    expect(away).toBeGreaterThanOrEqual(MIN_SPAWN_DISTANCE);
    if (away <= aoi) {
      // Inside the replicated area it has to be behind something.
      expect(fix.sim.world.hasLineOfSight(fix.player.x, fix.player.y, spawn.x, spawn.y)).toBe(
        false,
      );
    }
  }
  return spawns.length;
}

function zombieCount(sim: TestSimulation): number {
  return Object.keys(sim.sim.state.zombies).length;
}

describe('corpses are cleaned away', () => {
  /*
   * A corpse used to stay in the world forever, and the per-chunk population census counts
   * every record whose `homeChunk` matches whether or not it is breathing. So a chunk a
   * player had fought through stopped spawning, and because `topUpAnimals` shares that
   * census, a hunted-out chunk stopped regrowing wildlife. Eviction did not save it either:
   * `installChunk` restores the payload's dead entities verbatim and the save keeps them.
   *
   * `lod.ts` already described the intent - "a corpse only wakes up to be cleaned away" -
   * and nothing implemented it. These pin the implementation.
   */
  it('removes a body once its lifetime is up, and not before', () => {
    const fix = fixture();
    const zombie = fix.sim.spawnZombie('walker', fix.sim.spawn.x + 40, fix.sim.spawn.y);
    killZombie(fix.sim.ctx, zombie, 'blunt');
    expect(zombie.ai).toBe('dead');
    expect(zombie.deadTick).toBe(fix.sim.sim.state.tick);

    // Still there while it is fresh: nothing should vanish under the player who made it.
    fix.sim.step(Math.floor(CORPSE_LIFETIME_TICKS / 2));
    cullZombies(fix.sim.ctx);
    expect(fix.sim.sim.state.zombies[zombie.id]).toBeDefined();

    fix.sim.step(CORPSE_LIFETIME_TICKS);
    cullZombies(fix.sim.ctx);
    expect(fix.sim.sim.state.zombies[zombie.id]).toBeUndefined();
  });

  it("stops a body from consuming its chunk's spawn budget forever", () => {
    const fix = fixture();
    const key = chunkKeyAtPixel(fix.sim.spawn.x, fix.sim.spawn.y);

    // Fill the chunk's census with bodies, all homed to it.
    for (let i = 0; i < 8; i++) {
      const zombie = fix.sim.spawnZombie('walker', fix.sim.spawn.x + 40 + i * 12, fix.sim.spawn.y);
      zombie.homeChunk = key;
      killZombie(fix.sim.ctx, zombie, 'blunt');
    }
    const corpses = () =>
      Object.values(fix.sim.sim.state.zombies).filter((z) => z.ai === 'dead').length;
    expect(corpses()).toBe(8);

    fix.sim.step(CORPSE_LIFETIME_TICKS + 1);
    cullZombies(fix.sim.ctx);

    // The census is clear again, so the chunk can repopulate.
    expect(corpses()).toBe(0);
  });

  it('releases a reaped body from its horde rather than leaving a dangling id', () => {
    // `killZombie` does not touch horde membership, so reaping the record without releasing
    // it would leave the id in `horde.memberIds` pointing at nothing.
    const fix = fixture();
    const zombie = fix.sim.spawnZombie('walker', fix.sim.spawn.x + 40, fix.sim.spawn.y);
    const hordeId = 'h:test';
    zombie.hordeId = hordeId;
    fix.sim.sim.state.hordes[hordeId] = {
      id: hordeId,
      memberIds: [zombie.id],
      goalX: zombie.x,
      goalY: zombie.y,
      pathTick: fix.sim.sim.state.tick,
    };

    killZombie(fix.sim.ctx, zombie, 'blunt');
    fix.sim.step(CORPSE_LIFETIME_TICKS + 1);
    cullZombies(fix.sim.ctx);

    expect(fix.sim.sim.state.zombies[zombie.id]).toBeUndefined();
    const horde = fix.sim.sim.state.hordes[hordeId];
    expect(horde?.memberIds ?? []).not.toContain(zombie.id);
  });
});

describe('zombie budgets', () => {
  it('follows the biome weight', () => {
    const fix = fixture();
    const budget = zombieBudgetForChunk(fix.sim.ctx, HOME.cx, HOME.cy);
    // Grassland carries a 0.6 zombie weight, day 1, daytime, density 1.
    expect(budget).toBeCloseTo(BASE_ZOMBIES_PER_CHUNK * 0.6, 5);
  });

  it('rises with the day count', () => {
    const early = fixture({ day: 1 });
    const late = fixture({ day: 30 });
    expect(zombieBudgetForChunk(late.sim.ctx, HOME.cx, HOME.cy)).toBeGreaterThan(
      zombieBudgetForChunk(early.sim.ctx, HOME.cx, HOME.cy),
    );
  });

  it('stops rising eventually, so day 400 is not unplayable', () => {
    const late = fixture({ day: 60 });
    const absurd = fixture({ day: 4000 });
    expect(zombieBudgetForChunk(absurd.sim.ctx, HOME.cx, HOME.cy)).toBeCloseTo(
      zombieBudgetForChunk(late.sim.ctx, HOME.cx, HOME.cy),
      5,
    );
  });

  it('is worse at night', () => {
    const day = fixture({ day: 5, night: false });
    const night = fixture({ day: 5, night: true });
    expect(zombieBudgetForChunk(night.sim.ctx, HOME.cx, HOME.cy)).toBeCloseTo(
      zombieBudgetForChunk(day.sim.ctx, HOME.cx, HOME.cy) * 1.7,
      5,
    );
  });

  it('scales with the zombieDensity knob', () => {
    const quiet = fixture({ zombieDensity: 0.5 });
    const busy = fixture({ zombieDensity: 2 });
    expect(zombieBudgetForChunk(busy.sim.ctx, HOME.cx, HOME.cy)).toBeCloseTo(
      zombieBudgetForChunk(quiet.sim.ctx, HOME.cx, HOME.cy) * 4,
      5,
    );
  });

  it('is zero when the server asks for a world without zombies', () => {
    const fix = fixture({ zombieDensity: 0 });
    expect(zombieBudgetForChunk(fix.sim.ctx, HOME.cx, HOME.cy)).toBe(0);

    fix.wake();
    fix.sim.step(SPAWN_ROLL_INTERVAL_TICKS * 2);
    expect(zombieCount(fix.sim)).toBe(0);
  });
});

describe('routine spawning', () => {
  it('populates the area around a player', () => {
    const fix = fixture({ day: 6, zombieDensity: 2 });
    fix.wake();
    fix.sim.step(SPAWN_ROLL_INTERVAL_TICKS * 3);
    expect(zombieCount(fix.sim)).toBeGreaterThan(0);
  });

  it('never spawns one in a player s line of sight, nor too close', () => {
    const fix = fixture({ day: 20, zombieDensity: 3 });
    fix.wake();
    fix.sim.step(SPAWN_ROLL_INTERVAL_TICKS * 4);

    const spawned = expectAllSpawnsConcealed(fix);
    expect(spawned).toBeGreaterThan(0);
  });

  it('leaves an open plain inside the view radius empty rather than cheat', () => {
    const fix = fixture({ day: 20, zombieDensity: 4 });
    fix.wake();
    fix.sim.step(SPAWN_ROLL_INTERVAL_TICKS * 4);

    // Nothing to hide behind out here, so the whole area of interest stays clear.
    const aoi = fix.sim.config.network.aoiRadius;
    for (const zombie of Object.values(fix.sim.sim.state.zombies)) {
      expect(distance(fix.player.x, fix.player.y, zombie.x, zombie.y)).toBeGreaterThan(aoi);
    }
  });

  it('respects the second player as well as the first', () => {
    const fix = fixture({ day: 20, zombieDensity: 3 });
    const second = fix.sim.addPlayer({ id: 'p2', x: HOME_X + CHUNK_SIZE * 2, y: HOME_Y });
    fix.wake();
    fix.sim.step(SPAWN_ROLL_INTERVAL_TICKS * 3);

    for (const spawn of fix.sim.eventsOf('zombieSpawned')) {
      expect(distance(second.x, second.y, spawn.x, spawn.y)).toBeGreaterThanOrEqual(
        MIN_SPAWN_DISTANCE,
      );
    }
  });

  it('does not roll in a dormant chunk', () => {
    const fix = fixture({ day: 20, zombieDensity: 4 });
    fix.wake('dormant');
    fix.sim.step(SPAWN_ROLL_INTERVAL_TICKS * 3);
    expect(zombieCount(fix.sim)).toBe(0);
  });

  it('adds at most a couple per roll, so a chunk fills in gradually', () => {
    const fix = fixture({ day: 40, zombieDensity: 6 });
    fix.wake();

    // One tick is one roll per chunk at most, and every chunk starts ready to roll.
    const chunks = Object.keys(fix.sim.sim.state.chunks).length;
    fix.sim.step(1);
    expect(fix.sim.eventsOf('zombieSpawned').length).toBeLessThanOrEqual(
      chunks * MAX_SPAWNS_PER_ROLL,
    );
  });

  it('jitters the next roll so neighbouring chunks do not pulse in lockstep', () => {
    const fix = fixture({ day: 10 });
    fix.wake();
    fix.sim.step(1);

    const ticks = new Set(
      Object.values(fix.sim.sim.state.chunks).map((runtime) => runtime.nextSpawnTick),
    );
    expect(ticks.size).toBeGreaterThan(1);
    for (const tick of ticks) {
      expect(tick).toBeGreaterThanOrEqual(fix.sim.sim.state.tick + SPAWN_ROLL_INTERVAL_TICKS);
      expect(tick).toBeLessThanOrEqual(
        fix.sim.sim.state.tick + SPAWN_ROLL_INTERVAL_TICKS + SIM_HZ * 2,
      );
    }
  });

  it('grows the standing population with the day count', () => {
    const populationOn = (day: number, night: boolean): number => {
      const fix = fixture({ seed: 606, day, night, zombieDensity: 2 });
      fix.wake();
      // Long enough for several rolls and several culls to reach equilibrium.
      fix.sim.step(SPAWN_ROLL_INTERVAL_TICKS * 6);
      return zombieCount(fix.sim);
    };

    const earlyDay = populationOn(1, false);
    const lateDay = populationOn(30, false);
    expect(lateDay).toBeGreaterThan(earlyDay);
    // And the same day is worse once the sun goes down.
    expect(populationOn(30, true)).toBeGreaterThan(lateDay);
  });

  it('picks types the day count has unlocked, and no others', () => {
    const fix = fixture({ day: 2, zombieDensity: 5, night: false });
    fix.wake();
    fix.sim.step(SPAWN_ROLL_INTERVAL_TICKS * 4);

    const defIds = new Set(fix.sim.eventsOf('zombieSpawned').map((event) => event.defId));
    expect(defIds.size).toBeGreaterThan(0);
    for (const defId of defIds) {
      const def = fix.sim.data.zombies.require(defId);
      expect(def.minDay).toBeLessThanOrEqual(2);
      // Nothing nocturnal in broad daylight.
      expect(def.nightOnly).toBe(false);
    }
  });

  it('files each spawn under the chunk it stands in', () => {
    const fix = fixture({ day: 15, zombieDensity: 3 });
    fix.wake();
    fix.sim.step(SPAWN_ROLL_INTERVAL_TICKS * 2);

    const zombies = Object.values(fix.sim.sim.state.zombies);
    expect(zombies.length).toBeGreaterThan(0);
    for (const zombie of zombies) {
      expect(zombie.homeChunk).toBe(chunkKey(pixelToChunk(zombie.x), pixelToChunk(zombie.y)));
      expect(zombie.health).toBe(fix.sim.data.zombies.require(zombie.defId).maxHealth);
      expect(zombie.ai).toBe('idle');
    }
  });

  it('marks a chunk dirty when it rolls, so the roll timer survives a save', () => {
    const fix = fixture({ day: 10 });
    fix.wake();
    for (const runtime of Object.values(fix.sim.sim.state.chunks)) runtime.dirty = false;

    fix.sim.step(1);
    expect(Object.values(fix.sim.sim.state.chunks).every((runtime) => runtime.dirty)).toBe(true);
  });
});

describe('concealment helpers', () => {
  it('measures distance to the nearest living player', () => {
    const fix = fixture();
    expect(isFarFromPlayers(fix.sim.ctx, HOME_X + 100, HOME_Y, 420)).toBe(false);
    expect(isFarFromPlayers(fix.sim.ctx, HOME_X + 5000, HOME_Y, 420)).toBe(true);
  });

  it('ignores a dead player, who is not watching anything', () => {
    const fix = fixture();
    fix.player.alive = false;
    expect(isConcealedSpawn(fix.sim.ctx, HOME_X + 40, HOME_Y)).toBe(true);
  });

  it('refuses a clear sightline inside the area of interest', () => {
    const fix = fixture();
    const aoi = fix.sim.config.network.aoiRadius;
    expect(isConcealedSpawn(fix.sim.ctx, HOME_X + aoi - 100, HOME_Y)).toBe(false);
    expect(isConcealedSpawn(fix.sim.ctx, HOME_X + aoi + 100, HOME_Y)).toBe(true);
  });

  it('accepts a blocked sightline inside the area of interest', () => {
    const fix = fixture();
    const tileX = pixelToChunk(HOME_X) * 32 + 16;
    const tileY = pixelToChunk(HOME_Y) * 32 + 16;
    // A wall across the street, and a spot behind it.
    fix.sim.wall(tileX + 20, tileY - 10, tileX + 20, tileY + 10);
    expect(isConcealedSpawn(fix.sim.ctx, HOME_X + 22 * 32, HOME_Y)).toBe(true);
  });

  it('refuses anything nearer than the minimum, wall or no wall', () => {
    const fix = fixture();
    const tileX = pixelToChunk(HOME_X) * 32 + 16;
    const tileY = pixelToChunk(HOME_Y) * 32 + 16;
    fix.sim.wall(tileX + 2, tileY - 4, tileX + 2, tileY + 4);
    // Behind cover, but close enough to hear breathing.
    expect(isConcealedSpawn(fix.sim.ctx, HOME_X + 3 * 32, HOME_Y)).toBe(false);
  });
});

describe('culling', () => {
  /** Twenty zombies parked in one chunk, far enough away to be cullable. */
  function overpopulate(fix: Fixture, chunkX: number, count = 20) {
    const x = chunkX * CHUNK_SIZE + CHUNK_SIZE / 2;
    const y = HOME.cy * CHUNK_SIZE + CHUNK_SIZE / 2;
    return Array.from({ length: count }, (_, i) =>
      fix.sim.spawnZombie('walker', x + (i % 5) * 8, y + Math.floor(i / 5) * 8),
    );
  }

  it('trims a chunk nobody has visited in a long time', () => {
    const fix = fixture();
    overpopulate(fix, 150);
    expect(zombieCount(fix.sim)).toBe(20);

    const culled = cullZombies(fix.sim.ctx);
    expect(culled).toBe(20);
    expect(zombieCount(fix.sim)).toBe(0);
  });

  it('leaves zombies the player might be looking at alone', () => {
    const fix = fixture();
    fix.wake();
    // Right on top of the player: well inside the despawn distance.
    overpopulate(fix, HOME.cx);
    expect(distance(fix.player.x, fix.player.y, HOME_X, HOME_Y)).toBeLessThan(
      ZOMBIE_DESPAWN_DISTANCE,
    );

    cullZombies(fix.sim.ctx);
    expect(zombieCount(fix.sim)).toBe(20);
  });

  it('never deletes a zombie mid-chase', () => {
    const fix = fixture();
    const zombies = overpopulate(fix, 150);
    const hunter = zombies[0];
    if (!hunter) throw new Error('no zombies to hunt with');
    hunter.targetId = fix.player.id;

    cullZombies(fix.sim.ctx);
    expect(fix.sim.sim.state.zombies[hunter.id]).toBeDefined();
    expect(zombieCount(fix.sim)).toBe(1);
  });

  it('removes the furthest first', () => {
    const fix = fixture();
    const near = fix.sim.spawnZombie('walker', HOME_X + ZOMBIE_DESPAWN_DISTANCE + 100, HOME_Y);
    const far = fix.sim.spawnZombie('walker', HOME_X + ZOMBIE_DESPAWN_DISTANCE + 100, HOME_Y + 8);
    far.x = HOME_X + ZOMBIE_DESPAWN_DISTANCE * 4;
    far.homeChunk = near.homeChunk;

    // The chunk is unloaded, so its budget is zero and both are over it - but order
    // still matters when a budget only allows one to go.
    const runtime = ensureChunkRuntime(
      fix.sim.sim.state,
      pixelToChunk(near.x),
      pixelToChunk(near.y),
    );
    runtime.activity = 'low';
    const budget = Math.ceil(zombieBudgetForChunk(fix.sim.ctx, runtime.cx, runtime.cy));
    expect(budget).toBe(1);

    cullZombies(fix.sim.ctx);
    expect(fix.sim.sim.state.zombies[far.id]).toBeUndefined();
    expect(fix.sim.sim.state.zombies[near.id]).toBeDefined();
  });

  it('does nothing to a population inside its budget', () => {
    const fix = fixture({ day: 30, zombieDensity: 4 });
    fix.wake();
    const runtime = ensureChunkRuntime(fix.sim.sim.state, 150, HOME.cy);
    runtime.activity = 'low';
    const budget = Math.ceil(zombieBudgetForChunk(fix.sim.ctx, 150, HOME.cy));
    overpopulate(fix, 150, budget);

    expect(cullZombies(fix.sim.ctx)).toBe(0);
    expect(zombieCount(fix.sim)).toBe(budget);
  });

  it('runs on its own as the session goes on', () => {
    // Chunks left dormant on purpose: nothing new spawns, so what is left after the
    // sweep is exactly what the sweep decided to keep.
    const fix = fixture();
    overpopulate(fix, 150);
    fix.sim.step(SIM_HZ * 4);
    expect(zombieCount(fix.sim)).toBe(0);
  });

  it('drops a culled member out of its horde, and the horde once it is empty', () => {
    const fix = fixture();
    const zombies = overpopulate(fix, 150, 2);
    const [first, second] = zombies;
    if (!first || !second) throw new Error('expected two zombies');
    first.hordeId = 'test-horde';
    second.hordeId = 'test-horde';
    fix.sim.sim.state.hordes['test-horde'] = {
      id: 'test-horde',
      memberIds: [first.id, second.id],
      goalX: HOME_X,
      goalY: HOME_Y,
      pathTick: 0,
    };

    cullZombies(fix.sim.ctx);
    expect(fix.sim.sim.state.hordes['test-horde']).toBeUndefined();
  });
});

describe('night hordes', () => {
  /** The first night this seed promises a horde, and the first it does not. */
  function nights(seed: number): { loud: number; quiet: number } {
    let loud = -1;
    let quiet = -1;
    for (let day = 1; day <= 80 && (loud < 0 || quiet < 0); day++) {
      const rolled = rngForCoord(seed, day, 0, HORDE_SALT).chance(hordeChance(day));
      if (rolled && loud < 0) loud = day;
      if (!rolled && quiet < 0) quiet = day;
    }
    if (loud < 0 || quiet < 0) throw new Error(`seed ${seed} has no mixed nights`);
    return { loud, quiet };
  }

  /** Arm the night latch on a daytime tick, then let night fall. */
  function nightFalls(fix: Fixture, day: number): void {
    fix.sim.sim.state.time.day = day;
    fix.sim.sim.state.time.isNight = false;
    fix.sim.step(1);
    fix.sim.clearEvents();
    fix.sim.sim.state.time.isNight = true;
    fix.sim.step(1);
  }

  it('rises in likelihood with the day count, then plateaus', () => {
    expect(hordeChance(1)).toBeLessThan(hordeChance(10));
    expect(hordeChance(10)).toBeLessThan(hordeChance(20));
    expect(hordeChance(400)).toBe(0.6);
    expect(hordeChance(1)).toBeGreaterThan(0);
  });

  it('gets bigger with the day count, and stays within bounds', () => {
    const fix = fixture();
    expect(hordeSize(fix.sim.ctx, 20)).toBeGreaterThan(hordeSize(fix.sim.ctx, 1));
    expect(hordeSize(fix.sim.ctx, 10_000)).toBeLessThanOrEqual(40);

    const dense = fixture({ zombieDensity: 3 });
    expect(hordeSize(dense.sim.ctx, 5)).toBeGreaterThan(hordeSize(fix.sim.ctx, 5));

    const sparse = fixture({ zombieDensity: 0.01 });
    expect(hordeSize(sparse.sim.ctx, 1)).toBe(2);
  });

  it('arrives on the night the seed promised one', () => {
    const seed = 1234;
    const fix = fixture({ seed });
    fix.wake();
    nightFalls(fix, nights(seed).loud);

    const formed = fix.sim.lastEvent('hordeFormed');
    expect(formed).toBeDefined();
    expect(formed?.size).toBeGreaterThan(1);
    expect(fix.sim.sim.state.hordes[formed?.hordeId ?? '']).toBeDefined();
  });

  it('stays away on the nights it did not', () => {
    const seed = 1234;
    const fix = fixture({ seed });
    fix.wake();
    nightFalls(fix, nights(seed).quiet);
    expect(fix.sim.eventsOf('hordeFormed')).toEqual([]);
  });

  it('assembles out of sight and heads for the player', () => {
    const seed = 1234;
    const fix = fixture({ seed });
    fix.wake();
    nightFalls(fix, nights(seed).loud);

    const horde = fix.sim.sim.state.hordes[fix.sim.lastEvent('hordeFormed')?.hordeId ?? ''];
    expect(horde).toBeDefined();
    expect(horde?.goalX).toBe(fix.player.x);
    expect(horde?.goalY).toBe(fix.player.y);

    const aoi = fix.sim.config.network.aoiRadius;
    expect(horde?.memberIds.length).toBeGreaterThan(1);
    for (const id of horde?.memberIds ?? []) {
      const member = fix.sim.sim.state.zombies[id];
      expect(member).toBeDefined();
      expect(member?.hordeId).toBe(horde?.id);
      // Every one of them formed up beyond what the client can even see.
      expect(distance(fix.player.x, fix.player.y, member?.x ?? 0, member?.y ?? 0)).toBeGreaterThan(
        aoi,
      );
    }
  });

  it('only comes once a night', () => {
    const seed = 1234;
    const fix = fixture({ seed });
    fix.wake();
    nightFalls(fix, nights(seed).loud);
    const size = fix.sim.lastEvent('hordeFormed')?.size ?? 0;

    // Another dusk-to-dark flicker on the same day changes nothing.
    fix.sim.sim.state.time.isNight = false;
    fix.sim.step(1);
    fix.sim.sim.state.time.isNight = true;
    fix.sim.step(1);
    expect(fix.sim.eventsOf('hordeFormed')).toHaveLength(1);
    expect(fix.sim.lastEvent('hordeFormed')?.size).toBe(size);
  });

  it('does not conjure one for a save that was loaded after dark', () => {
    const seed = 1234;
    const fix = fixture({ seed, night: true, day: nights(1234).loud });
    fix.wake();
    // The latch arms on the first update without firing: it cannot tell a night that
    // just fell from a night that was already underway when the world loaded.
    fix.sim.step(5);
    expect(fix.sim.eventsOf('hordeFormed')).toEqual([]);
  });

  it('is a property of the world, not of when the player logged in', () => {
    const seed = 4711;
    const day = nights(seed).loud;
    const sizes = [0, 1].map(() => {
      const fix = fixture({ seed });
      fix.wake();
      nightFalls(fix, day);
      return fix.sim.lastEvent('hordeFormed')?.size;
    });
    expect(sizes[0]).toBe(sizes[1]);
    expect(sizes[0]).toBeGreaterThan(1);
  });

  it('needs a living player to march on', () => {
    const seed = 1234;
    const fix = fixture({ seed });
    fix.wake();
    fix.player.alive = false;
    nightFalls(fix, nights(seed).loud);
    expect(fix.sim.eventsOf('hordeFormed')).toEqual([]);
  });
});

describe('animal regrowth', () => {
  it('brings wildlife back over time, capped per chunk', () => {
    const fix = fixture();
    const away = { cx: 130, cy: HOME.cy };
    const runtime = ensureChunkRuntime(fix.sim.sim.state, away.cx, away.cy);
    runtime.activity = 'low';
    runtime.populated = true;

    const budget = Math.floor(animalBudgetForChunk(fix.sim.ctx, away.cx, away.cy));
    expect(budget).toBeGreaterThan(1);

    const key = chunkKey(away.cx, away.cy);
    const here = () =>
      Object.values(fix.sim.sim.state.animals).filter((animal) => animal.homeChunk === key).length;

    // One animal an in-game hour, so a full chunk takes most of a day.
    fix.sim.step(TICKS_PER_GAME_HOUR * 3 + 1);
    const partway = here();
    expect(partway).toBeGreaterThan(0);
    expect(partway).toBeLessThanOrEqual(budget);

    fix.sim.step(TICKS_PER_GAME_HOUR * (budget + 4));
    expect(here()).toBe(budget);
  });

  it('adds nothing to a chunk that was never populated', () => {
    const fix = fixture();
    const runtime = ensureChunkRuntime(fix.sim.sim.state, 131, HOME.cy);
    runtime.activity = 'low';
    runtime.populated = false;

    fix.sim.step(TICKS_PER_GAME_HOUR * 4);
    const key = chunkKey(131, HOME.cy);
    expect(
      Object.values(fix.sim.sim.state.animals).filter((animal) => animal.homeChunk === key),
    ).toEqual([]);
  });

  it('adds nothing to a dormant chunk', () => {
    const fix = fixture();
    const runtime = ensureChunkRuntime(fix.sim.sim.state, 132, HOME.cy);
    runtime.activity = 'dormant';
    runtime.populated = true;

    fix.sim.step(TICKS_PER_GAME_HOUR * 4);
    const key = chunkKey(132, HOME.cy);
    expect(
      Object.values(fix.sim.sim.state.animals).filter((animal) => animal.homeChunk === key),
    ).toEqual([]);
  });

  it('does not drop wildlife at the player s elbow', () => {
    const fix = fixture();
    fix.wake('low');
    fix.sim.step(TICKS_PER_GAME_HOUR * 6);

    for (const spawn of fix.sim.eventsOf('animalSpawned')) {
      expect(distance(fix.player.x, fix.player.y, spawn.x, spawn.y)).toBeGreaterThanOrEqual(
        MIN_SPAWN_DISTANCE,
      );
    }
  });

  it('respects animalDensity 0', () => {
    const fix = fixture({ animalDensity: 0 });
    fix.wake('low');
    fix.sim.step(TICKS_PER_GAME_HOUR * 4);
    expect(fix.sim.eventsOf('animalSpawned')).toEqual([]);
  });
});

describe('determinism', () => {
  it('spawns the same zombies in the same places from the same seed', () => {
    const runOnce = (): string => {
      const fix = fixture({ seed: 8080, day: 25, zombieDensity: 2 });
      fix.wake();
      fix.sim.step(SPAWN_ROLL_INTERVAL_TICKS * 3);
      return JSON.stringify(
        fix.sim
          .eventsOf('zombieSpawned')
          .map((event) => `${event.defId}@${event.x.toFixed(4)},${event.y.toFixed(4)}`),
      );
    };
    const first = runOnce();
    expect(first).toBe(runOnce());
    expect(first).not.toBe('[]');
  });

  it('forms the same horde from the same seed and day', () => {
    const runOnce = (): string => {
      const seed = 1234;
      const fix = fixture({ seed });
      fix.wake();
      let loud = 1;
      while (!rngForCoord(seed, loud, 0, HORDE_SALT).chance(hordeChance(loud))) loud++;
      fix.sim.sim.state.time.day = loud;
      fix.sim.sim.state.time.isNight = false;
      fix.sim.step(1);
      fix.sim.sim.state.time.isNight = true;
      fix.sim.step(1);
      return JSON.stringify(
        Object.values(fix.sim.sim.state.zombies)
          .filter((zombie) => zombie.hordeId !== undefined)
          .map((zombie) => `${zombie.defId}@${zombie.x.toFixed(4)},${zombie.y.toFixed(4)}`)
          .sort(),
      );
    };
    const first = runOnce();
    expect(first).toBe(runOnce());
    expect(first).not.toBe('[]');
  });

  it('gives different seeds different spawns', () => {
    const runOnce = (seed: number): string => {
      const fix = fixture({ seed, day: 25, zombieDensity: 2 });
      fix.wake();
      fix.sim.step(SPAWN_ROLL_INTERVAL_TICKS * 3);
      return JSON.stringify(
        fix.sim.eventsOf('zombieSpawned').map((event) => `${event.x.toFixed(4)}`),
      );
    };
    expect(runOnce(11)).not.toBe(runOnce(22));
  });
});

describe('running alongside chunk population', () => {
  it('fills a streamed-in world with nodes, animals and distant zombies', () => {
    const fix = fixture({ day: 12, zombieDensity: 2, withChunkSystem: true });
    fix.sim.step(SPAWN_ROLL_INTERVAL_TICKS * 3);

    expect(Object.keys(fix.sim.sim.state.nodes).length).toBeGreaterThan(0);
    expect(Object.keys(fix.sim.sim.state.animals).length).toBeGreaterThan(0);
    expect(zombieCount(fix.sim)).toBeGreaterThan(0);
    expectAllSpawnsConcealed(fix);
  });

  it('keeps the population bounded over a long session', () => {
    const fix = fixture({ day: 20, zombieDensity: 2, withChunkSystem: true });
    fix.sim.step(SPAWN_ROLL_INTERVAL_TICKS * 4);
    const settled = zombieCount(fix.sim);
    expect(settled).toBeGreaterThan(0);

    // Three times as long again must not mean three times as many.
    fix.sim.step(SPAWN_ROLL_INTERVAL_TICKS * 12);
    const later = zombieCount(fix.sim);
    const chunks = Object.keys(fix.sim.sim.state.chunks).length;

    // It may still creep, by a strictly bounded amount, and the bound is worth naming:
    // a chunk whose budget is 3.7 re-rolls its target every interval and asks for 4
    // roughly seven times in ten, so its population ratchets from floor to ceiling and
    // then stops. That is at most one extra zombie per chunk, ever - not a per-interval
    // drip, which is what an unbounded stream would look like here.
    expect(later).toBeLessThanOrEqual(settled + chunks);
    expect(later).toBeLessThan(settled * 2);

    // The real promise, stated exactly: the world holds no more zombies than the sum of
    // the per-chunk budgets they were spawned against. This fixture runs no time system,
    // so the clock - and therefore every chunk's budget - is stationary for the whole
    // run, which is what makes the comparison meaningful rather than a race against
    // nightfall.
    let budget = 0;
    for (const runtime of Object.values(fix.sim.sim.state.chunks)) {
      budget += Math.ceil(zombieBudgetForChunk(fix.sim.ctx, runtime.cx, runtime.cy));
    }
    expect(later).toBeLessThanOrEqual(budget);
  });
});
