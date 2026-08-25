import { describe, expect, it } from 'vitest';
import { TILE_SIZE, distance, tileCenter } from '@survive/protocol';
import type { PlayerState, ZombieState } from '@survive/protocol';
import { createTestSimulation, type TestSimulation } from '@survive/test-utils';
import { NoiseRadius, emitNoise } from '../../core/noise';
import { createProjectileSystem } from '../combat/projectiles';
import {
  DORMANT_DISTANCE,
  LOD_TIER_BOUNDS,
  SMOOTH_MOVEMENT_MAX_TIER,
  lodForDistance,
  nextThinkTickFor,
  zombieThinkInterval,
} from './lod';
import { HEARING_REFERENCE_RANGE, MOVE_MODE_VISIBILITY, playerVisibility } from './senses';
import { DIRECT_STEER_RANGE } from './steering';
import {
  HORDE_MIN_SIZE,
  HORDE_REGROUP_TICKS,
  createZombieAiSystem,
  isRangedZombie,
  zombieLod,
  zombieSpeed,
} from './zombieAi';

/**
 * Zombie AI behaviour.
 *
 * Every test here is written from the player's side of the screen: what the zombie
 * *does*, not which branch of the state machine it took. The one exception is the
 * scheduling arithmetic, which is a budget promise rather than a behaviour and so is
 * asserted directly.
 *
 * Positions are laid out from an explicit tile so the geometry in each test is
 * checkable by hand: the anchor sits mid-way through a horde cell and a long way from
 * any chunk boundary, and zombies are placed to the *left* of the player so the default
 * facing (+X) puts the player inside the vision cone.
 */

const ANCHOR_TILE = 4104;
const CENTRE = tileCenter(ANCHOR_TILE);

function makeSim(options: { systems?: ReturnType<typeof createZombieAiSystem>[] } = {}) {
  return createTestSimulation({
    systems: options.systems ?? [createZombieAiSystem()],
    spawn: { x: CENTRE, y: CENTRE },
    flattenRadius: 48,
  });
}

/** A player standing on the anchor and a zombie `offset` px to its left, facing it. */
function faceOff(
  sim: TestSimulation,
  defId = 'walker',
  offset = 100,
): { player: PlayerState; zombie: ZombieState } {
  const player = sim.addPlayer({ x: CENTRE, y: CENTRE });
  const zombie = sim.spawnZombie(defId, CENTRE - offset, CENTRE);
  return { player, zombie };
}

describe('LOD scheduling', () => {
  it('derives tiers from distance, tier 0 being about one chunk', () => {
    expect(lodForDistance(0)).toBe(0);
    expect(lodForDistance(LOD_TIER_BOUNDS[0])).toBe(0);
    expect(lodForDistance(LOD_TIER_BOUNDS[0] + 1)).toBe(1);
    expect(lodForDistance(LOD_TIER_BOUNDS[1] + 1)).toBe(2);
    expect(lodForDistance(LOD_TIER_BOUNDS[2] + 1)).toBe(3);
    expect(lodForDistance(Number.POSITIVE_INFINITY)).toBe(3);
  });

  it('floors the tier of a zombie that is busy, so a chase is never coarse', () => {
    // Three chunks away and chasing: still fine-grained enough to move every tick.
    expect(zombieLod('pursue', LOD_TIER_BOUNDS[2] * 2)).toBeLessThanOrEqual(
      SMOOTH_MOVEMENT_MAX_TIER,
    );
    expect(zombieLod('attack', LOD_TIER_BOUNDS[2] * 2)).toBeLessThanOrEqual(
      SMOOTH_MOVEMENT_MAX_TIER,
    );
    expect(zombieLod('investigate', LOD_TIER_BOUNDS[2] * 2)).toBe(2);
    expect(zombieLod('idle', LOD_TIER_BOUNDS[2] * 2)).toBe(3);
  });

  it('thinks faster the more urgent the state and the closer the player', () => {
    // Combat at 10 Hz, alerted at 5 Hz, idle at 1-2 Hz, dormant well below 1 Hz.
    expect(zombieThinkInterval('attack', 0)).toBeLessThanOrEqual(2);
    expect(zombieThinkInterval('alerted', 0)).toBeLessThanOrEqual(4);
    expect(zombieThinkInterval('idle', 0)).toBeLessThanOrEqual(20);
    expect(zombieThinkInterval('dormant', 0)).toBeGreaterThanOrEqual(40);
    // The same state costs less further away.
    expect(zombieThinkInterval('pursue', 3)).toBeGreaterThan(zombieThinkInterval('pursue', 0));
    expect(zombieThinkInterval('wander', 3)).toBeGreaterThan(zombieThinkInterval('wander', 0));
  });

  it('staggers a horde across the interval instead of spiking one tick', () => {
    const interval = 100;
    const ticks = new Set<number>();
    for (let i = 0; i < 200; i++) ticks.add(nextThinkTickFor(`z${i}`, 0, interval));
    // A phase per id, so a two-hundred-strong horde spreads over the whole period.
    expect(ticks.size).toBeGreaterThan(50);
    for (const tick of ticks) {
      expect(tick).toBeGreaterThan(0);
      expect(tick).toBeLessThanOrEqual(interval);
    }
  });

  it('always schedules a strictly future tick', () => {
    for (const interval of [1, 2, 5, 20, 200]) {
      for (let tick = 0; tick < 25; tick++) {
        expect(nextThinkTickFor('z7', tick, interval)).toBeGreaterThan(tick);
      }
    }
  });
});

describe('sight', () => {
  it('pursues a player it can see and closes the distance', () => {
    const sim = makeSim();
    const { player, zombie } = faceOff(sim, 'walker', 200);
    const before = distance(zombie.x, zombie.y, player.x, player.y);

    sim.step(1);
    expect(zombie.ai).toBe('pursue');
    expect(zombie.targetId).toBe(player.id);
    expect(sim.lastEvent('zombieAlerted')?.zombieId).toBe(zombie.id);

    sim.step(20);
    expect(distance(zombie.x, zombie.y, player.x, player.y)).toBeLessThan(before - 40);
  });

  it('ignores a player behind it: the vision cone is real', () => {
    const sim = makeSim();
    const player = sim.addPlayer({ x: CENTRE, y: CENTRE });
    // Facing +X by default, so a player 200 px to the *right* of the zombie is in the
    // cone and one 200 px to the left is not.
    const behind = sim.spawnZombie('walker', CENTRE + 200, CENTRE);
    sim.step(5);
    expect(behind.ai).not.toBe('pursue');
    expect(behind.targetId).toBeUndefined();
    expect(player.health).toBe(100);
  });

  it('notices a player it has walked into regardless of facing', () => {
    const sim = makeSim();
    const player = sim.addPlayer({ x: CENTRE, y: CENTRE });
    // Inside contact range (radius + player radius + 8 = 31 px) but behind the head.
    const zombie = sim.spawnZombie('walker', CENTRE + 24, CENTRE);
    sim.step(1);
    expect(zombie.ai).toBe('attack');
    expect(zombie.targetId).toBe(player.id);
  });

  it('makes crouching much harder to spot than sprinting', () => {
    // 200 px is inside the walker's 340 px sight when sprinting (x1.3) but outside it
    // when crouching (x0.45).
    const crouching = makeSim();
    const crouched = faceOff(crouching, 'walker', 200);
    crouched.player.moveMode = 'crouch';
    crouching.step(10);
    expect(crouched.zombie.ai).not.toBe('pursue');

    const sprinting = makeSim();
    const sprinted = faceOff(sprinting, 'walker', 200);
    sprinted.player.moveMode = 'run';
    sprinting.step(1);
    expect(sprinted.zombie.ai).toBe('pursue');
  });

  it('scales visibility by stance and by the stealth skill', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    player.moveMode = 'walk';
    expect(playerVisibility(player)).toBeCloseTo(MOVE_MODE_VISIBILITY.walk, 6);

    player.moveMode = 'crouch';
    const crouchOnly = playerVisibility(player);
    expect(crouchOnly).toBeCloseTo(MOVE_MODE_VISIBILITY.crouch, 6);

    player.skills.stealth.level = 8;
    expect(playerVisibility(player)).toBeLessThan(crouchOnly);
  });

  it('halves sight range in the dark', () => {
    const dark = makeSim();
    const night = faceOff(dark, 'walker', 300);
    dark.ctx.state.time.lightLevel = 0;
    dark.ctx.state.time.isNight = true;
    dark.step(10);
    expect(night.zombie.ai).not.toBe('pursue');

    const bright = makeSim();
    const day = faceOff(bright, 'walker', 300);
    bright.step(1);
    expect(day.zombie.ai).toBe('pursue');
  });
});

describe('losing sight', () => {
  it('investigates the last known position, then loses interest', () => {
    const sim = makeSim();
    const { player, zombie } = faceOff(sim, 'walker', 100);
    // Close enough that navigation steers straight at the goal rather than pathing
    // around, which is what puts the zombie face-first into the wall.
    expect(distance(zombie.x, zombie.y, player.x, player.y)).toBeLessThan(DIRECT_STEER_RANGE);

    sim.step(1);
    expect(zombie.ai).toBe('pursue');

    // A wall long enough that there is no way round it inside a flow field.
    sim.wall(ANCHOR_TILE - 2, ANCHOR_TILE - 40, ANCHOR_TILE - 2, ANCHOR_TILE + 40);
    expect(sim.world.hasLineOfSight(zombie.x, zombie.y, player.x, player.y)).toBe(false);

    sim.step(10);
    expect(zombie.ai).toBe('investigate');
    expect(zombie.investigateX).toBeCloseTo(player.x, 0);

    const patience = sim.data.zombies.require('walker').loseInterestTicks;
    sim.step(patience + 40);
    expect(['wander', 'idle']).toContain(zombie.ai);
    expect(zombie.targetId).toBeUndefined();
    expect(player.health).toBe(100);
  });
});

describe('hearing', () => {
  it('pulls a zombie across the map for a gunshot', () => {
    const sim = makeSim();
    const player = sim.addPlayer({ x: CENTRE, y: CENTRE });
    // Well out of sight, and facing away from the player for good measure.
    const zombie = sim.spawnZombie('walker', CENTRE + 1200, CENTRE);
    const before = distance(zombie.x, zombie.y, player.x, player.y);

    emitNoise(sim.ctx, player.x, player.y, NoiseRadius.Gunshot, 1, player.id);
    sim.step(1);

    expect(zombie.ai).toBe('alerted');
    expect(zombie.investigateX).toBeCloseTo(player.x, 0);
    expect(sim.lastEvent('zombieAlerted')?.zombieId).toBe(zombie.id);

    sim.step(60);
    expect(distance(zombie.x, zombie.y, player.x, player.y)).toBeLessThan(before);
  });

  it('ignores a footstep from the same distance', () => {
    const sim = makeSim();
    const player = sim.addPlayer({ x: CENTRE, y: CENTRE });
    const zombie = sim.spawnZombie('walker', CENTRE + 1200, CENTRE);
    const startX = zombie.x;

    emitNoise(sim.ctx, player.x, player.y, NoiseRadius.Footstep, 0.5, player.id);
    sim.step(5);

    expect(zombie.ai).not.toBe('alerted');
    expect(zombie.investigateX).toBeUndefined();
    expect(zombie.x).toBe(startX);
  });

  it('gives keener ears a wider earshot', () => {
    // A feral dog (700) has to hear something a walker (520) misses, at the same range.
    const range = HEARING_REFERENCE_RANGE * 1.2;
    const walkerSim = makeSim();
    walkerSim.addPlayer({ x: CENTRE, y: CENTRE });
    const walker = walkerSim.spawnZombie('walker', CENTRE + range, CENTRE);
    emitNoise(walkerSim.ctx, CENTRE, CENTRE, HEARING_REFERENCE_RANGE, 1);
    walkerSim.step(1);
    expect(walker.ai).not.toBe('alerted');

    const dogSim = makeSim();
    dogSim.addPlayer({ x: CENTRE, y: CENTRE });
    const dog = dogSim.spawnZombie('feral_dog_zombie', CENTRE + range, CENTRE);
    emitNoise(dogSim.ctx, CENTRE, CENTRE, HEARING_REFERENCE_RANGE, 1);
    dogSim.step(1);
    expect(dog.ai).toBe('alerted');
  });

  it('hears another zombie breaking into a base', () => {
    const sim = makeSim();
    const player = sim.addPlayer({ x: CENTRE, y: CENTRE });
    const wall = sim.placeStructure('wall_wood', ANCHOR_TILE - 2, ANCHOR_TILE, 0, player.id);
    expect(wall).not.toBeNull();

    // The breacher already knows where the player is and walks face-first into the wall
    // in the way. No player noise is emitted, so the wall is the only thing making one.
    const breacher = sim.spawnZombie('walker', CENTRE - 100, CENTRE);
    breacher.ai = 'pursue';
    breacher.targetId = player.id;
    breacher.lastSeenX = player.x;
    breacher.lastSeenY = player.y;
    breacher.loseInterestTick = 10_000;

    // Inside earshot of the wall being hit, and turned away from the player so the
    // vision cone cannot be what recruits it.
    const bystander = sim.spawnZombie('walker', CENTRE - 100, CENTRE - 150);
    bystander.facing = Math.PI;

    // Drained every tick, exactly as a real server does. That throws the event array
    // away between ticks, so the only way the bystander can hear a noise the AI itself
    // emitted is the feed's own carry-over buffer.
    for (let i = 0; i < 40; i++) {
      sim.step(1);
      sim.sim.drainEvents();
    }

    expect(
      sim.eventsOf('structureDamaged').filter((e) => e.structureId === wall?.id).length,
    ).toBeGreaterThan(0);
    // The AI's own noise reached the rest of the horde: that is what turns one zombie
    // chewing on a wall into a crowd at the gate. A hearing alert carries no target;
    // a sighting would, so this also proves it was the sound and not the player.
    const alerts = sim.eventsOf('zombieAlerted').filter((e) => e.zombieId === bystander.id);
    expect(alerts.length).toBeGreaterThan(0);
    expect(alerts[0]?.targetId).toBeUndefined();
    expect(bystander.ai).not.toBe('idle');
  });

  it("lets a screamer's aggro spread to its neighbours", () => {
    const sim = makeSim();
    const player = sim.addPlayer({ x: CENTRE, y: CENTRE });
    const screamer = sim.spawnZombie('screamer', CENTRE - 200, CENTRE);
    // Facing away from the player, so it can only join in because it was called.
    const bystander = sim.spawnZombie('walker', CENTRE - 900, CENTRE);
    bystander.facing = Math.PI;

    sim.step(1);
    expect(screamer.ai).toBe('pursue');
    expect(bystander.ai).toBe('alerted');
    expect(bystander.investigateX).toBeCloseTo(player.x, 0);
  });
});

describe('dormancy', () => {
  it('switches off zombies with no player within three chunks', () => {
    const sim = makeSim();
    sim.addPlayer({ x: CENTRE, y: CENTRE });
    const far = sim.spawnZombie('walker', CENTRE + LOD_TIER_BOUNDS[2] + 1000, CENTRE);
    const startX = far.x;
    const startY = far.y;

    sim.step(200);
    expect(far.ai).toBe('dormant');
    expect(far.x).toBe(startX);
    expect(far.y).toBe(startY);
    expect(far.lod).toBe(3);
  });

  it('wakes a dormant zombie when a player walks into range', () => {
    const sim = makeSim();
    const player = sim.addPlayer({ x: CENTRE, y: CENTRE });
    const zombie = sim.spawnZombie('walker', CENTRE + DORMANT_DISTANCE + 500, CENTRE);
    sim.step(100);
    expect(zombie.ai).toBe('dormant');

    // Teleport the player next to it, the way chunk streaming would.
    player.x = zombie.x - 100;
    player.y = zombie.y;
    zombie.facing = Math.PI;
    sim.step(100);
    expect(zombie.ai).not.toBe('dormant');
  });
});

describe('attacking', () => {
  it('damages a player in reach and respects the attack cooldown', () => {
    const sim = makeSim();
    const { player, zombie } = faceOff(sim, 'walker', 24);
    const def = sim.data.zombies.require('walker');

    // Nothing lands during the wind-up.
    sim.step(def.windupTicks - 1);
    expect(sim.eventsOf('damage').filter((e) => e.attackerId === zombie.id)).toHaveLength(0);

    sim.step(2);
    const firstHits = sim.eventsOf('damage').filter((e) => e.attackerId === zombie.id);
    expect(firstHits).toHaveLength(1);
    expect(player.health).toBeLessThan(100);

    // One swing per `attackTicks`, no more: half a cooldown later, still one hit.
    sim.step(Math.floor(def.attackTicks / 2));
    expect(sim.eventsOf('damage').filter((e) => e.attackerId === zombie.id)).toHaveLength(1);

    sim.step(def.attackTicks);
    expect(
      sim.eventsOf('damage').filter((e) => e.attackerId === zombie.id).length,
    ).toBeGreaterThanOrEqual(2);
  });

  it('does not reach a player who is out of range', () => {
    const sim = makeSim();
    const { player, zombie } = faceOff(sim, 'walker', 300);
    // 300 px at 82 px/s is well over a second of closing, so nothing can land yet.
    sim.step(10);
    expect(zombie.ai).toBe('pursue');
    expect(player.health).toBe(100);
    expect(sim.eventsOf('damage')).toHaveLength(0);
  });

  /*
   * There is deliberately no "cannot swing through a wall" test here.
   *
   * One used to exist, placing the zombie 40 px from the player with a wall between. It
   * passed only because the test double froze a body embedded in geometry: 40 px puts the
   * zombie *inside* the wall tile, and the real collision grid lets an embedded body walk
   * out - straight into the player's tile, where the wall no longer separates anything.
   *
   * The scenario is unreachable at this scale. A walker reaches 30 px plus 11 px of grace,
   * while a zombie standing clear of a 32 px wall is at least 60 px from a player on the
   * far side, so nothing is ever both in reach and behind cover.
   *
   * The line-of-sight rules are tested where the geometry permits it: `senses.test.ts`
   * covers a wall blocking `canSeePlayer` and `findVisiblePlayer` at sight-range distances,
   * and `combat.test.ts` covers a player's own swing being stopped by a wall.
   */

  it('scales the damage a player takes by the tuning dial', () => {
    const soft = createTestSimulation({
      systems: [createZombieAiSystem()],
      spawn: { x: CENTRE, y: CENTRE },
      config: (config) => {
        config.tuning.playerDamageTaken = 2;
      },
    });
    const softPlayer = soft.addPlayer({ x: CENTRE, y: CENTRE });
    soft.spawnZombie('walker', CENTRE - 24, CENTRE);
    soft.step(12);

    const hard = createTestSimulation({
      systems: [createZombieAiSystem()],
      spawn: { x: CENTRE, y: CENTRE },
      config: (config) => {
        config.tuning.playerDamageTaken = 0.25;
      },
    });
    const hardPlayer = hard.addPlayer({ x: CENTRE, y: CENTRE });
    hard.spawnZombie('walker', CENTRE - 24, CENTRE);
    hard.step(12);

    expect(100 - softPlayer.health).toBeGreaterThan(100 - hardPlayer.health);
  });

  it('infects through a bite when the dial is turned up', () => {
    const sim = createTestSimulation({
      systems: [createZombieAiSystem()],
      spawn: { x: CENTRE, y: CENTRE },
      config: (config) => {
        config.tuning.infectionChance = 1;
      },
    });
    const player = sim.addPlayer({ x: CENTRE, y: CENTRE });
    // A feral dog bites four attacks in five and closes fast.
    sim.spawnZombie('feral_dog_zombie', CENTRE - 20, CENTRE);
    sim.step(120);

    expect(sim.eventsOf('bitten').length).toBeGreaterThan(0);
    const infected = Object.values(player.body.parts).some((part) => part.infection > 0);
    expect(infected).toBe(true);
  });

  it('never infects when the dial is off', () => {
    const sim = createTestSimulation({
      systems: [createZombieAiSystem()],
      spawn: { x: CENTRE, y: CENTRE },
      config: (config) => {
        config.tuning.infectionChance = 0;
      },
    });
    const player = sim.addPlayer({ x: CENTRE, y: CENTRE });
    sim.spawnZombie('feral_dog_zombie', CENTRE - 20, CENTRE);
    sim.step(120);

    expect(sim.eventsOf('bitten').length).toBeGreaterThan(0);
    const infected = Object.values(player.body.parts).some((part) => part.infection > 0);
    expect(infected).toBe(false);
  });

  it('spits instead of swinging when the definition is ranged', () => {
    const sim = createTestSimulation({
      systems: [createZombieAiSystem(), createProjectileSystem()],
      spawn: { x: CENTRE, y: CENTRE },
      flattenRadius: 48,
    });
    // The brute has the longest melee reach in the table and must stay melee.
    expect(isRangedZombie(sim.data.zombies.require('spitter'))).toBe(true);
    expect(isRangedZombie(sim.data.zombies.require('brute'))).toBe(false);

    const player = sim.addPlayer({ x: CENTRE, y: CENTRE });
    const spitter = sim.spawnZombie('spitter', CENTRE - 200, CENTRE);
    sim.step(60);

    expect(spitter.ai).toBe('attack');
    const fired = sim.eventsOf('projectileFired').filter((e) => e.ownerId === spitter.id);
    expect(fired.length).toBeGreaterThan(0);
    expect(fired[0]?.defId).toBe('spitter_bile');
    // And the bile actually arrives.
    expect(player.health).toBeLessThan(100);
  });
});

describe('structures', () => {
  it('smashes a wall that stands between it and its goal', () => {
    const sim = makeSim();
    const player = sim.addPlayer({ x: CENTRE, y: CENTRE });
    const wall = sim.placeStructure('wall_wood', ANCHOR_TILE - 2, ANCHOR_TILE, 0, player.id);
    expect(wall).not.toBeNull();
    const zombie = sim.spawnZombie('walker', CENTRE - 100, CENTRE);

    // It cannot see through the wall, so hearing is what sends it that way.
    emitNoise(sim.ctx, player.x, player.y, NoiseRadius.Gunshot, 1, player.id);
    sim.step(30);

    const damaged = sim.eventsOf('structureDamaged').filter((e) => e.structureId === wall?.id);
    expect(damaged.length).toBeGreaterThan(0);
    expect(wall?.health).toBeLessThan(wall?.maxHealth ?? 0);
    expect(zombie.ai).not.toBe('dormant');
    // The player behind it is untouched: that is what the wall bought.
    expect(player.health).toBe(100);
  });

  it('opens a door instead of smashing it when it has the hands for it', () => {
    const sim = makeSim();
    const player = sim.addPlayer({ x: CENTRE, y: CENTRE });
    const door = sim.placeStructure('door_wood', ANCHOR_TILE - 2, ANCHOR_TILE, 0, player.id);
    expect(door?.door?.open).toBe(false);
    sim.spawnZombie('runner', CENTRE - 100, CENTRE);

    emitNoise(sim.ctx, player.x, player.y, NoiseRadius.Gunshot, 1, player.id);
    sim.step(20);

    expect(door?.door?.open).toBe(true);
    expect(sim.lastEvent('doorToggled')?.open).toBe(true);
    expect(door?.health).toBe(door?.maxHealth);
    expect(sim.eventsOf('structureDamaged').filter((e) => e.structureId === door?.id)).toHaveLength(
      0,
    );
  });

  it('breaks a door down when it cannot work a handle', () => {
    const sim = makeSim();
    const player = sim.addPlayer({ x: CENTRE, y: CENTRE });
    const door = sim.placeStructure('door_wood', ANCHOR_TILE - 2, ANCHOR_TILE, 0, player.id);
    // A walker has no `canOpenDoors`, so it has one other option.
    sim.spawnZombie('walker', CENTRE - 100, CENTRE);

    emitNoise(sim.ctx, player.x, player.y, NoiseRadius.Gunshot, 1, player.id);
    sim.step(40);

    expect(door?.door?.open).toBe(false);
    expect(
      sim.eventsOf('structureDamaged').filter((e) => e.structureId === door?.id).length,
    ).toBeGreaterThan(0);
  });

  it('leaves an indestructible obstacle alone', () => {
    const sim = makeSim();
    const player = sim.addPlayer({ x: CENTRE, y: CENTRE });
    // A crawler has `attacksStructures: false`: it goes round, or it goes nowhere.
    const wall = sim.placeStructure('wall_stone', ANCHOR_TILE - 2, ANCHOR_TILE, 0, player.id);
    sim.spawnZombie('crawler', CENTRE - 100, CENTRE);

    emitNoise(sim.ctx, player.x, player.y, NoiseRadius.Gunshot, 1, player.id);
    sim.step(40);

    expect(wall?.health).toBe(wall?.maxHealth);
  });
});

describe('hordes', () => {
  it('groups pursuers onto one shared goal', () => {
    const sim = makeSim();
    const player = sim.addPlayer({ x: CENTRE, y: CENTRE });
    const pack: ZombieState[] = [];
    for (let i = 0; i < 5; i++) {
      pack.push(sim.spawnZombie('walker', CENTRE - 160, CENTRE - 60 + i * 30));
    }

    sim.step(HORDE_REGROUP_TICKS + 1);

    const formed = sim.eventsOf('hordeFormed');
    expect(formed.length).toBe(1);
    const hordeId = formed[0]?.hordeId;
    expect(hordeId).toBeDefined();
    for (const zombie of pack) expect(zombie.hordeId).toBe(hordeId);

    const horde = sim.ctx.state.hordes[hordeId as string];
    expect(horde?.memberIds).toHaveLength(pack.length);
    expect(horde?.goalX).toBeCloseTo(player.x, 0);
    expect(horde?.goalY).toBeCloseTo(player.y, 0);
  });

  it('does not call two zombies a horde', () => {
    const sim = makeSim();
    sim.addPlayer({ x: CENTRE, y: CENTRE });
    const few: ZombieState[] = [];
    for (let i = 0; i < HORDE_MIN_SIZE - 1; i++) {
      few.push(sim.spawnZombie('walker', CENTRE - 160, CENTRE - 20 + i * 40));
    }

    sim.step(HORDE_REGROUP_TICKS + 1);
    expect(sim.eventsOf('hordeFormed')).toHaveLength(0);
    for (const zombie of few) expect(zombie.hordeId).toBeUndefined();
  });

  it('disbands a horde when its members stop chasing', () => {
    const sim = makeSim();
    const player = sim.addPlayer({ x: CENTRE, y: CENTRE });
    const pack: ZombieState[] = [];
    for (let i = 0; i < 4; i++) {
      pack.push(sim.spawnZombie('walker', CENTRE - 160, CENTRE - 45 + i * 30));
    }
    sim.step(HORDE_REGROUP_TICKS + 1);
    expect(pack[0]?.hordeId).toBeDefined();

    // The player is gone; patience runs out; the group dissolves.
    player.alive = false;
    sim.step(sim.data.zombies.require('walker').loseInterestTicks + HORDE_REGROUP_TICKS * 3);
    for (const zombie of pack) expect(zombie.hordeId).toBeUndefined();
    expect(Object.keys(sim.ctx.state.hordes)).toHaveLength(0);
  });
});

describe('crawling', () => {
  it('moves a legless zombie at its crawl speed', () => {
    const sim = makeSim();
    const def = sim.data.zombies.require('walker');
    const player = sim.addPlayer({ x: CENTRE, y: CENTRE });

    const upright = sim.spawnZombie('walker', CENTRE - 250, CENTRE - 100);
    const crawler = sim.spawnZombie('walker', CENTRE - 250, CENTRE + 100);
    crawler.body.parts.leftLeg.health = 0;
    crawler.body.parts.rightLeg.health = 0;
    crawler.crawling = true;

    expect(zombieSpeed(crawler, def)).toBeCloseTo(def.speedWalk * def.crawlSpeedMultiplier, 6);

    const uprightStart = distance(upright.x, upright.y, player.x, player.y);
    const crawlerStart = distance(crawler.x, crawler.y, player.x, player.y);
    sim.step(40);
    const uprightGain = uprightStart - distance(upright.x, upright.y, player.x, player.y);
    const crawlerGain = crawlerStart - distance(crawler.x, crawler.y, player.x, player.y);

    expect(uprightGain).toBeGreaterThan(0);
    expect(crawlerGain).toBeGreaterThan(0);
    expect(crawlerGain).toBeLessThan(uprightGain * 0.75);
  });
});

describe('separation', () => {
  it('keeps a crowd of chasers from collapsing onto one pixel', () => {
    const sim = makeSim();
    sim.addPlayer({ x: CENTRE, y: CENTRE });
    const pack: ZombieState[] = [];
    for (let i = 0; i < 6; i++) {
      // Deliberately almost stacked, and far enough out to still be closing at the end.
      pack.push(sim.spawnZombie('walker', CENTRE - 300 - i, CENTRE - 3 + i));
    }
    sim.step(30);

    let minGap = Number.POSITIVE_INFINITY;
    for (let i = 0; i < pack.length; i++) {
      for (let j = i + 1; j < pack.length; j++) {
        const a = pack[i] as ZombieState;
        const b = pack[j] as ZombieState;
        minGap = Math.min(minGap, distance(a.x, a.y, b.x, b.y));
      }
    }
    expect(minGap).toBeGreaterThan(TILE_SIZE * 0.15);
  });
});

describe('determinism', () => {
  function digest(sim: TestSimulation): string {
    return Object.keys(sim.ctx.state.zombies)
      .sort()
      .map((id) => {
        const z = sim.ctx.state.zombies[id];
        if (!z) return `${id}:gone`;
        return [
          id,
          z.ai,
          z.lod,
          z.x.toFixed(6),
          z.y.toFixed(6),
          z.facing.toFixed(6),
          z.health,
          z.nextThinkTick,
          z.hordeId ?? '-',
        ].join('|');
      })
      .join('\n');
  }

  function scenario(seed: number): TestSimulation {
    const sim = createTestSimulation({
      seed,
      systems: [createZombieAiSystem()],
      spawn: { x: CENTRE, y: CENTRE },
      flattenRadius: 48,
    });
    const player = sim.addPlayer({ x: CENTRE, y: CENTRE });
    sim.placeStructure('wall_wood', ANCHOR_TILE - 4, ANCHOR_TILE - 1, 0, player.id);
    for (let i = 0; i < 12; i++) {
      sim.spawnZombie(
        i % 3 === 0 ? 'runner' : 'walker',
        CENTRE - 250 - i * 7,
        CENTRE - 90 + i * 16,
      );
    }
    sim.spawnZombie('walker', CENTRE + DORMANT_DISTANCE + 200, CENTRE);
    emitNoise(sim.ctx, player.x, player.y, NoiseRadius.Gunshot, 1, player.id);
    sim.step(300);
    return sim;
  }

  it('produces identical worlds from identical seeds', () => {
    expect(digest(scenario(9001))).toBe(digest(scenario(9001)));
  });

  it('produces different worlds from different seeds', () => {
    // The wandering rolls are the only source of divergence here, but they are enough:
    // if this ever passes trivially, the seed has stopped reaching the AI.
    expect(digest(scenario(9001))).not.toBe(digest(scenario(4242)));
  });
});

describe('cost at scale', () => {
  /** Ticks and zombie count for the load tests. Deliberately the spec's numbers. */
  const HORDE = 200;
  const TICKS = 200;

  function buildCrowd(offset: number): TestSimulation {
    const sim = createTestSimulation({
      systems: [createZombieAiSystem()],
      spawn: { x: CENTRE, y: CENTRE },
      flattenRadius: 48,
      // An invulnerable player, so the near crowd keeps fighting for the whole run
      // instead of killing its target and going dormant halfway through the sample.
      config: (config) => {
        config.tuning.playerDamageTaken = 0;
      },
    });
    sim.addPlayer({ x: CENTRE, y: CENTRE });
    for (let i = 0; i < HORDE; i++) {
      // A 20x10 block, so the crowd has to separate as well as think.
      const x = CENTRE + offset + (i % 20) * 26;
      const y = CENTRE - 130 + Math.floor(i / 20) * 26;
      sim.spawnZombie('walker', x, y);
    }
    return sim;
  }

  function timeRun(sim: TestSimulation): number {
    const started = performance.now();
    sim.step(TICKS);
    return performance.now() - started;
  }

  it('runs 200 zombies for 200 ticks inside a sane budget, and dormant ones nearly free', () => {
    // Close enough to see and chase: this is the expensive case.
    const nearSim = buildCrowd(-420);
    const near = timeRun(nearSim);
    const busy = Object.values(nearSim.ctx.state.zombies).filter((z) => z.ai !== 'dormant');
    expect(busy).toHaveLength(HORDE);
    expect(nearSim.eventsOf('damage').length).toBeGreaterThan(0);

    // Well past the dormancy cutoff: this is the case that has to cost nothing.
    const farSim = buildCrowd(DORMANT_DISTANCE + 2000);
    const far = timeRun(farSim);
    const dormant = Object.values(farSim.ctx.state.zombies).filter((z) => z.ai === 'dormant');
    expect(dormant).toHaveLength(HORDE);

    // Generous absolute ceiling: 200 zombies x 200 ticks is 40 000 brain-eligible
    // entity-ticks, and anything near this bound means something started scanning the
    // whole world per zombie.
    expect(near).toBeLessThan(8000);
    // The whole point of the LOD tiers: distance has to be most of the saving.
    expect(far * 4).toBeLessThan(near);
  });
});
