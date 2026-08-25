import { describe, expect, it } from 'vitest';
import { distance, tileCenter } from '@survive/protocol';
import type { AnimalState } from '@survive/protocol';
import { createTestSimulation, type TestSimulation } from '@survive/test-utils';
import { damageAnimal } from '../../core/damage';
import {
  PACK_RADIUS,
  animalLod,
  animalSpeed,
  canFightBack,
  createAnimalAiSystem,
  isAnimalActive,
  isPackHunter,
} from './animalAi';
import { DORMANT_DISTANCE, LOD_TIER_BOUNDS, animalThinkInterval } from './lod';

/**
 * Animal AI behaviour, one describe block per `AnimalDef.behavior` value, because that
 * field is the entire contract: a player has to be able to tell a rabbit from a boar by
 * what it does when they walk towards it.
 *
 * Distances are chosen against the real table, and the relevant numbers are named in
 * each test so the geometry is checkable without opening `defs/animals.ts`:
 * rabbit `fleeRange` 220, cow 170, boar 110 / `sightRange` 300, wolf `sightRange` 420.
 */

const ANCHOR_TILE = 4104;
const CENTRE = tileCenter(ANCHOR_TILE);

function makeSim(): TestSimulation {
  return createTestSimulation({
    systems: [createAnimalAiSystem()],
    spawn: { x: CENTRE, y: CENTRE },
    flattenRadius: 48,
  });
}

/** Largest distance this animal ever got from where it started, over `ticks` ticks. */
function maxDisplacement(sim: TestSimulation, animal: AnimalState, ticks: number): number {
  const startX = animal.x;
  const startY = animal.y;
  let worst = 0;
  for (let i = 0; i < ticks; i++) {
    sim.step(1);
    worst = Math.max(worst, distance(startX, startY, animal.x, animal.y));
  }
  return worst;
}

describe('pure helpers', () => {
  it('floors the tier of an animal that is running or fighting', () => {
    expect(animalLod('flee', LOD_TIER_BOUNDS[2] * 2)).toBeLessThanOrEqual(1);
    expect(animalLod('attack', LOD_TIER_BOUNDS[2] * 2)).toBeLessThanOrEqual(1);
    expect(animalLod('alert', LOD_TIER_BOUNDS[2] * 2)).toBe(2);
    expect(animalLod('graze', LOD_TIER_BOUNDS[2] * 2)).toBe(3);
  });

  it('thinks fastest while bolting and slowest while grazing', () => {
    expect(animalThinkInterval('flee', 0)).toBeLessThan(animalThinkInterval('graze', 0));
    expect(animalThinkInterval('attack', 0)).toBeLessThanOrEqual(2);
    expect(animalThinkInterval('graze', 3)).toBeGreaterThan(animalThinkInterval('graze', 0));
  });

  it('knows which animals are armed', () => {
    const sim = makeSim();
    expect(canFightBack(sim.data.animals.require('rabbit'))).toBe(false);
    expect(canFightBack(sim.data.animals.require('chicken'))).toBe(false);
    expect(canFightBack(sim.data.animals.require('boar'))).toBe(true);
    expect(canFightBack(sim.data.animals.require('bear'))).toBe(true);
  });

  it('treats wolves as pack hunters and bears as loners', () => {
    const sim = makeSim();
    expect(isPackHunter(sim.data.animals.require('wolf'))).toBe(true);
    expect(isPackHunter(sim.data.animals.require('bear'))).toBe(false);
    expect(isPackHunter(sim.data.animals.require('deer'))).toBe(false);
  });

  it('runs at the run speed only when it has a reason to', () => {
    const sim = makeSim();
    const def = sim.data.animals.require('deer');
    const deer = sim.spawnAnimal('deer', CENTRE, CENTRE);
    deer.ai = 'graze';
    expect(animalSpeed(deer, def)).toBe(0);
    deer.ai = 'wander';
    expect(animalSpeed(deer, def)).toBe(def.speedWalk);
    deer.ai = 'flee';
    expect(animalSpeed(deer, def)).toBe(def.speedRun);
  });
});

describe('skittish animals', () => {
  it('bolt when a player comes inside flee range, and keep going', () => {
    const sim = makeSim();
    const player = sim.addPlayer({ x: CENTRE, y: CENTRE });
    // 150 px is well inside the rabbit's 220 px flee range.
    const rabbit = sim.spawnAnimal('rabbit', CENTRE + 150, CENTRE);

    sim.step(1);
    expect(rabbit.ai).toBe('flee');
    expect(rabbit.targetId).toBe(player.id);

    sim.step(40);
    expect(distance(rabbit.x, rabbit.y, player.x, player.y)).toBeGreaterThan(400);
  });

  it('spots a sprinter past the base range, whatever the spatial grid alignment', () => {
    // A sprinting player is visible at 1.3x range (MOVE_MODE_VISIBILITY.run), and the fine
    // check applies that - but the broadphase culled at the base range, so the wider band
    // was unreachable. Worse, the spatial query returns whole 128 px cells, so whether a
    // player in that band was culled depended on where they sat inside their cell: the same
    // distance either alerted the animal or did not.
    //
    // 250 px is outside the rabbit's 220 px base range and inside 220 x 1.3 = 286. Swept
    // across a whole cell so no single alignment can pass by luck.
    for (let offset = 0; offset < 128; offset += 16) {
      const sim = makeSim();
      const player = sim.addPlayer({ x: CENTRE + offset, y: CENTRE });
      const rabbit = sim.spawnAnimal('rabbit', player.x + 250, player.y);
      player.moveMode = 'run';

      sim.step(2);
      expect(rabbit.ai, `offset ${offset} should still spot a sprinter at 250 px`).toBe('flee');
    }
  });

  it('ignore a player who is far enough away', () => {
    const sim = makeSim();
    sim.addPlayer({ x: CENTRE, y: CENTRE });
    // 400 px is outside the 220 px flee range.
    const rabbit = sim.spawnAnimal('rabbit', CENTRE + 400, CENTRE);
    sim.step(10);
    expect(rabbit.ai).not.toBe('flee');
  });

  it('let a crouching player get much closer than a sprinting one', () => {
    // 150 px is inside 220 for a walker, outside 220 x 0.45 = 99 for a crouched player.
    const sneaking = makeSim();
    const sneaker = sneaking.addPlayer({ x: CENTRE, y: CENTRE });
    sneaker.moveMode = 'crouch';
    const unbothered = sneaking.spawnAnimal('rabbit', CENTRE + 150, CENTRE);
    sneaking.step(20);
    expect(unbothered.ai).not.toBe('flee');

    const stomping = makeSim();
    const stomper = stomping.addPlayer({ x: CENTRE, y: CENTRE });
    stomper.moveMode = 'run';
    const spooked = stomping.spawnAnimal('rabbit', CENTRE + 150, CENTRE);
    stomping.step(1);
    expect(spooked.ai).toBe('flee');
  });

  it('cannot be seen through a wall', () => {
    const sim = makeSim();
    sim.addPlayer({ x: CENTRE, y: CENTRE });
    const rabbit = sim.spawnAnimal('rabbit', CENTRE + 150, CENTRE);
    sim.wall(ANCHOR_TILE + 2, ANCHOR_TILE - 10, ANCHOR_TILE + 2, ANCHOR_TILE + 10);
    sim.step(10);
    expect(rabbit.ai).not.toBe('flee');
  });

  it('never fight back, even cornered', () => {
    const sim = makeSim();
    const player = sim.addPlayer({ x: CENTRE, y: CENTRE });
    sim.spawnAnimal('rabbit', CENTRE + 8, CENTRE);
    sim.step(60);
    expect(player.health).toBe(100);
    expect(sim.eventsOf('damage')).toHaveLength(0);
  });

  it('run after being hurt from out of sight', () => {
    const sim = makeSim();
    const player = sim.addPlayer({ x: CENTRE, y: CENTRE });
    // Shot from 600 px, far outside its 220 px flee range.
    const deer = sim.spawnAnimal('deer', CENTRE + 600, CENTRE);
    const before = distance(deer.x, deer.y, player.x, player.y);

    damageAnimal(sim.ctx, deer, { amount: 10, type: 'pierce', attackerId: player.id });
    expect(deer.ai).toBe('flee');

    sim.step(40);
    expect(distance(deer.x, deer.y, player.x, player.y)).toBeGreaterThan(before + 150);
  });

  it('run away from the shooter even when they were facing them', () => {
    const sim = makeSim();
    const player = sim.addPlayer({ x: CENTRE, y: CENTRE });
    const deer = sim.spawnAnimal('deer', CENTRE + 600, CENTRE);
    // Grazing with its head towards the player, and shot from out of every sense it
    // has. Running along its current heading would carry it into the shooter.
    deer.facing = Math.PI;
    const before = distance(deer.x, deer.y, player.x, player.y);

    damageAnimal(sim.ctx, deer, { amount: 10, type: 'pierce', attackerId: player.id });
    sim.step(40);

    expect(deer.ai).toBe('flee');
    expect(distance(deer.x, deer.y, player.x, player.y)).toBeGreaterThan(before);
  });
});

describe('passive animals', () => {
  it('look up but do not run', () => {
    const sim = makeSim();
    sim.addPlayer({ x: CENTRE, y: CENTRE });
    // 150 px is inside the cow's 170 px notice range.
    const cow = sim.spawnAnimal('cow', CENTRE + 150, CENTRE);

    const moved = maxDisplacement(sim, cow, 60);
    expect(cow.ai).toBe('alert');
    expect(moved).toBe(0);
  });

  it('bolt once actually hurt', () => {
    const sim = makeSim();
    const player = sim.addPlayer({ x: CENTRE, y: CENTRE });
    const cow = sim.spawnAnimal('cow', CENTRE + 150, CENTRE);
    sim.step(5);
    expect(cow.ai).toBe('alert');

    damageAnimal(sim.ctx, cow, { amount: 12, type: 'slash', attackerId: player.id });
    const before = distance(cow.x, cow.y, player.x, player.y);
    sim.step(40);
    expect(cow.ai).toBe('flee');
    expect(distance(cow.x, cow.y, player.x, player.y)).toBeGreaterThan(before);
  });
});

describe('territorial animals', () => {
  it('hold their ground at a distance', () => {
    const sim = makeSim();
    const player = sim.addPlayer({ x: CENTRE, y: CENTRE });
    // 200 px: inside the boar's 300 px sight, outside its 110 px tolerance.
    const boar = sim.spawnAnimal('boar', CENTRE + 200, CENTRE);

    const moved = maxDisplacement(sim, boar, 60);
    expect(boar.ai).toBe('alert');
    expect(moved).toBe(0);
    expect(player.health).toBe(100);
  });

  it('charge someone who crowds them', () => {
    const sim = makeSim();
    const player = sim.addPlayer({ x: CENTRE, y: CENTRE });
    // 80 px is inside the boar's 110 px tolerance: too close.
    const boar = sim.spawnAnimal('boar', CENTRE + 80, CENTRE);

    sim.step(1);
    expect(boar.ai).toBe('attack');
    expect(boar.targetId).toBe(player.id);

    sim.step(40);
    expect(player.health).toBeLessThan(100);
    expect(sim.eventsOf('attackSwing').some((e) => e.attackerId === boar.id)).toBe(true);
  });

  it('respect their own attack cooldown', () => {
    const sim = makeSim();
    sim.addPlayer({ x: CENTRE, y: CENTRE });
    const boar = sim.spawnAnimal('boar', CENTRE + 40, CENTRE);
    const def = sim.data.animals.require('boar');

    sim.step(def.attackTicks);
    const first = sim.eventsOf('damage').filter((e) => e.attackerId === boar.id).length;
    expect(first).toBeGreaterThanOrEqual(1);
    // Cooldown-limited: two full cooldowns can never yield more than three hits.
    sim.step(def.attackTicks * 2);
    const later = sim.eventsOf('damage').filter((e) => e.attackerId === boar.id).length;
    expect(later).toBeLessThanOrEqual(first + 2);
  });
});

describe('aggressive animals', () => {
  it('hunt a player they can see from across a clearing', () => {
    const sim = makeSim();
    const player = sim.addPlayer({ x: CENTRE, y: CENTRE });
    // 300 px is inside the wolf's 420 px sight.
    const wolf = sim.spawnAnimal('wolf', CENTRE + 300, CENTRE);

    sim.step(1);
    expect(wolf.ai).toBe('stalk');
    expect(wolf.targetId).toBe(player.id);

    sim.step(60);
    expect(distance(wolf.x, wolf.y, player.x, player.y)).toBeLessThan(60);
    expect(player.health).toBeLessThan(100);
  });

  it('discards a wind-up it broke off instead of landing it later with no warning', () => {
    // A queued bite was only ever expired inside `act`, and `act` is skipped for graze,
    // idle and alert. So a bite started and then broken off *froze*: it thawed on the tick
    // the animal next entered 'attack' and resolved immediately with no wind-up at all -
    // and since the pending map was empty again by then, a second bite started in the same
    // tick. Backing out of a wind-up has to work, the way it does for zombies.
    const sim = makeSim();
    const player = sim.addPlayer({ x: CENTRE, y: CENTRE });
    const wolf = sim.spawnAnimal('wolf', CENTRE + 30, CENTRE);
    wolf.targetId = player.id;
    wolf.ai = 'attack';

    // One tick to start a bite, while it is still mid-wind-up and nothing has landed.
    sim.step(1);
    expect(player.health).toBe(100);

    // Broken off, and parked in one of the three states whose `act` the loop skips - which
    // is the whole mechanism. The player is moved out of range so nothing re-acquires, and
    // `nextThinkTick` is pushed out so `think` does not reassign the state either; without
    // both, the animal passes through a state that *does* run `act`, the expiry fires
    // there, and the bite never freezes at all.
    player.x = player.x + 3000;
    wolf.ai = 'graze';
    delete wolf.targetId;
    wolf.nextThinkTick = sim.sim.state.tick + 10_000;
    sim.step(60);
    const healthAfterBreakOff = player.health;
    expect(healthAfterBreakOff, 'a broken-off bite must not land').toBe(100);

    // Back in its face. A fresh wind-up is required: the stale bite must not cash in on
    // contact the instant the animal is attacking again.
    player.x = wolf.x - 30;
    wolf.ai = 'attack';
    wolf.targetId = player.id;
    sim.clearEvents();
    sim.step(1);
    expect(player.health, 'the stale bite thawed and landed instantly').toBe(healthAfterBreakOff);
  });

  it('do not hunt what they cannot detect', () => {
    const sim = makeSim();
    const player = sim.addPlayer({ x: CENTRE, y: CENTRE });
    // 600 px is outside the wolf's 420 px sight.
    const wolf = sim.spawnAnimal('wolf', CENTRE + 600, CENTRE);
    sim.step(20);
    expect(wolf.ai).not.toBe('stalk');
    expect(wolf.targetId).toBeUndefined();
    expect(player.health).toBe(100);
  });

  it('join a hunt a pack-mate has already started', () => {
    const sim = makeSim();
    const player = sim.addPlayer({ x: CENTRE, y: CENTRE });
    // The first wolf has a clear view of the player.
    const leader = sim.spawnAnimal('wolf', CENTRE + 150, CENTRE);
    // The second does not - a wall stands between it and the player - but it is inside
    // both its own sight range of the player and pack range of the leader.
    const follower = sim.spawnAnimal('wolf', CENTRE, CENTRE + 300);
    sim.wall(ANCHOR_TILE - 3, ANCHOR_TILE + 5, ANCHOR_TILE + 3, ANCHOR_TILE + 5);
    expect(sim.world.hasLineOfSight(follower.x, follower.y, player.x, player.y)).toBe(false);
    expect(distance(follower.x, follower.y, leader.x, leader.y)).toBeLessThan(PACK_RADIUS);

    sim.step(1);
    expect(leader.targetId).toBe(player.id);
    expect(follower.targetId).toBe(player.id);
    expect(follower.ai).toBe('stalk');
  });

  it('stay put when there is no pack and no line of sight', () => {
    const sim = makeSim();
    const player = sim.addPlayer({ x: CENTRE, y: CENTRE });
    const loner = sim.spawnAnimal('wolf', CENTRE, CENTRE + 300);
    sim.wall(ANCHOR_TILE - 3, ANCHOR_TILE + 5, ANCHOR_TILE + 3, ANCHOR_TILE + 5);

    sim.step(10);
    expect(loner.targetId).toBeUndefined();
    expect(loner.ai).not.toBe('stalk');
    expect(player.health).toBe(100);
  });

  it('cannot bite through a wall', () => {
    const sim = makeSim();
    const player = sim.addPlayer({ x: CENTRE, y: CENTRE });
    const wolf = sim.spawnAnimal('wolf', CENTRE + 40, CENTRE);
    sim.wall(ANCHOR_TILE + 1, ANCHOR_TILE - 10, ANCHOR_TILE + 1, ANCHOR_TILE + 10);
    wolf.ai = 'attack';
    wolf.targetId = player.id;

    sim.step(60);
    expect(player.health).toBe(100);
  });
});

describe('nocturnal species', () => {
  it('reads the active window off the world clock', () => {
    const sim = makeSim();
    const fox = sim.data.animals.require('fox');
    const deer = sim.data.animals.require('deer');
    expect(fox.nocturnal).toBe(true);

    sim.ctx.state.time.isNight = false;
    expect(isAnimalActive(sim.ctx, fox)).toBe(false);
    expect(isAnimalActive(sim.ctx, deer)).toBe(true);

    sim.ctx.state.time.isNight = true;
    expect(isAnimalActive(sim.ctx, fox)).toBe(true);
    expect(isAnimalActive(sim.ctx, deer)).toBe(false);
  });

  it('rests by day and roams by night', () => {
    // 600 px from the player: not dormant, but well outside the fox's 260 px flee range,
    // so nothing but the clock decides what it does.
    const day = makeSim();
    day.addPlayer({ x: CENTRE, y: CENTRE });
    const resting = day.spawnAnimal('fox', CENTRE + 600, CENTRE);
    expect(maxDisplacement(day, resting, 400)).toBe(0);
    expect(resting.ai).toBe('graze');

    const night = makeSim();
    night.addPlayer({ x: CENTRE, y: CENTRE });
    night.ctx.state.time.isNight = true;
    const roaming = night.spawnAnimal('fox', CENTRE + 600, CENTRE);
    expect(maxDisplacement(night, roaming, 400)).toBeGreaterThan(20);
  });
});

describe('dormancy', () => {
  it('parks animals with no player within three chunks', () => {
    const sim = makeSim();
    sim.addPlayer({ x: CENTRE, y: CENTRE });
    const far = sim.spawnAnimal('deer', CENTRE + DORMANT_DISTANCE + 800, CENTRE);

    expect(maxDisplacement(sim, far, 200)).toBe(0);
    expect(far.ai).toBe('graze');
    expect(far.targetId).toBeUndefined();
  });
});

describe('determinism', () => {
  function digest(sim: TestSimulation): string {
    return Object.keys(sim.ctx.state.animals)
      .sort()
      .map((id) => {
        const a = sim.ctx.state.animals[id];
        if (!a) return `${id}:gone`;
        return [
          id,
          a.ai,
          a.lod,
          a.x.toFixed(6),
          a.y.toFixed(6),
          a.facing.toFixed(6),
          a.health,
          a.nextThinkTick,
          a.targetId ?? '-',
        ].join('|');
      })
      .join('\n');
  }

  function scenario(seed: number): TestSimulation {
    const sim = createTestSimulation({
      seed,
      systems: [createAnimalAiSystem()],
      spawn: { x: CENTRE, y: CENTRE },
      flattenRadius: 48,
    });
    sim.addPlayer({ x: CENTRE, y: CENTRE });
    const kinds = ['rabbit', 'deer', 'cow', 'boar', 'wolf', 'fox'] as const;
    for (let i = 0; i < 18; i++) {
      const kind = kinds[i % kinds.length] as string;
      sim.spawnAnimal(kind, CENTRE + 200 + i * 23, CENTRE - 160 + i * 19);
    }
    sim.step(300);
    return sim;
  }

  it('produces identical worlds from identical seeds', () => {
    expect(digest(scenario(3113))).toBe(digest(scenario(3113)));
  });

  it('produces different worlds from different seeds', () => {
    expect(digest(scenario(3113))).not.toBe(digest(scenario(777)));
  });
});

describe('cost at scale', () => {
  it('runs a herd of 200 for 200 ticks, with distant ones nearly free', () => {
    function buildHerd(offset: number): TestSimulation {
      const sim = createTestSimulation({
        systems: [createAnimalAiSystem()],
        spawn: { x: CENTRE, y: CENTRE },
        flattenRadius: 48,
        config: (config) => {
          config.tuning.playerDamageTaken = 0;
        },
      });
      sim.addPlayer({ x: CENTRE, y: CENTRE });
      for (let i = 0; i < 200; i++) {
        sim.spawnAnimal(
          i % 2 === 0 ? 'deer' : 'wolf',
          CENTRE + offset + (i % 20) * 30,
          CENTRE - 150 + Math.floor(i / 20) * 30,
        );
      }
      return sim;
    }

    const nearSim = buildHerd(-300);
    const nearStart = performance.now();
    nearSim.step(200);
    const near = performance.now() - nearStart;

    const farSim = buildHerd(DORMANT_DISTANCE + 2000);
    const farStart = performance.now();
    farSim.step(200);
    const far = performance.now() - farStart;

    expect(Object.values(farSim.ctx.state.animals).every((a) => a.ai === 'graze')).toBe(true);
    expect(near).toBeLessThan(8000);
    expect(far * 4).toBeLessThan(near);
  });
});
