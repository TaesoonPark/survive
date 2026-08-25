import {
  CHUNK_SIZE,
  hashString,
  type AnimalAiState,
  type LodTier,
  type ZombieAiState,
} from '@survive/protocol';

/**
 * Level-of-detail scheduling for creature brains (spec section 22).
 *
 * A thousand zombies on a map is a budget problem, not an intelligence problem. The
 * split that makes it affordable is:
 *
 * - **The brain** - senses, target selection, state transitions - runs on a schedule.
 *   How often depends on what the creature is doing *and* how far the nearest player
 *   is: a zombie mid-swing rethinks ten times a second, one shuffling around a field
 *   three chunks away rethinks every ten seconds, and nobody can tell the difference.
 * - **Movement** integrates every tick for anything close enough to be watched, and
 *   only on brain ticks further out, where a coarse catch-up step is invisible.
 *
 * Everything here is a pure function of state, so two hosts running the same save
 * schedule the same creatures on the same ticks.
 */

/**
 * Upper distance bound, in pixels, of LOD tiers 0, 1 and 2. Anything past the last
 * bound is tier 3. Tier 0 is roughly "in the same chunk as a player", which is also
 * roughly the area a client can see.
 */
export const LOD_TIER_BOUNDS: readonly [number, number, number] = [
  CHUNK_SIZE,
  CHUNK_SIZE * 2,
  CHUNK_SIZE * 4,
];

/** Tiers whose movement integrates every tick, so nearby motion stays smooth. */
export const SMOOTH_MOVEMENT_MAX_TIER = 1;

/**
 * Past this distance from every living player a creature goes dormant.
 *
 * Three chunks is well beyond any client's area of interest and beyond the range at
 * which a chase could plausibly reconnect, so a dormant creature is not "cheating" the
 * player out of anything - it is standing still where nobody can see it.
 */
export const DORMANT_DISTANCE = CHUNK_SIZE * 3;

/** A coarse (tier 2-3) movement step never covers more than this, so nothing teleports. */
export const MAX_COARSE_STEP_PX = CHUNK_SIZE / 16;

export function lodForDistance(distanceToPlayer: number): LodTier {
  if (distanceToPlayer <= LOD_TIER_BOUNDS[0]) return 0;
  if (distanceToPlayer <= LOD_TIER_BOUNDS[1]) return 1;
  if (distanceToPlayer <= LOD_TIER_BOUNDS[2]) return 2;
  return 3;
}

/**
 * Brain period in ticks, indexed by LOD tier.
 *
 * At 20 ticks/second: 2 ticks is 10 Hz, 4 is 5 Hz, 20 is 1 Hz, 200 is 0.1 Hz. The
 * numbers below are the frequencies the spec asks for - combat 10 Hz, alerted 5 Hz,
 * idle 1-2 Hz, dormant 0.1-0.5 Hz - stretched out as the creature gets further away.
 */
const ZOMBIE_THINK_TICKS: Record<ZombieAiState, readonly [number, number, number, number]> = {
  dormant: [40, 60, 120, 200],
  idle: [20, 20, 40, 100],
  wander: [10, 20, 40, 100],
  alerted: [4, 4, 10, 40],
  investigate: [4, 6, 12, 40],
  pursue: [2, 2, 8, 30],
  attack: [2, 2, 8, 30],
  stagger: [2, 4, 10, 40],
  // A corpse only wakes up to be cleaned away.
  dead: [200, 200, 200, 200],
};

const ANIMAL_THINK_TICKS: Record<AnimalAiState, readonly [number, number, number, number]> = {
  idle: [20, 30, 60, 120],
  graze: [20, 30, 60, 120],
  wander: [10, 20, 40, 100],
  alert: [4, 6, 12, 40],
  // A bolting deer changes direction fast or it runs into a tree.
  flee: [2, 4, 10, 30],
  stalk: [4, 4, 10, 30],
  attack: [2, 2, 8, 30],
  dead: [200, 200, 200, 200],
};

function intervalFrom(table: readonly [number, number, number, number], lod: LodTier): number {
  return table[lod];
}

export function zombieThinkInterval(state: ZombieAiState, lod: LodTier): number {
  return intervalFrom(ZOMBIE_THINK_TICKS[state], lod);
}

export function animalThinkInterval(state: AnimalAiState, lod: LodTier): number {
  return intervalFrom(ANIMAL_THINK_TICKS[state], lod);
}

/**
 * The next tick this entity's brain should run.
 *
 * The schedule is phase-locked to the entity id: the answer is the next tick `t` for
 * which `(t + hash(id)) % interval === 0`. That spreads a horde evenly across the
 * interval - no two-hundred-zombie spike on the tick they all spawned - without
 * needing to remember which creatures are new, and it keeps the average rate exactly
 * `interval`. Always returns a strictly future tick.
 */
export function nextThinkTickFor(entityId: string, tick: number, interval: number): number {
  const period = Math.max(1, Math.floor(interval));
  if (period === 1) return tick + 1;
  const phase = hashString(entityId) % period;
  const remainder = (tick + phase) % period;
  return tick + (remainder === 0 ? period : period - remainder);
}

/**
 * Ticks a coarse movement step may integrate at once.
 *
 * Tier 2-3 creatures move only on brain ticks, so one step has to stand in for the
 * whole interval. Capped by distance rather than by ticks so a runner does not cross
 * two chunks in a single `moveCircle` call, which is how things end up inside walls.
 */
export function coarseStepTicks(interval: number, speed: number, dt: number): number {
  if (speed <= 0 || dt <= 0) return 1;
  const maxTicks = MAX_COARSE_STEP_PX / (speed * dt);
  return Math.max(1, Math.min(interval, Math.floor(maxTicks) || 1));
}
