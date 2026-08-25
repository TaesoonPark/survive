/**
 * The collision grid: one byte of {@link CollisionFlag} bits per tile, stored per chunk.
 *
 * Movement, sight and navigation all read this one structure, so nothing has to walk the
 * structure list to answer "can I stand here". Terrain contributes the `Terrain*` and
 * `Deep` bits when a chunk is generated; structures and resource nodes add and remove
 * their own bits as they are built and destroyed. Keeping the two groups in separate bits
 * is what lets a tile override recompute terrain without wiping the wall someone built on
 * top of it, and lets a destroyed wall stop blocking without re-reading terrain.
 *
 * Storage is a `Uint16Array` per chunk in a `Map`, never one array for the world: the map
 * is 8192x8192 tiles and only the chunks around players are loaded (Architecture Guard
 * rule 9).
 *
 * Sixteen bits, not eight, because {@link CollisionFlag} outgrew a byte. It held exactly
 * eight bits for a while, and adding a ninth (`NodeOpaque`) truncated it to zero on the way
 * into storage - silently, so a tree simply stopped blocking sight and every test still
 * passed, because the tests run against `createFlatWorld`, whose store is not a typed
 * array. Two bytes per tile is 2 KiB per chunk against a few dozen resident chunks, and it
 * leaves room for the next flag. The grid is derived and never persisted, so widening it
 * costs nothing on disk or on the wire.
 *
 * Chunks that were never seeded read back as {@link CollisionFlag.None} rather than
 * throwing. The simulation legitimately probes just outside the loaded area - the tail of
 * a raycast, an A* frontier, a spawn scan - and treating that space as open is cheaper and
 * far less surprising than making every caller bounds-check first.
 *
 * The grid holds no derived caches of any kind: every query is a pure function of the bits
 * currently stored, so results cannot depend on the order chunks were seeded or queried.
 */

import {
  CHUNK_TILE_COUNT,
  TILE_SIZE,
  chunkTileIndex,
  circleOverlapsAabb,
  pixelToTile,
  tileProps,
  tileToChunk,
} from '@survive/protocol';
import type { Aabb } from '@survive/protocol';
import { CollisionFlag, OPAQUE_MASK, SOLID_MASK } from './types';
import type { CollisionFlags, MoveResult } from './types';

/** Bits owned by static terrain. Every other bit belongs to structures and nodes. */
export const TERRAIN_MASK: CollisionFlags =
  CollisionFlag.TerrainSolid | CollisionFlag.TerrainOpaque | CollisionFlag.Deep;

/**
 * Longest distance a swept circle may travel between two overlap tests, in pixels.
 *
 * Half a tile. The overlap test is a *static* test at the candidate position, so a step
 * longer than the thinnest possible wall (one tile, 32 px) could place the circle beyond
 * the wall without ever overlapping it. Half a tile is strictly less than that, so the
 * leading edge of the circle cannot pass a wall without one test landing inside it - which
 * is what stops a sprinting player or a fast projectile from tunnelling.
 */
const MAX_SWEEP_STEP = TILE_SIZE / 2;

/**
 * Hard ceiling on sub-steps for one swept move.
 *
 * The step count is derived from the distance travelled, so a delta large enough is a
 * delta expensive enough to stall the tick: at half a tile per sub-step, a 10^9-pixel
 * impulse asks for 60 million overlap tests. Nothing legitimate comes close - the
 * fastest thing in the game covers about 12 pixels in a tick and the hardest knockback
 * a few dozen - so hitting this ceiling means another system produced nonsense. The
 * sweep goes coarse rather than hanging, and the caller's own guards (a rewind in
 * `stepPlayer`, a clamp at the border) clean up after it.
 *
 * 4096 pixels of travel at full resolution, which is 128 tiles - four chunks.
 */
export const MAX_SWEEP_SUBSTEPS = 256;

/**
 * Penetration depth, in pixels, below which an overlap counts as mere contact.
 *
 * `circleOverlapsAabb` treats a circle exactly touching a box as overlapping. Without
 * this tolerance an entity that slid until it grazed a wall would be classified as
 * "already inside geometry" on the following tick and handed free movement straight through it.
 */
const CONTACT_TOLERANCE = 0.01;

/**
 * Chunk coordinates are packed into a single number for the storage map.
 *
 * A numeric key avoids building a `"cx,cy"` string on every tile query; A* and DDA hit
 * this path hundreds of times per agent per tick. The offset keeps negative coordinates
 * (out-of-world probes) distinct, and the product stays well inside 2^53 so the packing
 * is exact.
 */
const CHUNK_COORD_LIMIT = 1 << 20;
const CHUNK_KEY_STRIDE = 1 << 21;

function chunkId(cx: number, cy: number): number {
  if (!Number.isFinite(cx) || !Number.isFinite(cy)) return -1;
  if (cx <= -CHUNK_COORD_LIMIT || cx >= CHUNK_COORD_LIMIT) return -1;
  if (cy <= -CHUNK_COORD_LIMIT || cy >= CHUNK_COORD_LIMIT) return -1;
  return (cx + CHUNK_COORD_LIMIT) * CHUNK_KEY_STRIDE + (cy + CHUNK_COORD_LIMIT);
}

/**
 * Collision bits a tile id contributes.
 *
 * Terrain-only: a tile can never set a structure bit, so a generator and a tile override
 * are the same operation as far as the grid is concerned.
 */
export function terrainCollisionFlags(tile: number): CollisionFlags {
  const props = tileProps(tile);
  let flags: CollisionFlags = CollisionFlag.None;
  if (props.solid) flags |= CollisionFlag.TerrainSolid;
  if (props.opaque) flags |= CollisionFlag.TerrainOpaque;
  if (props.deep) flags |= CollisionFlag.Deep;
  return flags;
}

/**
 * Per-tile collision state for the loaded part of the world.
 *
 * Tile coordinates are integers; world positions are float pixels. A non-integer tile
 * coordinate reads as {@link CollisionFlag.None} and writes are dropped, deliberately
 * failing soft the same way an unloaded chunk does.
 */
export interface CollisionGrid {
  /**
   * Install the terrain bits for a freshly generated chunk.
   *
   * Resets the chunk completely: structure and node bits are re-added by whoever owns
   * those entities when the chunk is populated, so a reloaded chunk cannot inherit stale
   * collision from a previous life.
   */
  seedChunk(cx: number, cy: number, tiles: readonly number[]): void;
  /** Forget a chunk. Queries inside it read as open again. */
  clearChunk(cx: number, cy: number): void;
  hasChunk(cx: number, cy: number): boolean;
  /** Number of chunks currently backed by storage. */
  readonly chunkCount: number;

  /** Raw bits at a tile. {@link CollisionFlag.None} outside loaded chunks. */
  get(tileX: number, tileY: number): CollisionFlags;
  /** Set bits (structures, nodes, doors). No-op outside loaded chunks. */
  add(tileX: number, tileY: number, flags: CollisionFlags): void;
  /** Clear bits. No-op outside loaded chunks. */
  remove(tileX: number, tileY: number, flags: CollisionFlags): void;
  /**
   * Recompute only the terrain bits from a tile id, preserving structure and node bits.
   * This is exactly what applying a tile override must do.
   */
  setTerrain(tileX: number, tileY: number, tile: number): void;

  isSolid(tileX: number, tileY: number): boolean;
  isOpaque(tileX: number, tileY: number): boolean;
  /** {@link isSolid} for a world pixel position. */
  isSolidAt(x: number, y: number): boolean;

  /** True when a circle at (x, y) overlaps any solid tile. Exact circle-vs-AABB test. */
  circleBlocked(x: number, y: number, radius: number): boolean;
  /**
   * Move a circle by (dx, dy) with axis-separated sliding: X is attempted first, then Y
   * from the resolved X, so pressing diagonally into a wall slides along it instead of
   * sticking. Long motions are sub-stepped so nothing tunnels.
   */
  moveCircle(x: number, y: number, dx: number, dy: number, radius: number): MoveResult;
}

/**
 * Axis-separated slide of a circle through arbitrary geometry, sub-stepped so nothing
 * tunnels.
 *
 * Exported and parameterised by the overlap test because three places need to resolve the
 * same movement against three different notions of what is solid: the authoritative grid,
 * the client's prediction, and the flat-world test double. They used to each carry their
 * own transcription of this loop, and the copies drifted - the double capped its sub-steps
 * at a hard-coded 16 instead of {@link MAX_SWEEP_STEP}, and the client had no sub-stepping,
 * no embedded-body escape and no non-finite guard at all. Measured against this function,
 * the client landed up to 12.5 px away on a knockback and refused to move at all while
 * embedded, where the server walked out at full speed.
 *
 * `overlaps` decides what blocks: it is called with a candidate centre and the radius, and
 * must be a pure static test. The three guards below are the contract, not belt and braces:
 *
 * - A non-finite delta returns the body where it stood. There is no meaningful destination,
 *   and `Math.ceil(Infinity / MAX_SWEEP_STEP)` sub-steps is an uninterruptible loop.
 * - A body already inside geometry - spawned in a wall, a wall built on top of it, a
 *   teleport - gets one unchecked step, because every candidate position would be rejected
 *   and it would be stuck for good.
 * - The sub-step count is capped, so a huge-but-finite delta goes coarse instead of
 *   spinning for millions of overlap tests.
 */
/**
 * Reused box for the circle-vs-tile test.
 *
 * `circleOverlapsAabb` takes an {@link Aabb}, and allocating one per tile in the scan loop
 * shows up in profiles. It never outlives a single overlap test and callers are all
 * single-threaded - the simulation tick and the client's own prediction - so one instance
 * is safe to share.
 */
const scratchBox: Aabb = { x: 0, y: 0, w: TILE_SIZE, h: TILE_SIZE };

/**
 * Does a circle overlap any solid tile, by the same rule the authoritative grid uses?
 *
 * Exported and parameterised by `isSolid` for the same reason as {@link sweepCircle}: the
 * grid, the client's prediction and the test double all need this exact answer, and a
 * near-miss is worse than an obvious difference. The client used to test the circle's
 * *bounding box* against the tile map with no contact tolerance, which is stricter - and
 * being stricter here is not the safe direction. Combined with the embedded-body escape in
 * `sweepCircle`, a body that had merely slid up against a wall was classified as already
 * inside it and handed free movement straight through, which is precisely the failure the
 * tolerance below exists to prevent.
 */
export function circleOverlapsSolid(
  isSolid: (tileX: number, tileY: number) => boolean,
  x: number,
  y: number,
  radius: number,
): boolean {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  const shrunk = radius - CONTACT_TOLERANCE;
  const r = shrunk > 0 ? shrunk : 0;
  const minTileX = pixelToTile(x - r);
  const maxTileX = pixelToTile(x + r);
  const minTileY = pixelToTile(y - r);
  const maxTileY = pixelToTile(y + r);
  for (let tileY = minTileY; tileY <= maxTileY; tileY++) {
    for (let tileX = minTileX; tileX <= maxTileX; tileX++) {
      if (!isSolid(tileX, tileY)) continue;
      scratchBox.x = tileX * TILE_SIZE;
      scratchBox.y = tileY * TILE_SIZE;
      if (circleOverlapsAabb(x, y, r, scratchBox)) return true;
    }
  }
  return false;
}

export function sweepCircle(
  overlaps: (x: number, y: number, radius: number) => boolean,
  x: number,
  y: number,
  dx: number,
  dy: number,
  radius: number,
): MoveResult {
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || !Number.isFinite(x) || !Number.isFinite(y)) {
    return { x, y, blockedX: false, blockedY: false };
  }
  if (dx === 0 && dy === 0) return { x, y, blockedX: false, blockedY: false };

  const stuck = overlaps(x, y, radius);

  const span = Math.max(Math.abs(dx), Math.abs(dy));
  const steps = stuck
    ? 1
    : Math.min(MAX_SWEEP_SUBSTEPS, Math.max(1, Math.ceil(span / MAX_SWEEP_STEP)));
  const stepX = dx / steps;
  const stepY = dy / steps;

  let px = x;
  let py = y;
  let blockedX = false;
  let blockedY = false;

  for (let i = 0; i < steps; i++) {
    if (stepX !== 0) {
      const nextX = px + stepX;
      if (!stuck && overlaps(nextX, py, radius)) blockedX = true;
      else px = nextX;
    }
    if (stepY !== 0) {
      const nextY = py + stepY;
      if (!stuck && overlaps(px, nextY, radius)) blockedY = true;
      else py = nextY;
    }
  }

  return { x: px, y: py, blockedX, blockedY };
}

export function createCollisionGrid(): CollisionGrid {
  const chunks = new Map<number, Uint16Array>();

  function chunkAtTile(tileX: number, tileY: number): Uint16Array | undefined {
    return chunks.get(chunkId(tileToChunk(tileX), tileToChunk(tileY)));
  }

  function get(tileX: number, tileY: number): CollisionFlags {
    const chunk = chunkAtTile(tileX, tileY);
    if (chunk === undefined) return CollisionFlag.None;
    return chunk[chunkTileIndex(tileX, tileY)] ?? CollisionFlag.None;
  }

  function isSolid(tileX: number, tileY: number): boolean {
    return (get(tileX, tileY) & SOLID_MASK) !== 0;
  }

  /**
   * Solid-tile overlap scan, with the contact tolerance applied.
   *
   * The effective radius is clamped at zero because `circleOverlapsAabb` squares it: a
   * negative radius would otherwise behave exactly like a positive one.
   */
  function overlapsSolid(x: number, y: number, radius: number): boolean {
    return circleOverlapsSolid(isSolid, x, y, radius);
  }

  function circleBlocked(x: number, y: number, radius: number): boolean {
    return overlapsSolid(x, y, radius);
  }

  function moveCircle(x: number, y: number, dx: number, dy: number, radius: number): MoveResult {
    return sweepCircle(overlapsSolid, x, y, dx, dy, radius);
  }

  return {
    seedChunk(cx, cy, tiles) {
      if (tiles.length !== CHUNK_TILE_COUNT) {
        throw new Error(`seedChunk expects ${CHUNK_TILE_COUNT} tiles, received ${tiles.length}`);
      }
      const id = chunkId(Math.floor(cx), Math.floor(cy));
      if (id < 0) return;
      let chunk = chunks.get(id);
      if (chunk === undefined) {
        chunk = new Uint16Array(CHUNK_TILE_COUNT);
        chunks.set(id, chunk);
      }
      // Every entry is written, so the reused buffer needs no clearing pass.
      for (let i = 0; i < CHUNK_TILE_COUNT; i++) {
        chunk[i] = terrainCollisionFlags(tiles[i] ?? 0);
      }
    },

    clearChunk(cx, cy) {
      chunks.delete(chunkId(Math.floor(cx), Math.floor(cy)));
    },

    hasChunk(cx, cy) {
      return chunks.has(chunkId(Math.floor(cx), Math.floor(cy)));
    },

    get chunkCount() {
      return chunks.size;
    },

    get,

    add(tileX, tileY, flags) {
      const chunk = chunkAtTile(tileX, tileY);
      if (chunk === undefined) return;
      const index = chunkTileIndex(tileX, tileY);
      const current = chunk[index];
      if (current === undefined) return;
      chunk[index] = current | flags;
    },

    remove(tileX, tileY, flags) {
      const chunk = chunkAtTile(tileX, tileY);
      if (chunk === undefined) return;
      const index = chunkTileIndex(tileX, tileY);
      const current = chunk[index];
      if (current === undefined) return;
      chunk[index] = current & ~flags;
    },

    setTerrain(tileX, tileY, tile) {
      const chunk = chunkAtTile(tileX, tileY);
      if (chunk === undefined) return;
      const index = chunkTileIndex(tileX, tileY);
      const current = chunk[index];
      if (current === undefined) return;
      chunk[index] = (current & ~TERRAIN_MASK) | terrainCollisionFlags(tile);
    },

    isSolid,

    isOpaque(tileX, tileY) {
      return (get(tileX, tileY) & OPAQUE_MASK) !== 0;
    },

    isSolidAt(x, y) {
      return isSolid(pixelToTile(x), pixelToTile(y));
    },

    circleBlocked,
    moveCircle,
  };
}
