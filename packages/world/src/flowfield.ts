/**
 * Flow fields: one Dijkstra integration shared by a whole horde.
 *
 * Twenty zombies chasing one player do not need twenty A* searches. They need one cost
 * field around the player and a direction lookup each (spec section 23). The field is a
 * bounded window rather than the whole world - a horde only cares about the tiles it can
 * plausibly walk in the next few seconds - and it is rebuilt on a timer instead of on
 * every move, because a direction that is two seconds stale still points the right way.
 *
 * The field is built *outwards from the goal*, so the direction stored on a tile is the
 * step towards the tile it was relaxed from - i.e. downhill, towards the goal. Costs are
 * geometric (1 orthogonal, sqrt(2) diagonal, plus an optional door surcharge); terrain
 * speed deliberately does not enter into it, because the field must stay a pure function
 * of the collision grid.
 */

import { WORLD_TILES, clamp, pixelToTile } from '@survive/protocol';
import type { CollisionGrid } from './collision';
import { createMinHeap, tileStepPenalty } from './pathfinding';
import { SOLID_MASK } from './types';
import type { FlowField } from './types';

/** Directions, in the order the packed `dir` byte encodes: four orthogonal, four diagonal. */
const DIR_X = [1, 0, -1, 0, 1, 1, -1, -1] as const;
const DIR_Y = [0, 1, 0, -1, 1, -1, 1, -1] as const;
/** Index of the direction pointing the opposite way, per direction. */
const OPPOSITE = [2, 3, 0, 1, 7, 6, 5, 4] as const;

const DIAGONAL_UNIT = Math.SQRT1_2;
/** Unit vectors matching {@link DIR_X}/{@link DIR_Y}, so sampling needs no normalise. */
const UNIT_X = [1, 0, -1, 0, DIAGONAL_UNIT, DIAGONAL_UNIT, -DIAGONAL_UNIT, -DIAGONAL_UNIT] as const;
const UNIT_Y = [0, 1, 0, -1, DIAGONAL_UNIT, -DIAGONAL_UNIT, DIAGONAL_UNIT, -DIAGONAL_UNIT] as const;

/** Packed direction meaning "nowhere to go": the goal itself, or an unreachable tile. */
export const FLOW_DIR_NONE = 255;

/** Window half-size used when a caller does not pick one. 48 tiles is ~1.5 chunks. */
export const DEFAULT_FLOW_EXTENT_TILES = 48;

/**
 * Hard cap on the window half-size.
 *
 * The field allocates `(2e+1)^2` floats plus bytes; at 192 that is about 600 KB, which is
 * already far more world than a horde can cross before the field expires.
 */
export const MAX_FLOW_EXTENT_TILES = 192;

/**
 * Goal quantisation, in tiles.
 *
 * Fields are cached by the goal tile *rounded to this grid*, so a player jogging around
 * does not invalidate the horde's field every tile. The price is up to half a cell of
 * aim-off; agents cover that with direct steering once they are within a few tiles.
 */
export const DEFAULT_FLOW_GOAL_QUANTUM_TILES = 4;

/**
 * How far a blocked goal may be nudged, in tiles.
 *
 * Bounded on purpose: a goal buried deeper than this inside rock has no useful field
 * anyway, and an unbounded ring scan over a 385-tile window is not a cost worth paying to
 * discover that.
 */
const GOAL_REPAIR_RADIUS_TILES = 8;

export interface FlowFieldOptions {
  /**
   * Extra cost of integrating through a closed door. Zero (the default) leaves doors
   * impassable, so the field stops at them; a positive value routes hordes into them.
   */
  doorCost?: number;
}

function clampTile(tile: number): number {
  if (!Number.isFinite(tile)) return 0;
  return clamp(Math.floor(tile), 0, WORLD_TILES - 1);
}

/**
 * Integrate cost outwards from a goal over a bounded, world-clamped window.
 *
 * Unreachable tiles - solid, or walled off from the goal - keep `Infinity` cost and
 * {@link FLOW_DIR_NONE}. A goal that is itself inside geometry is nudged to the nearest
 * enterable tile within the window, so clicking a wall or chasing someone standing in a
 * doorway still produces a usable field.
 */
export function buildFlowField(
  grid: CollisionGrid,
  goalX: number,
  goalY: number,
  tick: number,
  extentTiles: number = DEFAULT_FLOW_EXTENT_TILES,
  options?: FlowFieldOptions,
): FlowField {
  const doorCost = Math.max(0, options?.doorCost ?? 0);
  const extent = Number.isFinite(extentTiles)
    ? clamp(Math.floor(extentTiles), 1, MAX_FLOW_EXTENT_TILES)
    : DEFAULT_FLOW_EXTENT_TILES;

  const goalTileX = clampTile(pixelToTile(goalX));
  const goalTileY = clampTile(pixelToTile(goalY));

  const minTileX = clampTile(goalTileX - extent);
  const minTileY = clampTile(goalTileY - extent);
  const width = clampTile(goalTileX + extent) - minTileX + 1;
  const height = clampTile(goalTileY + extent) - minTileY + 1;

  const cost = new Float32Array(width * height).fill(Infinity);
  const dir = new Uint8Array(width * height).fill(FLOW_DIR_NONE);

  const field: FlowField = {
    goalTileX,
    goalTileY,
    minTileX,
    minTileY,
    width,
    height,
    cost,
    dir,
    builtTick: tick,
  };

  // Seed. A blocked goal is repaired inside the window; the search below is a plain
  // Dijkstra from whatever tile we managed to seed.
  let seedX = goalTileX;
  let seedY = goalTileY;
  if (tileStepPenalty(grid, seedX, seedY, doorCost) < 0) {
    const repaired = findNearestFreeTileInWindow(grid, field, seedX, seedY, doorCost);
    if (repaired === null) return field;
    seedX = repaired.tileX;
    seedY = repaired.tileY;
  }

  const heap = createMinHeap(256);
  // Lazy decrease-key: a tile can sit in the heap more than once, so the first (cheapest)
  // pop settles it and later copies are skipped.
  const settled = new Uint8Array(width * height);
  const seedIndex = (seedY - minTileY) * width + (seedX - minTileX);
  cost[seedIndex] = 0;
  heap.push(seedIndex, 0);

  while (heap.size > 0) {
    const current = heap.pop();
    if (current < 0) break;
    if (settled[current] === 1) continue;
    settled[current] = 1;
    const currentCost = cost[current] as number;
    const localX = current % width;
    const localY = (current - localX) / width;
    const tileX = minTileX + localX;
    const tileY = minTileY + localY;

    for (let direction = 0; direction < 8; direction++) {
      const stepX = DIR_X[direction] as number;
      const stepY = DIR_Y[direction] as number;
      const nextLocalX = localX + stepX;
      const nextLocalY = localY + stepY;
      if (nextLocalX < 0 || nextLocalY < 0 || nextLocalX >= width || nextLocalY >= height) {
        continue;
      }
      const nextTileX = tileX + stepX;
      const nextTileY = tileY + stepY;

      if (direction >= 4) {
        // Same corner rule as A*: a diagonal needs both shared orthogonals open, or
        // agents grind into the corners of buildings.
        if ((grid.get(nextTileX, tileY) & SOLID_MASK) !== 0) continue;
        if ((grid.get(tileX, nextTileY) & SOLID_MASK) !== 0) continue;
      }

      const penalty = tileStepPenalty(grid, nextTileX, nextTileY, doorCost);
      if (penalty < 0) continue;

      const nextIndex = nextLocalY * width + nextLocalX;
      const candidate = currentCost + (direction < 4 ? 1 : Math.SQRT2) + penalty;
      if (candidate < (cost[nextIndex] as number)) {
        cost[nextIndex] = candidate;
        // The neighbour must walk back towards the tile we came from.
        dir[nextIndex] = OPPOSITE[direction] as number;
        heap.push(nextIndex, candidate);
      }
    }
  }

  return field;
}

/**
 * Nearest enterable tile to a blocked goal, searched in expanding rings and clipped to the
 * field window. Ring order is fixed, so the result is a pure function of the grid.
 */
function findNearestFreeTileInWindow(
  grid: CollisionGrid,
  field: FlowField,
  tileX: number,
  tileY: number,
  doorCost: number,
): { tileX: number; tileY: number } | null {
  const maxRadius = Math.min(GOAL_REPAIR_RADIUS_TILES, Math.max(field.width, field.height));
  for (let radius = 1; radius <= maxRadius; radius++) {
    let bestX = 0;
    let bestY = 0;
    let bestDistanceSq = Infinity;
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
        const candidateX = tileX + dx;
        const candidateY = tileY + dy;
        if (candidateX < field.minTileX || candidateX >= field.minTileX + field.width) continue;
        if (candidateY < field.minTileY || candidateY >= field.minTileY + field.height) continue;
        if (tileStepPenalty(grid, candidateX, candidateY, doorCost) < 0) continue;
        const distanceSq = dx * dx + dy * dy;
        if (distanceSq < bestDistanceSq) {
          bestDistanceSq = distanceSq;
          bestX = candidateX;
          bestY = candidateY;
        }
      }
    }
    if (bestDistanceSq < Infinity) return { tileX: bestX, tileY: bestY };
  }
  return null;
}

/**
 * Unit direction to follow at a world position, or null when there is nowhere to go -
 * outside the window, standing on the goal, or on an unreachable tile. Callers treat null
 * as "steer directly" / "wander" rather than as an error.
 */
export function sampleFlow(
  field: FlowField,
  x: number,
  y: number,
): { x: number; y: number } | null {
  const localX = pixelToTile(x) - field.minTileX;
  const localY = pixelToTile(y) - field.minTileY;
  if (localX < 0 || localY < 0 || localX >= field.width || localY >= field.height) return null;
  const direction = field.dir[localY * field.width + localX] ?? FLOW_DIR_NONE;
  if (direction >= 8) return null;
  return { x: UNIT_X[direction] as number, y: UNIT_Y[direction] as number };
}

/** Integrated cost at a world position, or Infinity outside the window. */
export function sampleFlowCost(field: FlowField, x: number, y: number): number {
  const localX = pixelToTile(x) - field.minTileX;
  const localY = pixelToTile(y) - field.minTileY;
  if (localX < 0 || localY < 0 || localX >= field.width || localY >= field.height) return Infinity;
  return field.cost[localY * field.width + localX] ?? Infinity;
}

export interface FlowFieldCacheOptions {
  /** Window half-size for fields this cache builds. */
  extentTiles?: number;
  /** Goal tiles are rounded to this grid before being used as a cache key. */
  goalQuantumTiles?: number;
  /** Extra cost of integrating through a closed door. */
  doorCost?: number;
  /** Fields kept before the oldest is evicted. One per horde target is the usual load. */
  maxEntries?: number;
}

export interface FlowFieldCache {
  /**
   * Field for a goal, built if there is no fresh one. A field is reused while it is
   * younger than `maxAgeTicks`; anything older (or built in the future, which happens when
   * a save is reloaded) is rebuilt.
   */
  get(
    grid: CollisionGrid,
    goalX: number,
    goalY: number,
    tick: number,
    maxAgeTicks: number,
  ): FlowField;
  /** Drop fields at or past `maxAgeTicks`. Called from the simulation's upkeep pass. */
  prune(tick: number, maxAgeTicks: number): void;
  /**
   * Integrations performed since this cache was created, monotonically increasing.
   *
   * A caller that wants to know whether *its own* `get` paid for a build reads this
   * before and after. Comparing `builtTick` to the current tick cannot answer that: every
   * agent sharing a field built this tick sees a match, so a whole horde gets charged for
   * one integration.
   */
  readonly builds: number;
  readonly size: number;
  clear(): void;
}

/**
 * Cache of flow fields keyed by quantised goal tile.
 *
 * The key is the *rounded* goal tile, so every agent chasing the same player inside one
 * quantum cell shares a single integration - that is the whole point of the structure. The
 * cached field keeps the exact goal of whoever built it, which is at most half a cell away
 * from any later requester's goal.
 */
export function createFlowFieldCache(options?: FlowFieldCacheOptions): FlowFieldCache {
  const extentTiles = Math.max(1, Math.floor(options?.extentTiles ?? DEFAULT_FLOW_EXTENT_TILES));
  const quantum = Math.max(
    1,
    Math.floor(options?.goalQuantumTiles ?? DEFAULT_FLOW_GOAL_QUANTUM_TILES),
  );
  const doorCost = Math.max(0, options?.doorCost ?? 0);
  const maxEntries = Math.max(1, Math.floor(options?.maxEntries ?? 32));
  const fields = new Map<number, FlowField>();
  let builds = 0;

  function keyFor(goalX: number, goalY: number): number {
    const tileX = Math.round(clampTile(pixelToTile(goalX)) / quantum);
    const tileY = Math.round(clampTile(pixelToTile(goalY)) / quantum);
    // Both terms are non-negative after clamping to the world, so a plain pack is exact.
    return tileX * (WORLD_TILES + 1) + tileY;
  }

  function evictOldest(): void {
    let oldestKey = -1;
    let oldestTick = Infinity;
    for (const [key, field] of fields) {
      // Ties break on the lower key so eviction never depends on insertion order.
      if (field.builtTick < oldestTick || (field.builtTick === oldestTick && key < oldestKey)) {
        oldestTick = field.builtTick;
        oldestKey = key;
      }
    }
    if (oldestKey >= 0) fields.delete(oldestKey);
  }

  return {
    get(grid, goalX, goalY, tick, maxAgeTicks) {
      const key = keyFor(goalX, goalY);
      const existing = fields.get(key);
      if (existing !== undefined) {
        const age = tick - existing.builtTick;
        if (age >= 0 && age < maxAgeTicks) return existing;
      }
      const field = buildFlowField(grid, goalX, goalY, tick, extentTiles, { doorCost });
      builds++;
      fields.set(key, field);
      if (fields.size > maxEntries) evictOldest();
      return field;
    },

    prune(tick, maxAgeTicks) {
      const stale: number[] = [];
      for (const [key, field] of fields) {
        const age = tick - field.builtTick;
        if (age < 0 || age >= maxAgeTicks) stale.push(key);
      }
      for (const key of stale) fields.delete(key);
    },

    get builds() {
      return builds;
    },

    get size() {
      return fields.size;
    },

    clear() {
      fields.clear();
    },
  };
}
