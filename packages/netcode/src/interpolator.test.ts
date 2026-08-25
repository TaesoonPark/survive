import { describe, expect, it } from 'vitest';
import { TAU, angleDelta } from '@survive/protocol';
import type { EntitySnapshot, WorldSnapshot } from '@survive/protocol';
import { EntityInterpolator, snapshotTransform } from './interpolator';

/** 100 ms apart, rendered 200 ms late: two snapshots of slack, like the client uses. */
const INTERVAL = 100;
const DELAY = 200;

function makeInterpolator(): EntityInterpolator {
  return new EntityInterpolator({
    snapshotIntervalMs: INTERVAL,
    interpolationDelayMs: DELAY,
    maxExtrapolationMs: 100,
  });
}

describe('EntityInterpolator', () => {
  it('renders the interpolation delay behind real time', () => {
    const interp = makeInterpolator();
    interp.record('z1', { x: 0, y: 0, facing: 0 }, 0);
    interp.record('z1', { x: 100, y: 50, facing: 0 }, INTERVAL);

    // now = 200 renders t = 0, i.e. the first snapshot exactly.
    expect(interp.sample('z1', 200)).toEqual({ x: 0, y: 0, facing: 0 });
    // now = 250 renders t = 50, halfway.
    expect(interp.sample('z1', 250)).toEqual({ x: 50, y: 25, facing: 0 });
    expect(interp.sample('z1', 300)).toEqual({ x: 100, y: 50, facing: 0 });
  });

  it('produces monotonic motion between two snapshots', () => {
    const interp = makeInterpolator();
    interp.record('z1', { x: 0, y: 0, facing: 0 }, 0);
    interp.record('z1', { x: 100, y: 0, facing: 0 }, INTERVAL);

    let previous = -Infinity;
    for (let now = 200; now <= 300; now += 5) {
      const sampled = interp.sampleAt('z1', interp.renderTime(now));
      expect(sampled).toBeDefined();
      const x = sampled?.x ?? 0;
      expect(x).toBeGreaterThanOrEqual(previous);
      previous = x;
    }
    expect(previous).toBe(100);
  });

  it('holds the oldest sample before the buffer starts', () => {
    const interp = makeInterpolator();
    interp.record('z1', { x: 10, y: 10, facing: 0 }, 1000);

    expect(interp.sample('z1', 0)).toEqual({ x: 10, y: 10, facing: 0 });
  });

  it('extrapolates for at most maxExtrapolationMs, then holds', () => {
    const interp = makeInterpolator();
    interp.record('z1', { x: 0, y: 0, facing: 0 }, 0);
    interp.record('z1', { x: 100, y: 0, facing: 0 }, INTERVAL);

    // 50 ms past the newest sample at 1 px/ms.
    expect(interp.sample('z1', 350)?.x).toBeCloseTo(150, 6);
    // Exactly at the extrapolation cap.
    expect(interp.sample('z1', 400)?.x).toBeCloseTo(200, 6);
    // Far past it: frozen, not sliding through walls.
    expect(interp.sample('z1', 1000)?.x).toBeCloseTo(200, 6);
    expect(interp.sample('z1', 10_000)?.x).toBeCloseTo(200, 6);
  });

  it('holds position when a single sample cannot give a velocity', () => {
    const interp = makeInterpolator();
    interp.record('z1', { x: 7, y: 8, facing: 1 }, 0);

    expect(interp.sample('z1', 5000)).toEqual({ x: 7, y: 8, facing: 1 });
  });

  it('takes the shortest arc across the +/-PI seam', () => {
    const interp = makeInterpolator();
    interp.record('p1', { x: 0, y: 0, facing: 3.0 }, 0);
    interp.record('p1', { x: 0, y: 0, facing: -3.0 }, INTERVAL);

    // Wrapping the short way is 2*PI - 6 radians; the long way through 0 is 6.
    const shortArc = TAU - 6;

    let travelled = 0;
    let previous = 3.0;
    let minAbs = Infinity;
    for (let renderTime = 0; renderTime <= INTERVAL; renderTime += 5) {
      const sampled = interp.sampleAt('p1', renderTime);
      expect(sampled).toBeDefined();
      const facing = sampled?.facing ?? 0;
      travelled += Math.abs(angleDelta(previous, facing));
      minAbs = Math.min(minAbs, Math.abs(facing));
      previous = facing;
    }

    expect(travelled).toBeCloseTo(shortArc, 6);
    // Every step is tiny: no jump the long way round at the seam.
    expect(minAbs).toBeGreaterThan(2.8);
    expect(interp.sampleAt('p1', INTERVAL)?.facing).toBeCloseTo(-3.0, 6);
  });

  it('crosses the seam through PI, not through zero', () => {
    const interp = makeInterpolator();
    interp.record('p1', { x: 0, y: 0, facing: 3.1 }, 0);
    interp.record('p1', { x: 0, y: 0, facing: -3.1 }, INTERVAL);

    const midway = interp.sampleAt('p1', INTERVAL / 2)?.facing ?? 0;
    expect(Math.abs(midway)).toBeCloseTo(Math.PI, 6);
  });

  it('inserts an out-of-order sample in time order', () => {
    const interp = makeInterpolator();
    interp.record('z1', { x: 0, y: 0, facing: 0 }, 0);
    interp.record('z1', { x: 200, y: 0, facing: 0 }, 200);
    // Late arrival for the middle of the interval.
    interp.record('z1', { x: 100, y: 0, facing: 0 }, 100);

    expect(interp.sampleAt('z1', 50)?.x).toBeCloseTo(50, 6);
    expect(interp.sampleAt('z1', 150)?.x).toBeCloseTo(150, 6);
  });

  it('overwrites a duplicate timestamp instead of stalling on it', () => {
    const interp = makeInterpolator();
    interp.record('z1', { x: 0, y: 0, facing: 0 }, 0);
    interp.record('z1', { x: 100, y: 0, facing: 0 }, 100);
    interp.record('z1', { x: 40, y: 0, facing: 0 }, 0);

    expect(interp.sampleAt('z1', 50)?.x).toBeCloseTo(70, 6);
  });

  it('ingests a snapshot and forgets removed entities', () => {
    const interp = makeInterpolator();
    interp.ingest(snapshot([zombie('z1', 0, 0), zombie('z2', 10, 0)], []), 0);
    interp.ingest(snapshot([zombie('z1', 20, 0)], ['z2']), INTERVAL);

    expect(interp.trackedCount).toBe(1);
    expect(interp.has('z2')).toBe(false);
    expect(interp.sampleAt('z1', INTERVAL / 2)?.x).toBeCloseTo(10, 6);
    expect(interp.sample('z2', 0)).toBeUndefined();
  });

  it('does not buffer structures, which never move', () => {
    expect(snapshotTransform(structure('s1'))).toBeNull();
    expect(snapshotTransform(zombie('z1', 1, 2))).toEqual({ x: 1, y: 2, facing: 0.5 });

    const interp = makeInterpolator();
    interp.ingest(snapshot([structure('s1'), zombie('z1', 0, 0)], []), 0);
    expect(interp.trackedCount).toBe(1);
    expect(interp.has('s1')).toBe(false);
  });

  it('points projectiles along their velocity', () => {
    const projectile: EntitySnapshot = {
      k: 'projectile',
      id: 'r1',
      defId: 'bullet',
      x: 0,
      y: 0,
      vx: 0,
      vy: 100,
      rev: 1,
    };
    expect(snapshotTransform(projectile)?.facing).toBeCloseTo(Math.PI / 2, 6);
  });

  it('prunes old history but keeps enough to extrapolate', () => {
    const interp = makeInterpolator();
    for (let t = 0; t <= 2000; t += INTERVAL) {
      interp.record('z1', { x: t, y: 0, facing: 0 }, t);
    }
    interp.prune(2000 + DELAY);

    // The entity survives (replication is rev-based: quiet is not gone) and the two
    // newest samples still give dead reckoning a velocity.
    expect(interp.has('z1')).toBe(true);
    expect(interp.sampleAt('z1', 2050)?.x).toBeCloseTo(2050, 6);
    // History behind the buffer window is gone, so the oldest sample now clamps.
    expect(interp.sampleAt('z1', 0)?.x).toBeGreaterThan(0);
  });

  it('never prunes an entity that simply stopped changing', () => {
    const interp = makeInterpolator();
    interp.record('z1', { x: 5, y: 5, facing: 0 }, 0);
    interp.prune(100_000);

    expect(interp.has('z1')).toBe(true);
    expect(interp.sample('z1', 100_000)).toEqual({ x: 5, y: 5, facing: 0 });
  });

  it('never moves an entity backwards when a snapshot goes missing', () => {
    const interp = makeInterpolator();
    let localMs = 10_000;
    let previous = -Infinity;

    // 20 px per snapshot for four seconds, sampled every simulation tick, with one
    // snapshot dropped: extrapolation must fill the gap without ever rewinding.
    for (let step = 0; step < 80; step++) {
      if (step % 2 === 0 && step !== 24) {
        interp.record('z1', { x: step * 10, y: 0, facing: 0 }, localMs);
      }
      const sampled = interp.sample('z1', localMs);
      if (sampled) {
        expect(sampled.x).toBeGreaterThanOrEqual(previous - 1e-9);
        previous = sampled.x;
      }
      interp.prune(localMs);
      localMs += INTERVAL / 2;
    }

    expect(previous).toBeGreaterThan(0);
    expect(interp.trackedCount).toBe(1);
  });

  it('starts a re-added entity from its new position, not its old one', () => {
    const interp = makeInterpolator();
    interp.record('z1', { x: 0, y: 0, facing: 0 }, 0);
    interp.record('z1', { x: 100, y: 0, facing: 0 }, INTERVAL);
    // Left the area of interest, came back somewhere else entirely.
    interp.forget('z1');
    interp.record('z1', { x: 900, y: 0, facing: 0 }, 5000);

    expect(interp.sample('z1', 5000)).toEqual({ x: 900, y: 0, facing: 0 });
    expect(interp.sample('z1', 5200)).toEqual({ x: 900, y: 0, facing: 0 });
  });

  it('clears everything on demand', () => {
    const interp = makeInterpolator();
    interp.record('z1', { x: 0, y: 0, facing: 0 }, 0);
    interp.clear();
    expect(interp.trackedCount).toBe(0);
  });
});

function zombie(id: string, x: number, y: number): EntitySnapshot {
  return {
    k: 'zombie',
    id,
    defId: 'walker',
    x,
    y,
    facing: 0.5,
    health: 100,
    maxHealth: 100,
    ai: 'wander',
    crawling: false,
    attacking: false,
    rev: 1,
  };
}

function structure(id: string): EntitySnapshot {
  return {
    k: 'structure',
    id,
    defId: 'wall_wood',
    tileX: 4,
    tileY: 5,
    rotation: 0,
    health: 100,
    maxHealth: 100,
    builtTick: 0,
    progress: 1,
    rev: 1,
  };
}

function snapshot(
  entities: EntitySnapshot[],
  removed: string[],
): Pick<WorldSnapshot, 'entities' | 'removed'> {
  return { entities, removed };
}
