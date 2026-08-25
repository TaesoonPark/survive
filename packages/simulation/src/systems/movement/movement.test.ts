import { describe, expect, it } from 'vitest';
import { Button, SIM_HZ, Tile, WORLD_SIZE, pixelToTile, type SimEventOf } from '@survive/protocol';
import {
  createTestSimulation,
  type TestSimulation,
  type TestSimulationOptions,
} from '@survive/test-utils';
import {
  CROUCH_SPEED,
  PLAYER_RADIUS,
  RUN_SPEED,
  SPRINT_STAMINA_FLOOR,
  SPRINT_STAMINA_PER_SECOND,
  STAMINA_REGEN_PER_SECOND,
  WALK_SPEED,
} from '../../core/movement';
import { NoiseRadius } from '../../core/noise';
import { bindInputSource, createInputSystem } from './input';
import {
  FOOTSTEP_LOUDNESS,
  FOOTSTEP_STRIDE_PX,
  clampIntoWorld,
  createMovementSystem,
  footstepRadius,
} from './movement';

function makeSim(options: Omit<TestSimulationOptions, 'systems'> = {}): TestSimulation {
  const sim = createTestSimulation({
    ...options,
    systems: [createInputSystem(), createMovementSystem()],
  });
  bindInputSource(sim.sim);
  return sim;
}

/** Regeneration is slowed by the needs a fresh player already carries. */
function walkRegenPerSecond(hunger: number, fatigue: number): number {
  return STAMINA_REGEN_PER_SECOND * (1 - Math.min(0.6, fatigue / 200 + hunger / 300));
}

function noises(events: readonly { type: string }[]): SimEventOf<'noise'>[] {
  return events.filter((event): event is SimEventOf<'noise'> => event.type === 'noise');
}

/** Paint one tile row so a player walking along +X stays on the given terrain. */
function paintRow(sim: TestSimulation, x: number, y: number, tile: number, span = 40): void {
  const tileY = pixelToTile(y);
  const tileX = pixelToTile(x);
  for (let i = -2; i <= span; i++) sim.world.setTile(tileX + i, tileY, tile);
}

describe('movement system', () => {
  it('moves a player exactly one second of walk speed for one second of held input', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    const startX = player.x;

    sim.hold(player, { moveX: 1 }, SIM_HZ);

    expect(player.x - startX).toBeCloseTo(WALK_SPEED, 6);
    expect(player.y).toBeCloseTo(sim.spawn.y, 6);
    expect(player.moveMode).toBe('walk');
  });

  it('does not make diagonals faster than cardinals', () => {
    const cardinal = makeSim();
    const a = cardinal.addPlayer();
    const aStart = { x: a.x, y: a.y };
    cardinal.hold(a, { moveX: 1 }, SIM_HZ);
    const cardinalDistance = Math.hypot(a.x - aStart.x, a.y - aStart.y);

    const diagonal = makeSim();
    const b = diagonal.addPlayer();
    const bStart = { x: b.x, y: b.y };
    diagonal.hold(b, { moveX: 1, moveY: 1 }, SIM_HZ);
    const diagonalDistance = Math.hypot(b.x - bStart.x, b.y - bStart.y);

    expect(diagonalDistance).toBeCloseTo(cardinalDistance, 6);
    // And it really did move on both axes rather than one.
    expect(b.x - bStart.x).toBeGreaterThan(1);
    expect(b.y - bStart.y).toBeGreaterThan(1);
  });

  it('runs faster than it walks and crouches slower than it walks', () => {
    const distances: Record<string, number> = {};
    for (const [label, buttons] of [
      ['walk', 0],
      ['run', Button.Sprint],
      ['crouch', Button.Crouch],
    ] as const) {
      const sim = makeSim();
      const player = sim.addPlayer();
      const startX = player.x;
      sim.hold(player, { moveX: 1, buttons }, SIM_HZ);
      distances[label] = player.x - startX;
    }

    expect(distances.walk).toBeCloseTo(WALK_SPEED, 6);
    expect(distances.run).toBeCloseTo(RUN_SPEED, 6);
    expect(distances.crouch).toBeCloseTo(CROUCH_SPEED, 6);
  });

  it('drains stamina while sprinting and regenerates it while walking', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    expect(player.stamina).toBe(player.maxStamina);

    sim.hold(player, { moveX: 1, buttons: Button.Sprint }, SIM_HZ);
    expect(player.stamina).toBeCloseTo(player.maxStamina - SPRINT_STAMINA_PER_SECOND, 6);

    const drained = player.stamina;
    sim.hold(player, { moveX: 1 }, SIM_HZ);
    expect(player.stamina).toBeCloseTo(
      drained + walkRegenPerSecond(player.hunger, player.fatigue),
      6,
    );
  });

  it('refuses to sprint below the stamina floor', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    player.stamina = 3;
    const startX = player.x;

    sim.hold(player, { moveX: 1, buttons: Button.Sprint }, 5);

    expect(player.moveMode).toBe('walk');
    expect(player.x - startX).toBeCloseTo(WALK_SPEED * (5 / SIM_HZ), 6);
  });

  it('respects the terrain speed multiplier under the player', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    paintRow(sim, player.x, player.y, Tile.Mud);
    const startX = player.x;

    sim.hold(player, { moveX: 1 }, SIM_HZ);

    // Mud is a 0.7 multiplier in the tile table.
    expect(player.x - startX).toBeCloseTo(WALK_SPEED * 0.7, 6);
  });

  it('stops at a wall and slides along it', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    const wallTileX = pixelToTile(player.x) + 3;
    const centreTileY = pixelToTile(player.y);
    sim.wall(wallTileX, centreTileY - 20, wallTileX, centreTileY + 20);

    const startY = player.y;
    sim.hold(player, { moveX: 1 }, 4 * SIM_HZ);

    const contactX = wallTileX * 32 - PLAYER_RADIUS;
    expect(player.x).toBeLessThanOrEqual(contactX + 1e-9);
    // It got all the way there rather than stopping early: within one step of contact.
    expect(contactX - player.x).toBeLessThan(WALK_SPEED / SIM_HZ + 1e-9);
    expect(player.y).toBeCloseTo(startY, 6);

    // Pushing diagonally into the wall slides instead of sticking.
    sim.hold(player, { moveX: 1, moveY: 1 }, 4 * SIM_HZ);
    expect(player.x).toBeLessThanOrEqual(contactX + 1e-9);
    expect(player.y - startY).toBeGreaterThan(100);
  });

  it('takes exactly one step for one frame and then coasts to a stop', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    const startX = player.x;

    sim.input(player, { moveX: 1 });
    sim.step(1);
    const afterOneFrame = player.x - startX;
    expect(afterOneFrame).toBeCloseTo(WALK_SPEED / SIM_HZ, 6);

    // Ten starved ticks: the stale intent must not keep carrying them forward.
    sim.step(10);
    expect(player.x - startX).toBeCloseTo(afterOneFrame, 6);
  });

  it('leaves a resting player unrevved but revs them on every moving tick', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    sim.hold(player, { moveX: 0 }, 1);

    const resting = player.rev;
    sim.hold(player, { moveX: 0 }, 2 * SIM_HZ);
    expect(player.rev).toBe(resting);

    sim.hold(player, { moveX: 1 }, 10);
    expect(player.rev).toBe(resting + 10);
  });

  it('accumulates lifetime distance from the ground actually covered', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    expect(player.stats.distanceTravelled).toBe(0);

    sim.hold(player, { moveX: 1 }, SIM_HZ);
    expect(player.stats.distanceTravelled).toBeCloseTo(WALK_SPEED, 6);

    sim.hold(player, { moveX: -1 }, SIM_HZ);
    // Walking back is still distance travelled, not distance undone.
    expect(player.stats.distanceTravelled).toBeCloseTo(WALK_SPEED * 2, 6);
  });

  it('freezes movement while the player is action locked, then resumes', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    const startX = player.x;
    player.actionLockedUntilTick = sim.sim.state.tick + 10;

    sim.hold(player, { moveX: 1 }, 5);
    expect(player.x).toBe(startX);
    // The frame still reached them: aim is not part of the lock.
    sim.hold(player, { moveX: 1, aimAngle: 1.1 }, 1);
    expect(player.aimAngle).toBeCloseTo(1.1, 6);
    expect(player.x).toBe(startX);

    sim.hold(player, { moveX: 1 }, 10);
    expect(player.x - startX).toBeGreaterThan(WALK_SPEED * 0.2);
  });

  it('does not move a dead player', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    const startX = player.x;
    const startY = player.y;
    player.alive = false;

    sim.hold(player, { moveX: 1, moveY: 1, buttons: Button.Sprint }, 2 * SIM_HZ);

    expect(player.x).toBe(startX);
    expect(player.y).toBe(startY);
    expect(player.stats.distanceTravelled).toBe(0);
  });

  it('clamps a player back inside the world rectangle', () => {
    const sim = makeSim();
    const player = sim.addPlayer({ id: 'edge', x: 30, y: 30 });

    sim.hold(player, { moveX: -1, moveY: -1 }, 2 * SIM_HZ);

    expect(player.x).toBe(PLAYER_RADIUS);
    expect(player.y).toBe(PLAYER_RADIUS);
    expect(player.x).toBeLessThan(WORLD_SIZE);
  });
});

describe('footstep noise', () => {
  it('fires on a stride, not on every tick', () => {
    const sim = makeSim();
    const player = sim.addPlayer();

    const events = sim.hold(player, { moveX: 1 }, 5 * SIM_HZ);
    const steps = noises(events);

    // Five seconds of walking is 525 px, which is a dozen strides - not a hundred
    // ticks' worth of events.
    expect(steps.length).toBeGreaterThan(8);
    expect(steps.length).toBeLessThan(16);
    expect(steps.every((step) => step.sourceId === player.id)).toBe(true);
  });

  it('says nothing while the player stands still', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    const events = sim.hold(player, { moveX: 0, moveY: 0 }, 5 * SIM_HZ);
    expect(noises(events)).toHaveLength(0);
  });

  it('is quieter crouched and louder sprinting', () => {
    const radii: Record<string, number> = {};
    const loudness: Record<string, number> = {};
    for (const [label, buttons] of [
      ['walk', 0],
      ['run', Button.Sprint],
      ['crouch', Button.Crouch],
    ] as const) {
      const sim = makeSim();
      const player = sim.addPlayer();
      const steps = noises(sim.hold(player, { moveX: 1, buttons }, 5 * SIM_HZ));
      expect(steps.length).toBeGreaterThan(0);
      radii[label] = steps[0]?.radius ?? 0;
      loudness[label] = steps[0]?.loudness ?? 0;
    }

    expect(radii.crouch).toBeLessThan(radii.walk as number);
    expect(radii.walk).toBeLessThan(radii.run as number);
    expect(loudness.crouch).toBeLessThan(loudness.walk as number);
    expect(loudness.walk).toBeLessThan(loudness.run as number);
    // Grass muffles: 0.8 in the tile table.
    expect(radii.walk).toBeCloseTo(NoiseRadius.Footstep * 0.8, 6);
    expect(radii.crouch).toBeCloseTo(NoiseRadius.Crouch * 0.8, 6);
    expect(radii.run).toBeCloseTo(NoiseRadius.Sprint * 0.8, 6);
    expect(loudness.crouch).toBeCloseTo(FOOTSTEP_LOUDNESS.crouch * 0.8, 6);
  });

  it('scales with the noisiness of the tile underfoot', () => {
    const quiet = makeSim();
    const quietPlayer = quiet.addPlayer();
    paintRow(quiet, quietPlayer.x, quietPlayer.y, Tile.Snow);
    const quietSteps = noises(quiet.hold(quietPlayer, { moveX: 1 }, 5 * SIM_HZ));

    const loud = makeSim();
    const loudPlayer = loud.addPlayer();
    paintRow(loud, loudPlayer.x, loudPlayer.y, Tile.Gravel);
    const loudSteps = noises(loud.hold(loudPlayer, { moveX: 1 }, 5 * SIM_HZ));

    expect(quietSteps[0]?.radius).toBeCloseTo(footstepRadius('walk', 0.7), 6);
    expect(loudSteps[0]?.radius).toBeCloseTo(footstepRadius('walk', 1.3), 6);
    expect(loudSteps[0]?.radius).toBeGreaterThan(quietSteps[0]?.radius ?? 0);
  });

  it('stays silent while the player is being staggered around', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    player.actionLockedUntilTick = sim.sim.state.tick + 200;
    // A shove, the way the combat system applies knockback.
    player.vx = 400;

    const events = sim.hold(player, { moveX: 1 }, SIM_HZ);
    expect(player.x).toBeGreaterThan(sim.spawn.x);
    expect(noises(events)).toHaveLength(0);
  });
});

describe('pausing', () => {
  it('honours setPaused when the mode allows it, and nobody moves while paused', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    const other = sim.addPlayer({ id: 'other' });

    const startTick = sim.sim.state.tick;
    sim.run(player, { type: 'setPaused', paused: true });
    expect(sim.sim.state.paused).toBe(true);

    const startX = player.x;
    const otherStartX = other.x;
    sim.hold(player, { moveX: 1 }, 2 * SIM_HZ);
    sim.hold(other, { moveX: 1 }, 2 * SIM_HZ);
    expect(player.x).toBe(startX);
    expect(other.x).toBe(otherStartX);
    // Only the tick that carried the command elapsed, measured from where the world
    // actually started: a new one opens on the morning of day 1, not at tick 0.
    expect(sim.sim.state.tick).toBe(startTick + 1);

    // The host is the only thing that can restart a stopped world.
    sim.sim.setPaused(false);
    sim.hold(player, { moveX: 1 }, SIM_HZ);
    expect(player.x - startX).toBeCloseTo(WALK_SPEED, 6);
  });

  it('rejects setPaused on a server that does not allow it', () => {
    const sim = makeSim({
      config: (config) => {
        config.mode.pauseWhenClientPaused = false;
      },
    });
    const player = sim.addPlayer();

    sim.run(player, { type: 'setPaused', paused: true });

    expect(sim.sim.state.paused).toBe(false);
    const rejected = sim.lastEvent('commandRejected');
    expect(rejected?.command).toBe('setPaused');
    expect(rejected?.playerId).toBe(player.id);
    expect(rejected?.reason).toMatch(/not allowed/);

    sim.hold(player, { moveX: 1 }, SIM_HZ);
    expect(player.x).toBeGreaterThan(sim.spawn.x);
  });

  it('rejects a setPaused whose payload is not a boolean', () => {
    const sim = makeSim();
    const player = sim.addPlayer();

    sim.run(player, { type: 'setPaused', paused: 'yes' as unknown as boolean });

    expect(sim.sim.state.paused).toBe(false);
    expect(sim.lastEvent('commandRejected')?.reason).toMatch(/boolean/);
  });
});

describe('determinism', () => {
  /** One scripted second-and-a-half of twitchy input, identical for every run. */
  function drive(sim: TestSimulation): void {
    const player = sim.addPlayer();
    for (let i = 0; i < 120; i++) {
      sim.input(player, {
        moveX: ((i % 7) - 3) / 3,
        moveY: ((i % 5) - 2) / 2,
        aimAngle: i * 0.11,
        buttons: i % 3 === 0 ? Button.Sprint : i % 11 === 0 ? Button.Crouch : 0,
      });
      sim.step(1);
    }
  }

  it('produces byte-identical state and noise from identical input', () => {
    const first = makeSim({ seed: 4242 });
    const second = makeSim({ seed: 4242 });
    drive(first);
    drive(second);

    const playerOf = (sim: TestSimulation) => Object.values(sim.sim.state.players)[0];
    expect(JSON.stringify(playerOf(second))).toBe(JSON.stringify(playerOf(first)));
    expect(noises(second.events)).toEqual(noises(first.events));
  });

  it('does not depend on the order players were added in', () => {
    const forwards = makeSim({ seed: 99 });
    const a1 = forwards.addPlayer({ id: 'aaa' });
    const b1 = forwards.addPlayer({ id: 'bbb' });

    const backwards = makeSim({ seed: 99 });
    const b2 = backwards.addPlayer({ id: 'bbb' });
    const a2 = backwards.addPlayer({ id: 'aaa' });

    for (let i = 0; i < 40; i++) {
      for (const [sim, first, second] of [
        [forwards, a1, b1],
        [backwards, a2, b2],
      ] as const) {
        sim.input(first, { moveX: 1, moveY: (i % 3) - 1 });
        sim.input(second, { moveX: -1, moveY: 1 - (i % 3) });
        sim.step(1);
      }
    }

    expect(JSON.stringify(a2)).toBe(JSON.stringify(a1));
    expect(JSON.stringify(b2)).toBe(JSON.stringify(b1));
  });
});

describe('movement without an input system', () => {
  it('still ticks stamina and leaves the player where they stand', () => {
    // The movement system is usable on its own - a replay tool, or an AI-only test
    // world - and treats a player with no published frame as standing still.
    const sim = createTestSimulation({ systems: [createMovementSystem()] });
    const player = sim.addPlayer();
    player.stamina = 50;

    sim.step(SIM_HZ);

    expect(player.stamina).toBeCloseTo(50 + walkRegenPerSecond(player.hunger, player.fatigue), 6);
    expect(player.x).toBe(sim.spawn.x);
    expect(player.y).toBe(sim.spawn.y);
    expect(player.stats.distanceTravelled).toBe(0);
  });
});

describe('footstep cadence', () => {
  it('emits exactly one footstep per stride of ground covered, in every stance', () => {
    for (const [mode, buttons] of [
      ['walk', 0],
      ['run', Button.Sprint],
      ['crouch', Button.Crouch],
    ] as const) {
      const sim = makeSim();
      const player = sim.addPlayer();
      const steps = noises(sim.hold(player, { moveX: 1, buttons }, 5 * SIM_HZ));

      expect(player.moveMode).toBe(mode);
      // The invariant, rather than a magic number: one noise per stride boundary the
      // lifetime odometer crossed.
      expect(steps).toHaveLength(Math.floor(player.stats.distanceTravelled / FOOTSTEP_STRIDE_PX));
      expect(steps.length).toBeGreaterThan(4);
    }
  });

  it('emits at most one footstep in a tick however far the player was thrown', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    // A shove big enough to cross several strides in a single 50 ms step. The AI
    // treats each noise as its own thing to investigate, and this is one event.
    player.vx = 4000;

    const events = sim.hold(player, { moveX: 0 }, 1);

    expect(player.stats.distanceTravelled).toBeGreaterThan(FOOTSTEP_STRIDE_PX * 2);
    expect(noises(events)).toHaveLength(1);
  });

  it('uses the stance reference radius, scaled by the tile underfoot', () => {
    expect(footstepRadius('walk', 1)).toBe(NoiseRadius.Footstep);
    expect(footstepRadius('run', 1)).toBe(NoiseRadius.Sprint);
    expect(footstepRadius('crouch', 1)).toBe(NoiseRadius.Crouch);
    expect(footstepRadius('walk', 0.5)).toBeCloseTo(NoiseRadius.Footstep * 0.5, 6);
    // A perfectly silent tile makes no sound at all rather than a zero-radius event.
    expect(footstepRadius('walk', 0)).toBe(0);
  });
});

describe('stamina as a sprint budget', () => {
  it('cannot sprint further than its stamina pays for', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    const startX = player.x;

    sim.hold(player, { moveX: 1, buttons: Button.Sprint }, 20 * SIM_HZ);
    const covered = player.x - startX;

    // Faster than a walk, because the first stretch was a real sprint; slower than a
    // sprint, because the budget ran out and the floor stopped it being renewed.
    expect(covered).toBeLessThan(RUN_SPEED * 20);
    expect(covered).toBeGreaterThan(WALK_SPEED * 20);
    expect(player.stamina).toBeLessThan(SPRINT_STAMINA_FLOOR + STAMINA_REGEN_PER_SECOND);
  });
});

describe('world bounds', () => {
  it('leaves a body that is already inside alone', () => {
    const body = { x: 1000, y: 2000 };
    expect(clampIntoWorld(body)).toBe(false);
    expect(body).toEqual({ x: 1000, y: 2000 });
  });

  it('pulls a body back in by the player radius at both edges', () => {
    const low = { x: -500, y: -1 };
    expect(clampIntoWorld(low)).toBe(true);
    expect(low).toEqual({ x: PLAYER_RADIUS, y: PLAYER_RADIUS });

    const high = { x: WORLD_SIZE + 10, y: WORLD_SIZE * 2 };
    expect(clampIntoWorld(high)).toBe(true);
    expect(high).toEqual({ x: WORLD_SIZE - PLAYER_RADIUS, y: WORLD_SIZE - PLAYER_RADIUS });
  });

  it('holds a knockback impulse inside the world too', () => {
    const sim = makeSim();
    const player = sim.addPlayer({ id: 'shoved', x: 40, y: 40 });
    player.vx = -20000;
    player.vy = -20000;

    sim.hold(player, { moveX: 0 }, SIM_HZ);

    expect(player.x).toBe(PLAYER_RADIUS);
    expect(player.y).toBe(PLAYER_RADIUS);
  });
});

describe('footstep noise cannot be suppressed', () => {
  /**
   * The stance a cheating client would pick this tick to avoid a stride boundary.
   *
   * A real client knows its own position to the pixel - it predicts movement locally -
   * so it can look one step ahead in every stance and choose whichever one keeps it
   * inside the current stride bucket. This is that client, and it greedily prefers the
   * fastest silent option.
   */
  function greedySilentButtons(distance: number): number {
    const options: Array<[buttons: number, perTick: number]> = [
      [Button.Sprint, RUN_SPEED / SIM_HZ],
      [0, WALK_SPEED / SIM_HZ],
      [Button.Crouch, CROUCH_SPEED / SIM_HZ],
    ];
    for (const [buttons, perTick] of options) {
      const silent =
        Math.floor((distance + perTick) / FOOTSTEP_STRIDE_PX) ===
        Math.floor(distance / FOOTSTEP_STRIDE_PX);
      if (silent) return buttons;
    }
    return Button.Sprint;
  }

  it('cannot be dodged by picking the stance whose stride grid is about to be crossed', () => {
    const sim = makeSim();
    const player = sim.addPlayer();

    let heard = 0;
    for (let tick = 0; tick < 5 * SIM_HZ; tick++) {
      sim.input(player, { moveX: 1, buttons: greedySilentButtons(player.stats.distanceTravelled) });
      heard += noises(sim.step(1)).length;
    }

    // The grid is stance-independent, so the odometer pays for every stride it crosses
    // no matter which key the client held while crossing it.
    expect(player.stats.distanceTravelled).toBeGreaterThan(300);
    expect(heard).toBe(Math.floor(player.stats.distanceTravelled / FOOTSTEP_STRIDE_PX));
    expect(heard).toBeGreaterThan(4);
  });

  it('charges the same number of footsteps per pixel however often the stance changes', () => {
    const steady = makeSim({ seed: 31 });
    const steadyPlayer = steady.addPlayer();
    const twitchy = makeSim({ seed: 31 });
    const twitchyPlayer = twitchy.addPlayer();

    // Same ground covered either way: hold sprint, versus toggling it every tick and
    // making up the difference by walking further.
    for (let tick = 0; tick < 4 * SIM_HZ; tick++) {
      twitchy.input(twitchyPlayer, { moveX: 1, buttons: tick % 2 === 0 ? Button.Sprint : 0 });
      twitchy.step(1);
    }
    while (steadyPlayer.stats.distanceTravelled < twitchyPlayer.stats.distanceTravelled) {
      steady.input(steadyPlayer, { moveX: 1, buttons: Button.Sprint });
      steady.step(1);
    }

    const steadySteps = noises(steady.events).length;
    const twitchySteps = noises(twitchy.events).length;
    expect(twitchySteps).toBeGreaterThan(0);
    // One stride of ground is one footstep, always. Allow the single stride of slack
    // the steady runner needed to catch up.
    expect(Math.abs(steadySteps - twitchySteps)).toBeLessThanOrEqual(1);
  });
});

describe('position is never allowed to go non-finite', () => {
  it('rewinds the step rather than writing NaN into the world', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    sim.hold(player, { moveX: 1 }, 5);
    const beforeX = player.x;
    const beforeY = player.y;

    // What a bad knockback from another system looks like from in here. A NaN survives
    // `clamp`, so without the guard it would be written to the save and every distance
    // test downstream would answer false forever.
    player.vx = Number.NaN;
    sim.hold(player, { moveX: 1 }, 1);

    // Exactly one tick, because the guard costs exactly one step: the tick carrying the
    // NaN is lost and the impulse is scrubbed. Holding longer would only measure the
    // clean ticks that follow, which are supposed to walk normally.
    expect(Number.isFinite(player.x)).toBe(true);
    expect(Number.isFinite(player.y)).toBe(true);
    expect(player.x).toBe(beforeX);
    expect(player.y).toBe(beforeY);
    expect(player.vx).toBe(0);

    // ...and the very next tick moves again, rather than the player being stuck.
    sim.hold(player, { moveX: 1 }, 1);
    expect(player.x).toBeGreaterThan(beforeX);
  });

  it('scrubs a non-finite impulse without moving the player', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    player.vy = Number.POSITIVE_INFINITY;

    sim.hold(player, { moveX: 0 }, 2);

    expect(player.vy).toBe(0);
    expect(player.x).toBe(sim.spawn.x);
    expect(player.y).toBe(sim.spawn.y);
  });
});

describe('pause is host-owned once it is on', () => {
  it('cannot be lifted by the client that asked for it', () => {
    // Locks the contract the host has to honour: `Simulation.step` runs no tick while
    // paused, and commands are only dispatched inside a tick, so a queued
    // `setPaused: false` can never reach this system's handler. The resume has to come
    // from the host calling `Simulation.setPaused(false)` - see the note on the
    // handler. A host that queues the client's resume as a command instead deadlocks
    // the world.
    const sim = makeSim();
    const player = sim.addPlayer();

    sim.run(player, { type: 'setPaused', paused: true });
    expect(sim.sim.state.paused).toBe(true);

    sim.run(player, { type: 'setPaused', paused: false });
    sim.step(10);
    expect(sim.sim.state.paused).toBe(true);
    expect(sim.sim.queuedCommandCount).toBeGreaterThan(0);

    sim.sim.setPaused(false);
    expect(sim.sim.state.paused).toBe(false);
  });

  it('does not let a rejected pause leave the world half-stopped', () => {
    const sim = makeSim({
      config: (config) => {
        config.mode.pauseWhenClientPaused = false;
      },
    });
    const player = sim.addPlayer();

    // Both directions are refused on a server that does not allow client pausing: an
    // operator who paused the world with `force` must not be overridden from a client.
    sim.sim.setPaused(true, true);
    sim.sim.setPaused(false);
    sim.run(player, { type: 'setPaused', paused: false });
    expect(sim.eventsOf('commandRejected')).toHaveLength(1);
    expect(sim.sim.state.paused).toBe(false);
  });
});
