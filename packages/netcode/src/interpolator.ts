import { SNAPSHOT_HZ, insertSorted, lerp, wrapAngle } from '@survive/protocol';
import type { EntityId, EntitySnapshot, WorldSnapshot } from '@survive/protocol';

/**
 * Remote entity interpolation.
 *
 * Snapshots arrive ten times a second; the renderer draws sixty. Drawing the newest
 * snapshot directly would produce a 10 Hz stutter, and every dropped packet would be
 * a visible jump. So the client renders the *past*: it keeps a short history of
 * positions per entity and samples it at `now - interpolationDelay`, which is late
 * enough that there are almost always two snapshots to interpolate between.
 *
 * The delay costs exactly what it says — remote players are drawn where they were,
 * not where they are. Two snapshot intervals is the usual compromise: enough slack
 * to survive one lost packet, small enough (200 ms at 10 Hz) that aiming still feels
 * honest, and the server does its own lag compensation for hit resolution anyway.
 *
 * Nothing here knows about Phaser, sprites or the simulation. It takes numbers in
 * and gives numbers out, which is what lets a headless bot client use it too.
 *
 * One rule for callers: {@link EntityInterpolator.record} and
 * {@link EntityInterpolator.sample} must use the *same* millisecond time base, and it
 * must be monotonic. Local receipt time (`performance.now()` when the snapshot
 * arrives) is the simple choice and what the delay is tuned for; feeding arrival time
 * in and render time from the same clock keeps network jitter inside the delay
 * window instead of turning it into position noise.
 */

/** What the interpolator tracks per entity: position in pixels, facing in radians. */
export interface Transform {
  x: number;
  y: number;
  facing: number;
}

/** A transform with the time it was true. */
interface TimedTransform extends Transform {
  t: number;
}

export interface EntityInterpolatorOptions {
  /** Milliseconds between snapshots. Defaults to the protocol's snapshot rate. */
  snapshotIntervalMs?: number;
  /** How far behind real time to render. Defaults to two snapshot intervals. */
  interpolationDelayMs?: number;
  /** How far past the newest sample dead reckoning is allowed to run. */
  maxExtrapolationMs?: number;
  /** How much history to keep behind the render time. */
  bufferWindowMs?: number;
}

export class EntityInterpolator {
  private readonly buffers = new Map<EntityId, TimedTransform[]>();
  private readonly snapshotIntervalMsValue: number;
  private readonly interpolationDelayMsValue: number;
  private readonly maxExtrapolationMsValue: number;
  private readonly bufferWindowMsValue: number;

  constructor(options: EntityInterpolatorOptions = {}) {
    this.snapshotIntervalMsValue = options.snapshotIntervalMs ?? 1000 / SNAPSHOT_HZ;
    this.interpolationDelayMsValue =
      options.interpolationDelayMs ?? this.snapshotIntervalMsValue * 2;
    this.maxExtrapolationMsValue = options.maxExtrapolationMs ?? 100;
    this.bufferWindowMsValue =
      options.bufferWindowMs ?? this.interpolationDelayMsValue + this.snapshotIntervalMsValue * 8;
  }

  get interpolationDelayMs(): number {
    return this.interpolationDelayMsValue;
  }

  get snapshotIntervalMs(): number {
    return this.snapshotIntervalMsValue;
  }

  get maxExtrapolationMs(): number {
    return this.maxExtrapolationMsValue;
  }

  /** Entities currently being tracked. */
  get trackedCount(): number {
    return this.buffers.size;
  }

  ids(): IterableIterator<EntityId> {
    return this.buffers.keys();
  }

  has(id: EntityId): boolean {
    return this.buffers.has(id);
  }

  /** The time the renderer should sample, given the current local time. */
  renderTime(nowMs: number): number {
    return nowMs - this.interpolationDelayMsValue;
  }

  /**
   * Record where an entity was at `timestampMs`.
   *
   * Out-of-order arrivals are inserted in time order rather than appended, because a
   * sample that lands after a newer one would otherwise make the buffer non-monotonic
   * and produce a backwards jump. A repeated timestamp overwrites, which is what a
   * re-sent snapshot should do.
   */
  record(id: EntityId, transform: Transform, timestampMs: number): void {
    let samples = this.buffers.get(id);
    if (!samples) {
      samples = [];
      this.buffers.set(id, samples);
    }
    const sample: TimedTransform = {
      t: timestampMs,
      x: transform.x,
      y: transform.y,
      facing: wrapAngle(transform.facing),
    };
    const newest = samples[samples.length - 1];
    if (!newest || timestampMs > newest.t) {
      samples.push(sample);
      return;
    }
    const existing = samples.findIndex((entry) => entry.t === timestampMs);
    if (existing >= 0) samples[existing] = sample;
    else insertSorted(samples, sample, (entry) => entry.t);
  }

  /**
   * Feed a whole snapshot in: record every entity that can move and forget the ones
   * the server says are gone.
   */
  ingest(snapshot: Pick<WorldSnapshot, 'entities' | 'removed'>, timestampMs: number): void {
    for (const entity of snapshot.entities) {
      const transform = snapshotTransform(entity);
      if (transform) this.record(entity.id, transform, timestampMs);
    }
    for (const id of snapshot.removed) this.forget(id);
  }

  /** Stop tracking an entity. Called for anything the server removes. */
  forget(id: EntityId): boolean {
    return this.buffers.delete(id);
  }

  clear(): void {
    this.buffers.clear();
  }

  /** Sample an entity at `now - interpolationDelay`. Undefined when untracked. */
  sample(id: EntityId, nowMs: number): Transform | undefined {
    return this.sampleAt(id, this.renderTime(nowMs));
  }

  /** Sample an entity at an explicit render time. */
  sampleAt(id: EntityId, renderTimeMs: number): Transform | undefined {
    const samples = this.buffers.get(id);
    if (!samples || samples.length === 0) return undefined;

    const oldest = samples[0];
    const newest = samples[samples.length - 1];
    if (!oldest || !newest) return undefined;

    // Buffer has not filled far enough back yet: show the oldest thing we have
    // rather than inventing history.
    if (renderTimeMs <= oldest.t) return plain(oldest);

    if (renderTimeMs >= newest.t) return this.extrapolate(samples, renderTimeMs);

    // Newest-first scan: the render time is almost always inside the last interval.
    for (let i = samples.length - 1; i > 0; i--) {
      const to = samples[i];
      const from = samples[i - 1];
      if (!to || !from) continue;
      if (renderTimeMs >= from.t && renderTimeMs <= to.t) {
        const span = to.t - from.t;
        const alpha = span <= 0 ? 1 : (renderTimeMs - from.t) / span;
        return blend(from, to, alpha);
      }
    }
    return plain(newest);
  }

  /**
   * Drop history the render time has moved past.
   *
   * The newest two samples always survive: the newest is what a starving buffer
   * holds on, and the pair gives dead reckoning a velocity.
   *
   * Entities are never dropped for going quiet. Replication is `rev`-based, so a
   * zombie that stops moving simply stops appearing in snapshots — pruning it would
   * delete its sprite. Entities leave only through {@link forget}, i.e. only when the
   * server says they left the area of interest or died.
   */
  prune(nowMs: number): void {
    const cutoff = this.renderTime(nowMs) - this.bufferWindowMsValue;
    for (const samples of this.buffers.values()) {
      let drop = 0;
      while (samples.length - drop > 2) {
        const sample = samples[drop];
        if (!sample || sample.t >= cutoff) break;
        drop++;
      }
      if (drop > 0) samples.splice(0, drop);
    }
  }

  /**
   * Dead reckoning for a starving buffer.
   *
   * Extends the last known velocity for at most `maxExtrapolationMs`, then freezes.
   * Guessing further than that turns one lost packet into an entity sliding through
   * a wall, and a frozen sprite is a much cheaper lie to correct.
   */
  private extrapolate(samples: TimedTransform[], renderTimeMs: number): Transform {
    const newest = samples[samples.length - 1];
    if (!newest) throw new Error('extrapolate called with an empty buffer');
    const previous = samples[samples.length - 2];
    const ahead = Math.min(renderTimeMs - newest.t, this.maxExtrapolationMsValue);
    if (!previous || ahead <= 0) return plain(newest);

    const span = newest.t - previous.t;
    if (span <= 0) return plain(newest);

    const scale = ahead / span;
    return {
      x: newest.x + (newest.x - previous.x) * scale,
      y: newest.y + (newest.y - previous.y) * scale,
      facing: wrapAngle(newest.facing + wrapAngle(newest.facing - previous.facing) * scale),
    };
  }
}

/**
 * Position and facing of a replicated entity, or null when it cannot move.
 *
 * Structures are anchored to tiles and never move, so interpolating them would waste
 * a buffer per fence post; the renderer places them from their tile coordinates once.
 */
export function snapshotTransform(entity: EntitySnapshot): Transform | null {
  switch (entity.k) {
    case 'player':
    case 'zombie':
    case 'animal':
      return { x: entity.x, y: entity.y, facing: entity.facing };
    case 'item':
    case 'node':
      return { x: entity.x, y: entity.y, facing: 0 };
    case 'projectile':
      // Projectiles carry velocity but no facing; point them along their travel.
      return { x: entity.x, y: entity.y, facing: Math.atan2(entity.vy, entity.vx) };
    case 'structure':
      return null;
  }
}

function plain(sample: TimedTransform): Transform {
  return { x: sample.x, y: sample.y, facing: sample.facing };
}

/**
 * Linear for position, shortest arc for the angle.
 *
 * Lerping radians directly would send a sprite spinning the long way round whenever
 * it crosses the +/-PI seam; taking the wrapped delta keeps the turn under PI.
 */
function blend(from: TimedTransform, to: TimedTransform, alpha: number): Transform {
  return {
    x: lerp(from.x, to.x, alpha),
    y: lerp(from.y, to.y, alpha),
    facing: wrapAngle(from.facing + wrapAngle(to.facing - from.facing) * alpha),
  };
}
