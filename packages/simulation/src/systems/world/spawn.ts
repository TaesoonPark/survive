import {
  CHUNK_SIZE,
  SIM_HZ,
  TICKS_PER_GAME_HOUR,
  biomeProps,
  bucket,
  clamp,
  distance,
  rngForCoord,
  type ChunkRuntimeState,
  type EntityId,
  type PlayerState,
  type Rng,
  type ZombieState,
} from '@survive/protocol';
import { SystemOrder, type System } from '../../core/context';
import type { SimContext } from '../../core/context';
import {
  destroyEntity,
  distanceToNearestPlayer,
  livingPlayers,
  markDirty,
  markDirtyAt,
} from '../../core/queries';
import { animalTargets, chunkBiomeFractions } from './chunkPopulation';
import { spawnAnimalAt, spawnZombieAt } from './creatures';

/**
 * Ongoing population pressure: zombies, hordes and animal regrowth.
 *
 * Two rules dominate everything in this file.
 *
 * The first is that **a zombie must never appear where a player can see it**. A walker
 * fading into existence eight metres ahead is the single most immersion-breaking bug in
 * this genre - it tells the player, mid-sentence, that the world is a spawn table. So
 * every candidate position is tested against every living player for both a minimum
 * distance and line of sight, and a roll that cannot find a concealed spot simply does
 * not spawn. An under-populated street is a much smaller sin than a zombie materialising
 * in the middle of it.
 *
 * The second is that population is a *budget*, not a stream. Each chunk has a target
 * count derived from its biome, the day number, the time of night and the server's
 * `zombieDensity`; spawning tops up towards it and culling trims back to it. A long
 * session therefore cannot accumulate thousands of forgotten zombies in chunks nobody
 * has visited since day three.
 */

/** Ticks between spawn rolls for one chunk. */
export const SPAWN_ROLL_INTERVAL_TICKS = SIM_HZ * 8;

/** Nothing spawns closer than this to any living player, in pixels. */
export const MIN_SPAWN_DISTANCE = 420;

/** Zombies beyond this distance from every player are candidates for culling. */
export const ZOMBIE_DESPAWN_DISTANCE = CHUNK_SIZE * 4;

/**
 * How long a body lies where it fell before it is cleaned away.
 *
 * Long enough to read as an aftermath and to let anyone loot the drops in peace - the loot
 * is already on the ground, dropped at the moment of death, so reaping the record destroys
 * nothing. Short enough that a chunk recovers within a session.
 *
 * This exists because corpses used to be immortal. The population census counts every
 * record whose `homeChunk` matches, alive or not, so bodies silently ate the chunk's
 * budget: fight through a chunk and it stopped spawning, hunt one out and it stopped
 * regrowing wildlife, and eviction did not help because `installChunk` restores the
 * payload's dead entities verbatim and the save keeps them too. `lod.ts` already said a
 * corpse "only wakes up to be cleaned away"; this is the part that was missing.
 */
export const CORPSE_LIFETIME_TICKS = TICKS_PER_GAME_HOUR;

/** Zombies per chunk at biome weight 1, day 1, daytime, density 1. */
export const BASE_ZOMBIES_PER_CHUNK = 1.4;

/** Most zombies one chunk roll may add, so a fresh chunk fills in gradually. */
export const MAX_SPAWNS_PER_ROLL = 2;

/** Extra population per elapsed day, and the day at which the ramp stops. */
const DAY_RAMP_PER_DAY = 0.06;
const DAY_RAMP_CAP = 40;

/** Night is worse. This is the whole reason to build a door. */
const NIGHT_MULTIPLIER = 1.7;

/** Placement attempts per spawn before the roll is abandoned. */
const SPAWN_ATTEMPTS = 6;

/** Ticks between population culls. */
const CULL_INTERVAL_TICKS = SIM_HZ * 3;

/** Wildlife comes back slowly: at most one animal per chunk per in-game hour. */
const ANIMAL_TOPUP_INTERVAL_TICKS = TICKS_PER_GAME_HOUR;

/** Horde sizing. */
const HORDE_BASE_SIZE = 6;
const HORDE_SIZE_PER_DAY = 0.6;
const HORDE_MAX_SIZE = 40;
/** Radius the horde is scattered over when it forms, in pixels. */
const HORDE_SPREAD = 320;
/**
 * Where a horde assembles, as a multiple of the area-of-interest radius.
 *
 * Greater than 1 on purpose, and by more than {@link HORDE_SPREAD}: every member has to
 * land *outside* the replicated area or {@link isConcealedSpawn} rejects it. Put the
 * ring just inside the AOI instead and the whole feature quietly stops working on open
 * ground - forty concealment checks fail against a clear sightline across a field, no
 * members spawn, and the horde that the seed promised never arrives. Out here it forms
 * unseen and walks in, which is the experience the mechanic is for.
 */
const HORDE_EDGE_FRACTION = 1.15;

/** RNG salt for the per-night horde decision. */
export const HORDE_SALT = 0x686f_7264;

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

/**
 * Target zombie count for one chunk.
 *
 * Biome does most of the work - `Town` carries a 3.2x weight against `Grassland`'s
 * 0.6, so cities are dangerous and fields are not - and the day count multiplies it so
 * that surviving is not a plateau. Returned fractional: the caller carries the
 * remainder as a probability, which is what lets a 0.9-zombie meadow hold one zombie
 * nine chunks out of ten instead of always rounding to nothing.
 */
export function zombieBudgetForChunk(ctx: SimContext, cx: number, cy: number): number {
  const fractions = chunkBiomeFractions(ctx.world, cx, cy);
  let weight = 0;
  for (const [biome, fraction] of fractions) weight += biomeProps(biome).zombieWeight * fraction;
  if (weight <= 0) return 0;

  const day = Math.max(1, ctx.state.time.day);
  const dayFactor = 1 + Math.min(day - 1, DAY_RAMP_CAP) * DAY_RAMP_PER_DAY;
  const nightFactor = ctx.state.time.isNight ? NIGHT_MULTIPLIER : 1;
  return BASE_ZOMBIES_PER_CHUNK * weight * ctx.config.world.zombieDensity * dayFactor * nightFactor;
}

function countByHomeChunk(records: Record<string, { homeChunk: string }>, key: string): number {
  let count = 0;
  for (const id of Object.keys(records)) {
    if (records[id]?.homeChunk === key) count++;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Concealment
// ---------------------------------------------------------------------------

/** True when no living player is close enough to be bothered by a spawn here. */
export function isFarFromPlayers(ctx: SimContext, x: number, y: number, minimum: number): boolean {
  for (const player of livingPlayers(ctx.state)) {
    if (distance(player.x, player.y, x, y) < minimum) return false;
  }
  return true;
}

/**
 * True when a spawn at (x, y) would be both far enough away and out of sight.
 *
 * Line of sight is only consulted inside the area of interest: past that radius the
 * position is not replicated to the client at all, so a clear sightline is a sightline
 * to something the player cannot see anyway, and insisting on cover there would leave
 * open countryside permanently empty.
 */
export function isConcealedSpawn(ctx: SimContext, x: number, y: number): boolean {
  const aoi = ctx.config.network.aoiRadius;
  for (const player of livingPlayers(ctx.state)) {
    const d = distance(player.x, player.y, x, y);
    if (d < MIN_SPAWN_DISTANCE) return false;
    if (d <= aoi && ctx.world.hasLineOfSight(player.x, player.y, x, y)) return false;
  }
  return true;
}

/** Find somewhere inside a chunk that a creature of this radius can stand, unseen. */
function findConcealedSpawn(
  ctx: SimContext,
  runtime: ChunkRuntimeState,
  entityRadius: number,
  rng: Rng,
): { x: number; y: number } | null {
  const centreX = runtime.cx * CHUNK_SIZE + CHUNK_SIZE / 2;
  const centreY = runtime.cy * CHUNK_SIZE + CHUNK_SIZE / 2;
  for (let attempt = 0; attempt < SPAWN_ATTEMPTS; attempt++) {
    const found = ctx.world.findSpawnPosition(
      centreX,
      centreY,
      CHUNK_SIZE / 2,
      entityRadius,
      () => rng.next(),
      8,
    );
    if (!found) continue;
    if (!isConcealedSpawn(ctx, found.x, found.y)) continue;
    return found;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Routine spawning
// ---------------------------------------------------------------------------

function rollChunkSpawns(ctx: SimContext): void {
  const day = Math.max(1, ctx.state.time.day);
  const night = ctx.state.time.isNight;

  for (const key of Object.keys(ctx.state.chunks).sort()) {
    const runtime = ctx.state.chunks[key];
    if (!runtime) continue;
    // Dormant chunks are far from everyone; adding to them just costs memory.
    if (runtime.activity === 'dormant') continue;
    if (ctx.state.tick < runtime.nextSpawnTick) continue;

    const rng = ctx.rng.fork(`spawn:${key}:${ctx.state.tick}`);
    // Jittered so neighbouring chunks do not all roll on the same tick forever.
    runtime.nextSpawnTick = ctx.state.tick + SPAWN_ROLL_INTERVAL_TICKS + rng.int(0, SIM_HZ * 2);
    markDirty(ctx.state, key);

    const budget = zombieBudgetForChunk(ctx, runtime.cx, runtime.cy);
    if (budget <= 0) continue;
    const floor = Math.floor(budget);
    const target = floor + (rng.chance(budget - floor) ? 1 : 0);
    const room = target - countByHomeChunk(ctx.state.zombies, key);
    if (room <= 0) continue;

    const eligible = ctx.data.zombiesForDay(day, night);
    if (eligible.length === 0) continue;

    const wanted = Math.min(room, MAX_SPAWNS_PER_ROLL);
    for (let i = 0; i < wanted; i++) {
      const def = rng.pickWeighted(eligible, (candidate) => candidate.spawnWeight);
      if (!def) break;
      const position = findConcealedSpawn(ctx, runtime, def.radius, rng);
      // No concealed spot this roll: leave the chunk short rather than pop a zombie
      // into view. It will try again in a few seconds.
      if (!position) break;
      spawnZombieAt(ctx, def, position.x, position.y, rng);
    }
  }
}

// ---------------------------------------------------------------------------
// Culling
// ---------------------------------------------------------------------------

/** Drop a culled zombie out of its horde, and the horde itself once it is empty. */
function releaseFromHorde(ctx: SimContext, zombie: ZombieState): void {
  if (!zombie.hordeId) return;
  const horde = ctx.state.hordes[zombie.hordeId];
  if (!horde) return;
  const index = horde.memberIds.indexOf(zombie.id);
  if (index >= 0) horde.memberIds.splice(index, 1);
  if (horde.memberIds.length === 0) delete ctx.state.hordes[zombie.hordeId];
}

/**
 * Trim over-budget chunks by removing their most distant zombies.
 *
 * Only ever removes something no player could be looking at, and never something that
 * is actively chasing: a zombie mid-pursuit is a fight in progress, not scenery, and
 * deleting it would look exactly like the fight cheating.
 */
export function cullZombies(ctx: SimContext): number {
  let culled = reapCorpses(ctx);

  const byChunk = new Map<string, ZombieState[]>();
  for (const id of Object.keys(ctx.state.zombies).sort()) {
    const zombie = ctx.state.zombies[id];
    if (!zombie || zombie.ai === 'dead') continue;
    bucket(byChunk, zombie.homeChunk).push(zombie);
  }

  for (const key of [...byChunk.keys()].sort()) {
    const list = byChunk.get(key);
    if (!list) continue;
    const runtime = ctx.state.chunks[key];
    // A chunk that is no longer loaded has a budget of zero: its zombies are pure
    // bookkeeping until somebody goes back.
    const budget = runtime ? Math.ceil(zombieBudgetForChunk(ctx, runtime.cx, runtime.cy)) : 0;
    let over = list.length - Math.max(0, budget);
    if (over <= 0) continue;

    const candidates = list
      .filter((zombie) => zombie.targetId === undefined)
      .map((zombie) => ({
        zombie,
        away: distanceToNearestPlayer(ctx.state, zombie.x, zombie.y),
      }))
      .filter((entry) => entry.away >= ZOMBIE_DESPAWN_DISTANCE)
      .sort((a, b) => b.away - a.away || (a.zombie.id < b.zombie.id ? -1 : 1));

    for (const entry of candidates) {
      if (over <= 0) break;
      releaseFromHorde(ctx, entry.zombie);
      markDirtyAt(ctx.state, entry.zombie.x, entry.zombie.y);
      destroyEntity(ctx.state, entry.zombie.id);
      over--;
      culled++;
    }
  }
  return culled;
}

/**
 * Clean away bodies whose time is up, zombie and animal alike.
 *
 * Deliberately not distance-gated the way live culling is: a corpse is not a fight in
 * progress, and leaving one in place because a player is nearby is what let a chunk fill up
 * with them. It does wait `CORPSE_LIFETIME_TICKS`, so nothing vanishes from under the
 * player who just made it.
 */
function reapCorpses(ctx: SimContext): number {
  const cutoff = ctx.state.tick - CORPSE_LIFETIME_TICKS;
  /**
   * A body from a save written before `deadTick` existed has no timestamp. Treated as due
   * rather than immortal - leaving it forever is the bug this pass exists to fix.
   */
  const due = (deadTick: number | undefined): boolean =>
    deadTick === undefined || deadTick <= cutoff;

  let reaped = 0;
  for (const id of Object.keys(ctx.state.zombies).sort()) {
    const zombie = ctx.state.zombies[id];
    if (!zombie || zombie.ai !== 'dead' || !due(zombie.deadTick)) continue;
    // Death does not release horde membership, so the id would be left dangling in
    // `horde.memberIds` after the record went away.
    releaseFromHorde(ctx, zombie);
    markDirtyAt(ctx.state, zombie.x, zombie.y);
    destroyEntity(ctx.state, id);
    reaped++;
  }
  for (const id of Object.keys(ctx.state.animals).sort()) {
    const animal = ctx.state.animals[id];
    if (!animal || animal.ai !== 'dead' || !due(animal.deadTick)) continue;
    markDirtyAt(ctx.state, animal.x, animal.y);
    destroyEntity(ctx.state, id);
    reaped++;
  }
  return reaped;
}

// ---------------------------------------------------------------------------
// Night hordes
// ---------------------------------------------------------------------------

/** Probability a given night brings a horde. Rises with the day count, then plateaus. */
export function hordeChance(day: number): number {
  return clamp(0.08 + day * 0.02, 0, 0.6);
}

/** How many zombies a horde on this day is worth. */
export function hordeSize(ctx: SimContext, day: number): number {
  const raw = (HORDE_BASE_SIZE + day * HORDE_SIZE_PER_DAY) * ctx.config.world.zombieDensity;
  return Math.round(clamp(raw, 2, HORDE_MAX_SIZE));
}

/**
 * Form a horde at the edge of a player's world and point it at them.
 *
 * Seeded from `(seed, day)` alone, so whether night 9 is a horde night is a property of
 * the world rather than of when the player happened to log in - two players on the same
 * save get the same nights, and a reload cannot re-roll a night into being quiet.
 */
function formNightHorde(ctx: SimContext): void {
  const day = Math.max(1, ctx.state.time.day);
  const hordeId = `night-${day}`;
  // Already arrived tonight.
  if (ctx.state.hordes[hordeId]) return;

  const rng = rngForCoord(ctx.state.seed, day, 0, HORDE_SALT);
  if (!rng.chance(hordeChance(day))) return;

  const players = livingPlayers(ctx.state).sort((a, b) => (a.id < b.id ? -1 : 1));
  const target: PlayerState | undefined = rng.pick(players);
  if (!target) return;

  const eligible = ctx.data.zombiesForDay(day, true);
  if (eligible.length === 0) return;

  const angle = rng.angle();
  const edge = ctx.config.network.aoiRadius * HORDE_EDGE_FRACTION;
  const originX = target.x + Math.cos(angle) * edge;
  const originY = target.y + Math.sin(angle) * edge;

  const members: EntityId[] = [];
  const wanted = hordeSize(ctx, day);
  for (let i = 0; i < wanted; i++) {
    const def = rng.pickWeighted(eligible, (candidate) => candidate.spawnWeight);
    if (!def) break;
    const position = ctx.world.findSpawnPosition(
      originX,
      originY,
      HORDE_SPREAD,
      def.radius,
      () => rng.next(),
      12,
    );
    if (!position) continue;
    if (!isConcealedSpawn(ctx, position.x, position.y)) continue;
    members.push(spawnZombieAt(ctx, def, position.x, position.y, rng, hordeId).id);
  }
  if (members.length === 0) return;

  ctx.state.hordes[hordeId] = {
    id: hordeId,
    memberIds: members,
    // One shared goal, refreshed by the AI system: a horde paths once, not forty times.
    goalX: target.x,
    goalY: target.y,
    pathTick: ctx.state.tick,
  };
  ctx.events.emit({
    type: 'hordeFormed',
    hordeId,
    size: members.length,
    x: originX,
    y: originY,
  });
}

// ---------------------------------------------------------------------------
// Animal regrowth
// ---------------------------------------------------------------------------

function topUpAnimals(ctx: SimContext): void {
  for (const key of Object.keys(ctx.state.chunks).sort()) {
    const runtime = ctx.state.chunks[key];
    if (!runtime || !runtime.populated || runtime.activity === 'dormant') continue;

    const fractions = chunkBiomeFractions(ctx.world, runtime.cx, runtime.cy);
    const targets = animalTargets(ctx, fractions);
    if (targets.length === 0) continue;
    let budget = 0;
    for (const entry of targets) budget += entry.target;
    if (countByHomeChunk(ctx.state.animals, key) >= Math.floor(budget)) continue;

    const rng = ctx.rng.fork(`animals:${key}:${ctx.state.tick}`);
    const chosen = rng.pickWeighted(targets, (entry) => entry.target);
    if (!chosen) continue;

    const centreX = runtime.cx * CHUNK_SIZE + CHUNK_SIZE / 2;
    const centreY = runtime.cy * CHUNK_SIZE + CHUNK_SIZE / 2;
    const position = ctx.world.findSpawnPosition(
      centreX,
      centreY,
      CHUNK_SIZE / 2,
      chosen.def.radius,
      () => rng.next(),
      8,
    );
    if (!position) continue;
    // Wildlife wandering into view is fine; wildlife appearing at arm's length is not.
    if (!isFarFromPlayers(ctx, position.x, position.y, MIN_SPAWN_DISTANCE)) continue;
    spawnAnimalAt(ctx, chosen.def, position.x, position.y, rng);
  }
}

// ---------------------------------------------------------------------------
// System
// ---------------------------------------------------------------------------

/**
 * The spawn system.
 *
 * Note the night-edge latch: hordes arrive on the tick night falls, and detecting that
 * edge needs to know what the previous tick looked like. The latch starts as `null` and
 * is armed by the first update without firing, so a save loaded in the middle of the
 * night does not conjure a second horde - and because the decision itself is seeded
 * from `(seed, day)`, arming late only ever loses a horde, never invents one.
 */
export function createSpawnSystem(): System {
  let wasNight: boolean | null = null;

  return {
    id: 'spawn',
    order: SystemOrder.Spawn,

    update(ctx) {
      rollChunkSpawns(ctx);

      const night = ctx.state.time.isNight;
      const previous = wasNight;
      wasNight = night;
      if (night && previous === false) formNightHorde(ctx);

      if (ctx.state.tick % CULL_INTERVAL_TICKS === 0) cullZombies(ctx);
      if (ctx.state.tick % ANIMAL_TOPUP_INTERVAL_TICKS === 0) topUpAnimals(ctx);
    },
  };
}
