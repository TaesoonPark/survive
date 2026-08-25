import {
  distance,
  distanceSq,
  withinCone,
  type EntityId,
  type MoveMode,
  type PlayerState,
  type SimEvent,
} from '@survive/protocol';
import type { SimContext } from '../../core/context';
import { heardLoudness } from '../../core/noise';
import { skillLevel } from '../../core/skills';
import type { SpatialEntry } from '../../core/spatial';

/**
 * What a creature can see and hear.
 *
 * Sight and hearing are the only two ways an AI is allowed to learn where a player is
 * (spec section 22). Nothing in here reads a player's position without first paying for
 * it with a range check, a vision cone and a line-of-sight test, which is what makes
 * crouching behind a wall in the dark an actual tactic rather than a cosmetic one.
 */

// ---------------------------------------------------------------------------
// Sight
// ---------------------------------------------------------------------------

/** Sight multiplier in pitch darkness. Zombies never go fully blind, just useless. */
export const DARK_SIGHT_FLOOR = 0.35;

/**
 * How visible each stance makes a player.
 *
 * Crouching is the single biggest lever a player has over being noticed, and sprinting
 * is the price of covering ground - a sprinter is spotted from further away than they
 * can see the thing spotting them.
 */
export const MOVE_MODE_VISIBILITY: Record<MoveMode, number> = {
  crouch: 0.45,
  walk: 1,
  run: 1.3,
};

/** Every level of stealth shaves this fraction off the range a player is spotted at. */
export const STEALTH_VISIBILITY_PER_LEVEL = 0.045;

/** Even a master of stealth is not invisible. */
export const STEALTH_VISIBILITY_FLOOR = 0.5;

/** Largest multiplier {@link playerVisibility} can return, for a cheap first cull. */
export const MAX_VISIBILITY = MOVE_MODE_VISIBILITY.run;

/** Ambient-light contribution to sight range, 0..1 mapped onto the dark floor. */
export function lightVisibility(ctx: SimContext): number {
  const light = Math.max(0, Math.min(1, ctx.state.time.lightLevel));
  return DARK_SIGHT_FLOOR + (1 - DARK_SIGHT_FLOOR) * light;
}

/** Combined stance and skill multiplier on how far away this player gets noticed. */
export function playerVisibility(player: PlayerState): number {
  const stance = MOVE_MODE_VISIBILITY[player.moveMode];
  const stealth = Math.max(
    STEALTH_VISIBILITY_FLOOR,
    1 - skillLevel(player, 'stealth') * STEALTH_VISIBILITY_PER_LEVEL,
  );
  return stance * stealth;
}

/** Range, in pixels, at which this viewer would notice this player. */
export function effectiveSightRange(
  ctx: SimContext,
  baseRange: number,
  player: PlayerState,
): number {
  return baseRange * lightVisibility(ctx) * playerVisibility(player);
}

/** The bits of an observer that sensing needs. Zombies and animals both satisfy it. */
export interface Viewer {
  x: number;
  y: number;
  facing: number;
}

/**
 * Whether `viewer` can see `player` right now.
 *
 * `contactRange` is the "you cannot sneak past something you are touching" allowance:
 * inside it the vision cone is ignored, because a zombie you have walked into knows
 * you are there regardless of which way its head is pointing.
 */
export function canSeePlayer(
  ctx: SimContext,
  viewer: Viewer,
  baseRange: number,
  halfAngle: number,
  contactRange: number,
  player: PlayerState,
  knownDistance?: number,
): boolean {
  if (!player.alive) return false;
  const d = knownDistance ?? distance(viewer.x, viewer.y, player.x, player.y);
  if (d > contactRange) {
    if (d > effectiveSightRange(ctx, baseRange, player)) return false;
    if (!withinCone(viewer.x, viewer.y, viewer.facing, halfAngle, player.x, player.y)) return false;
  }
  return ctx.world.hasLineOfSight(viewer.x, viewer.y, player.x, player.y);
}

/**
 * Nearest player this viewer can actually see, or null.
 *
 * `scratch` is a caller-owned array reused across every creature in the tick; the
 * spatial query fills it instead of allocating, which matters when this runs a few
 * hundred times a tick.
 */
export function findVisiblePlayer(
  ctx: SimContext,
  viewer: Viewer,
  baseRange: number,
  halfAngle: number,
  contactRange: number,
  scratch: SpatialEntry[],
): PlayerState | null {
  const cull = Math.max(baseRange * MAX_VISIBILITY, contactRange);
  const candidates = ctx.spatial.query(viewer.x, viewer.y, cull, scratch);
  let best: PlayerState | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const entry of candidates) {
    if (entry.kind !== 'player') continue;
    const player = ctx.state.players[entry.id];
    if (!player || !player.alive) continue;
    const d = distance(viewer.x, viewer.y, player.x, player.y);
    // Ties break on id so a creature standing exactly between two players is not at
    // the mercy of hash iteration order.
    if (d > bestDistance || (d === bestDistance && best !== null && player.id >= best.id)) continue;
    if (!canSeePlayer(ctx, viewer, baseRange, halfAngle, contactRange, player, d)) continue;
    bestDistance = d;
    best = player;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Hearing
// ---------------------------------------------------------------------------

/** One audible event, lifted out of this tick's event stream. */
export interface NoiseSignal {
  x: number;
  y: number;
  radius: number;
  loudness: number;
  sourceId?: EntityId;
}

/**
 * Most noises a brain will consider in one tick, loudest first.
 *
 * A base under siege emits a noise per zombie per swing; without a cap the hearing
 * pass would be O(listeners x attackers) line-of-sight tests. Sixteen is far more
 * than any creature needs to pick "the loudest thing I can hear".
 */
export const MAX_NOISES_PER_TICK = 16;

/**
 * The `hearingRange` a noise radius is authored against.
 *
 * `NoiseRadius` values are absolute pixel radii, and `ZombieDef.hearingRange` is the
 * creature's acuity; dividing one by the other turns the def field into a multiplier,
 * so a feral dog (700) hears a gunshot from half again as far as a walker (520) does
 * without either number having to be restated in the other's units.
 */
export const HEARING_REFERENCE_RANGE = 500;

/** Below this attenuated loudness a noise is not worth turning your head for. */
export const HEARING_THRESHOLD = 0.08;

/** How far the audible radius of a noise stretches for this listener. */
export function hearingScale(hearingRange: number): number {
  if (!(hearingRange > 0)) return 0;
  return Math.max(0.4, Math.min(2, hearingRange / HEARING_REFERENCE_RANGE));
}

/**
 * Pulls `noise` events out of the event sink.
 *
 * Noise is emitted earlier in the tick by movement, combat and gathering, and the AI
 * consumes it from {@link SimContext.events} rather than from a channel of its own -
 * that is what keeps the AI ignorant of *what* made the sound. The feed remembers how
 * much of the pending list it has already read; the sink swaps its array on drain, so
 * comparing the array identity is enough to notice the host drained between ticks.
 *
 * A noise the AI itself emits - a screamer's call, a fist on a door, a wall coming
 * down - has to reach the *other* creatures, and it lands in the sink after the pass
 * that would have read it. {@link NoiseFeed.carryOver} is the second half of the
 * contract: called at the end of the AI's own update, it lifts everything emitted since
 * `take` into a private buffer that the next `take` prepends. Without it the behaviour
 * would depend on whether the host drains the sink between ticks - the test harness
 * never does, a real server does every tick - and single-player and multiplayer would
 * quietly disagree about whether zombies hear each other breaching a base.
 */
export interface NoiseFeed {
  /** Noises to react to now: last tick's leftovers, then this tick's so far. */
  take(ctx: SimContext): readonly NoiseSignal[];
  /** Stash anything emitted since {@link NoiseFeed.take} for delivery next tick. */
  carryOver(ctx: SimContext): void;
}

export function createNoiseFeed(maxPerTick = MAX_NOISES_PER_TICK): NoiseFeed {
  let seen: readonly SimEvent[] | null = null;
  let cursor = 0;
  /** Read but not yet delivered: emitted after the last `take` returned. */
  let carried: NoiseSignal[] = [];
  const out: NoiseSignal[] = [];

  /**
   * Carrying power, not raw radius: a quiet noise right next door still loses to a
   * gunshot, which is the tie-break a listener would make anyway.
   */
  function cull(list: NoiseSignal[]): void {
    if (list.length <= maxPerTick) return;
    list.sort((a, b) => b.radius * b.loudness - a.radius * a.loudness);
    list.length = maxPerTick;
  }

  /** Everything in the sink the feed has not read yet, advancing the cursor past it. */
  function readTail(ctx: SimContext): NoiseSignal[] {
    const pending = ctx.events.pending;
    if (pending !== seen || pending.length < cursor) cursor = 0;
    seen = pending;
    const end = pending.length;
    const fresh: NoiseSignal[] = [];
    for (let i = cursor; i < end; i++) {
      const event = pending[i];
      if (event?.type !== 'noise') continue;
      fresh.push({
        x: event.x,
        y: event.y,
        radius: event.radius,
        loudness: event.loudness,
        ...(event.sourceId ? { sourceId: event.sourceId } : {}),
      });
    }
    cursor = end;
    return fresh;
  }

  return {
    take(ctx) {
      const fresh = readTail(ctx);
      out.length = 0;
      // Last tick's leftovers first, so a cull that has to choose keeps the older
      // sound rather than silently dropping it a second time.
      for (const noise of carried) out.push(noise);
      for (const noise of fresh) out.push(noise);
      carried = [];
      cull(out);
      return out;
    },

    carryOver(ctx) {
      const fresh = readTail(ctx);
      if (fresh.length === 0) return;
      carried = fresh;
      cull(carried);
    },
  };
}

/** A noise as one particular listener perceives it. */
export interface HeardNoise {
  noise: NoiseSignal;
  /** Attenuated loudness, 0..1-ish. Bigger is more interesting. */
  strength: number;
}

/**
 * The most attention-grabbing thing this listener can hear, or null for silence.
 *
 * The cheap squared-distance cull runs before {@link heardLoudness}, which raycasts:
 * a listener out of earshot must not pay for a wall test.
 */
export function loudestHeardNoise(
  ctx: SimContext,
  listener: { x: number; y: number },
  noises: readonly NoiseSignal[],
  hearingRange: number,
  ignoreSourceId?: EntityId,
): HeardNoise | null {
  const scale = hearingScale(hearingRange);
  if (scale <= 0) return null;
  let best: HeardNoise | null = null;
  for (const noise of noises) {
    if (ignoreSourceId !== undefined && noise.sourceId === ignoreSourceId) continue;
    const audible = noise.radius * scale;
    if (audible <= 0) continue;
    if (distanceSq(listener.x, listener.y, noise.x, noise.y) > audible * audible) continue;
    const strength =
      heardLoudness(ctx, listener.x, listener.y, noise.x, noise.y, audible) * noise.loudness;
    if (strength < HEARING_THRESHOLD) continue;
    if (best === null || strength > best.strength) best = { noise, strength };
  }
  return best;
}
