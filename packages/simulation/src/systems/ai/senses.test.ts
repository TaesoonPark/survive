import { describe, expect, it } from 'vitest';
import { tileCenter } from '@survive/protocol';
import { createTestSimulation, type TestSimulation } from '@survive/test-utils';
import { NoiseRadius, emitNoise } from '../../core/noise';
import {
  DARK_SIGHT_FLOOR,
  HEARING_REFERENCE_RANGE,
  HEARING_THRESHOLD,
  MAX_NOISES_PER_TICK,
  canSeePlayer,
  createNoiseFeed,
  effectiveSightRange,
  findVisiblePlayer,
  hearingScale,
  lightVisibility,
  loudestHeardNoise,
  type NoiseSignal,
} from './senses';

/**
 * Sight and hearing.
 *
 * These are the only two channels through which an AI is allowed to learn where a
 * player is, so they are also the only two places a stealth bug can hide. The noise feed
 * gets particular attention because its cursor has to behave the same way under two very
 * different hosts: a server that drains the event sink every tick, and a test harness
 * that never drains it at all.
 */

const ANCHOR_TILE = 4104;
const CENTRE = tileCenter(ANCHOR_TILE);

function makeSim(): TestSimulation {
  return createTestSimulation({
    systems: [],
    spawn: { x: CENTRE, y: CENTRE },
    flattenRadius: 48,
  });
}

describe('light', () => {
  it('never blinds a zombie completely, but comes close', () => {
    const sim = makeSim();
    sim.ctx.state.time.lightLevel = 1;
    expect(lightVisibility(sim.ctx)).toBeCloseTo(1, 6);
    sim.ctx.state.time.lightLevel = 0;
    expect(lightVisibility(sim.ctx)).toBeCloseTo(DARK_SIGHT_FLOOR, 6);
    sim.ctx.state.time.lightLevel = 0.5;
    expect(lightVisibility(sim.ctx)).toBeGreaterThan(DARK_SIGHT_FLOOR);
    expect(lightVisibility(sim.ctx)).toBeLessThan(1);
  });

  it('clamps a nonsense light level rather than inverting the maths', () => {
    const sim = makeSim();
    sim.ctx.state.time.lightLevel = 4;
    expect(lightVisibility(sim.ctx)).toBeCloseTo(1, 6);
    sim.ctx.state.time.lightLevel = -3;
    expect(lightVisibility(sim.ctx)).toBeCloseTo(DARK_SIGHT_FLOOR, 6);
  });

  it('multiplies light and stance into one effective range', () => {
    const sim = makeSim();
    const player = sim.addPlayer({ x: CENTRE, y: CENTRE });
    player.moveMode = 'crouch';
    const crouchedInDaylight = effectiveSightRange(sim.ctx, 400, player);
    sim.ctx.state.time.lightLevel = 0;
    const crouchedAtNight = effectiveSightRange(sim.ctx, 400, player);
    expect(crouchedAtNight).toBeLessThan(crouchedInDaylight);
    expect(crouchedInDaylight).toBeLessThan(400);
  });
});

describe('sight', () => {
  it('needs range, cone and a clear line all three', () => {
    const sim = makeSim();
    const player = sim.addPlayer({ x: CENTRE, y: CENTRE });
    const viewer = { x: CENTRE - 200, y: CENTRE, facing: 0 };

    expect(canSeePlayer(sim.ctx, viewer, 400, 1, 30, player)).toBe(true);
    // Out of range.
    expect(canSeePlayer(sim.ctx, viewer, 100, 1, 30, player)).toBe(false);
    // Facing the other way.
    expect(canSeePlayer(sim.ctx, { ...viewer, facing: Math.PI }, 400, 1, 30, player)).toBe(false);
    // Wall in the way.
    sim.wall(ANCHOR_TILE - 3, ANCHOR_TILE - 8, ANCHOR_TILE - 3, ANCHOR_TILE + 8);
    expect(canSeePlayer(sim.ctx, viewer, 400, 1, 30, player)).toBe(false);
  });

  it('ignores the cone inside contact range, but never the wall', () => {
    const sim = makeSim();
    const player = sim.addPlayer({ x: CENTRE, y: CENTRE });
    // Behind the viewer's head, but touching it.
    const viewer = { x: CENTRE + 20, y: CENTRE, facing: 0 };
    expect(canSeePlayer(sim.ctx, viewer, 400, 0.2, 30, player)).toBe(true);
    expect(canSeePlayer(sim.ctx, viewer, 400, 0.2, 10, player)).toBe(false);
  });

  it('never sees a dead player', () => {
    const sim = makeSim();
    const player = sim.addPlayer({ x: CENTRE, y: CENTRE });
    const viewer = { x: CENTRE - 100, y: CENTRE, facing: 0 };
    expect(canSeePlayer(sim.ctx, viewer, 400, 1, 30, player)).toBe(true);
    player.alive = false;
    expect(canSeePlayer(sim.ctx, viewer, 400, 1, 30, player)).toBe(false);
  });

  it('picks the closest visible player, not the closest player', () => {
    const sim = makeSim();
    // Two players in different directions so one can be occluded without the other:
    // `near` is four tiles east of the viewer, `far` eight tiles south of it. The cone
    // is opened all the way round so this exercises distance and occlusion only.
    const near = sim.addPlayer({ id: 'near', x: CENTRE + 128, y: CENTRE });
    const far = sim.addPlayer({ id: 'far', x: CENTRE, y: CENTRE + 256 });
    const viewer = { x: CENTRE, y: CENTRE, facing: 0 };
    sim.step(1);

    expect(findVisiblePlayer(sim.ctx, viewer, 600, Math.PI, 30, [])?.id).toBe(near.id);

    // Drop one tile in front of the nearer one and the choice moves on to the other.
    sim.wall(ANCHOR_TILE + 2, ANCHOR_TILE, ANCHOR_TILE + 2, ANCHOR_TILE);
    sim.step(1);
    expect(findVisiblePlayer(sim.ctx, viewer, 600, Math.PI, 30, [])?.id).toBe(far.id);
  });

  it('returns null when nobody is in sight', () => {
    const sim = makeSim();
    sim.addPlayer({ x: CENTRE, y: CENTRE });
    sim.step(1);
    const viewer = { x: CENTRE - 2000, y: CENTRE, facing: 0 };
    expect(findVisiblePlayer(sim.ctx, viewer, 400, 1, 30, [])).toBeNull();
  });
});

describe('hearing', () => {
  it('turns the def field into a multiplier on the authored noise radius', () => {
    expect(hearingScale(HEARING_REFERENCE_RANGE)).toBeCloseTo(1, 6);
    expect(hearingScale(HEARING_REFERENCE_RANGE * 1.4)).toBeGreaterThan(1);
    expect(hearingScale(HEARING_REFERENCE_RANGE * 0.5)).toBeLessThan(1);
    expect(hearingScale(0)).toBe(0);
    // Clamped at both ends so a mis-typed def cannot give something world-wide ears.
    expect(hearingScale(HEARING_REFERENCE_RANGE * 100)).toBeLessThanOrEqual(2);
    expect(hearingScale(1)).toBeGreaterThanOrEqual(0.4);
  });

  it('picks the loudest thing it can hear', () => {
    const sim = makeSim();
    const listener = { x: CENTRE, y: CENTRE };
    const noises: NoiseSignal[] = [
      { x: CENTRE + 60, y: CENTRE, radius: NoiseRadius.Footstep, loudness: 0.4 },
      { x: CENTRE + 900, y: CENTRE, radius: NoiseRadius.Gunshot, loudness: 1 },
    ];
    const heard = loudestHeardNoise(sim.ctx, listener, noises, HEARING_REFERENCE_RANGE);
    expect(heard?.noise.radius).toBe(NoiseRadius.Gunshot);
  });

  it('hears nothing out of earshot', () => {
    const sim = makeSim();
    const noises: NoiseSignal[] = [
      { x: CENTRE + 5000, y: CENTRE, radius: NoiseRadius.Gunshot, loudness: 1 },
    ];
    expect(
      loudestHeardNoise(sim.ctx, { x: CENTRE, y: CENTRE }, noises, HEARING_REFERENCE_RANGE),
    ).toBeNull();
  });

  it('is muffled by a wall rather than stopped by it', () => {
    const sim = makeSim();
    const listener = { x: CENTRE, y: CENTRE };
    const noises: NoiseSignal[] = [
      { x: CENTRE + 300, y: CENTRE, radius: NoiseRadius.Gunshot, loudness: 1 },
    ];
    const open = loudestHeardNoise(sim.ctx, listener, noises, HEARING_REFERENCE_RANGE);

    sim.wall(ANCHOR_TILE + 5, ANCHOR_TILE - 8, ANCHOR_TILE + 5, ANCHOR_TILE + 8);
    const walled = loudestHeardNoise(sim.ctx, listener, noises, HEARING_REFERENCE_RANGE);

    expect(open?.strength).toBeGreaterThan(0);
    expect(walled?.strength).toBeGreaterThan(0);
    expect(walled?.strength).toBeLessThan((open as { strength: number }).strength);
  });

  it('never reports a noise it would not turn its head for', () => {
    const sim = makeSim();
    // Right at the edge of a footstep's radius: attenuated to almost nothing.
    const noises: NoiseSignal[] = [
      {
        x: CENTRE + NoiseRadius.Footstep - 1,
        y: CENTRE,
        radius: NoiseRadius.Footstep,
        loudness: 1,
      },
    ];
    const heard = loudestHeardNoise(
      sim.ctx,
      { x: CENTRE, y: CENTRE },
      noises,
      HEARING_REFERENCE_RANGE,
    );
    expect(heard).toBeNull();
    expect(HEARING_THRESHOLD).toBeGreaterThan(0);
  });

  it('does not hear itself', () => {
    const sim = makeSim();
    const noises: NoiseSignal[] = [
      { x: CENTRE, y: CENTRE, radius: NoiseRadius.Scream, loudness: 1, sourceId: 'z1' },
    ];
    const listener = { x: CENTRE, y: CENTRE };
    expect(loudestHeardNoise(sim.ctx, listener, noises, HEARING_REFERENCE_RANGE, 'z1')).toBeNull();
    expect(
      loudestHeardNoise(sim.ctx, listener, noises, HEARING_REFERENCE_RANGE, 'z2'),
    ).not.toBeNull();
  });

  it('is deaf when the def gives it no hearing at all', () => {
    const sim = makeSim();
    const noises: NoiseSignal[] = [
      { x: CENTRE, y: CENTRE, radius: NoiseRadius.Explosion, loudness: 1 },
    ];
    expect(loudestHeardNoise(sim.ctx, { x: CENTRE, y: CENTRE }, noises, 0)).toBeNull();
  });
});

describe('the noise feed', () => {
  it('reads each noise exactly once', () => {
    const sim = makeSim();
    const feed = createNoiseFeed();

    emitNoise(sim.ctx, CENTRE, CENTRE, NoiseRadius.Gunshot, 1);
    expect(feed.take(sim.ctx)).toHaveLength(1);
    expect(feed.take(sim.ctx)).toHaveLength(0);

    emitNoise(sim.ctx, CENTRE, CENTRE, NoiseRadius.MeleeHit, 1);
    emitNoise(sim.ctx, CENTRE, CENTRE, NoiseRadius.DoorOpen, 1);
    expect(feed.take(sim.ctx)).toHaveLength(2);
  });

  it('picks up where it left off after the host drains the sink', () => {
    const sim = makeSim();
    const feed = createNoiseFeed();

    emitNoise(sim.ctx, CENTRE, CENTRE, NoiseRadius.Gunshot, 1);
    expect(feed.take(sim.ctx)).toHaveLength(1);

    // A real server drains once a tick, which swaps the sink's array out from under us.
    sim.sim.drainEvents();
    emitNoise(sim.ctx, CENTRE, CENTRE, NoiseRadius.Mining, 1);
    expect(feed.take(sim.ctx)).toHaveLength(1);
  });

  it('ignores everything that is not a noise', () => {
    const sim = makeSim();
    const feed = createNoiseFeed();
    sim.ctx.events.emit({
      type: 'notification',
      severity: 'info',
      message: { code: 'notify.notASound' },
    });
    expect(feed.take(sim.ctx)).toHaveLength(0);
  });

  it('caps a besieged base at the loudest handful', () => {
    const sim = makeSim();
    const feed = createNoiseFeed(4);
    for (let i = 0; i < 40; i++) {
      emitNoise(sim.ctx, CENTRE + i, CENTRE, NoiseRadius.MeleeHit, 0.2);
    }
    emitNoise(sim.ctx, CENTRE, CENTRE, NoiseRadius.Explosion, 1);

    const taken = feed.take(sim.ctx);
    expect(taken).toHaveLength(4);
    // Carrying power, not arrival order: the explosion has to survive the cull.
    expect(taken.some((noise) => noise.radius === NoiseRadius.Explosion)).toBe(true);
  });

  it('defaults to a cap generous enough that nothing real hits it', () => {
    expect(MAX_NOISES_PER_TICK).toBeGreaterThanOrEqual(8);
  });

  it('carries a noise emitted after the read into the next read', () => {
    const sim = makeSim();
    const feed = createNoiseFeed();

    expect(feed.take(sim.ctx)).toHaveLength(0);
    // Emitted by the AI pass itself, after `take` had already run.
    emitNoise(sim.ctx, CENTRE, CENTRE, NoiseRadius.StructureBreak, 1);
    feed.carryOver(sim.ctx);

    const next = feed.take(sim.ctx);
    expect(next).toHaveLength(1);
    expect(next[0]?.radius).toBe(NoiseRadius.StructureBreak);
    // And exactly once: the carried buffer is emptied by the read that delivered it.
    expect(feed.take(sim.ctx)).toHaveLength(0);
  });

  it('carries across a drain, which is the case a real server hits every tick', () => {
    const sim = makeSim();
    const feed = createNoiseFeed();

    feed.take(sim.ctx);
    emitNoise(sim.ctx, CENTRE, CENTRE, NoiseRadius.Scream, 1);
    feed.carryOver(sim.ctx);
    // The host drains at the end of the tick, throwing the array away. The carried
    // noise has to survive that or zombies never hear each other on a real server.
    sim.sim.drainEvents();

    expect(feed.take(sim.ctx)).toHaveLength(1);
  });

  it('does not deliver a carried noise twice when nothing new arrives', () => {
    const sim = makeSim();
    const feed = createNoiseFeed();

    emitNoise(sim.ctx, CENTRE, CENTRE, NoiseRadius.Gunshot, 1);
    feed.carryOver(sim.ctx);
    // A second carry with nothing new must not clear what is already waiting.
    feed.carryOver(sim.ctx);
    expect(feed.take(sim.ctx)).toHaveLength(1);
    expect(feed.take(sim.ctx)).toHaveLength(0);
  });
});
