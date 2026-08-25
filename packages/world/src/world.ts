/**
 * The {@link WorldService}: the single object the simulation asks about the map.
 *
 * Everything the other modules in this package do is stateless or per-call. This file is
 * where the *state* lives, and there is exactly enough of it to answer a query without
 * asking the disk:
 *
 * - **terrain cache** - generated {@link ChunkTerrain} per chunk, with tile overrides
 *   already baked into `tiles` so the replication path can ship `terrain.tiles` straight
 *   to a client and see the tilled soil the player made;
 * - **collision grid** - the one authority for "can something stand here";
 * - **tile overrides** - per chunk, the only part of the tile layer that is persisted;
 * - **flow-field cache** - one integrated field per horde goal.
 *
 * Two rules shape the whole file.
 *
 * **Terrain is a pure function of the seed, so a cache can never change an answer.**
 * Regenerating chunk (5, 7) after unloading it produces the identical 1024 tiles, and the
 * override map is kept *outside* the cache so unloading and reloading inside one session
 * cannot lose a change (spec section 29, Architecture Guard rules 7 and 9). Nothing here
 * memoises anything that depends on which chunk was asked about first.
 *
 * **The dynamic layer is only ever patched on top, never generated into.** A chunk load is
 * always `generate -> seed collision -> apply overrides`, in that order. Doing it the other
 * way round - seeding the grid from pristine terrain *after* the overrides were applied -
 * is the bug that silently un-tills a farm every time its chunk is reloaded, and it is
 * invisible until someone walks away from their crops and comes back.
 */

import {
  Biome,
  CHUNK_TILES,
  CHUNK_TILE_COUNT,
  Tile,
  WORLD_SIZE,
  chunkKey,
  chunkTileIndex,
  isChunkInWorld,
  isTileInWorld,
  pixelToTile,
  tileProps,
  tileToChunk,
} from '@survive/protocol';
import type { ChunkKey, ChunkTerrain, TileOverride, WorldGenConfig } from '@survive/protocol';
import { createCollisionGrid, terrainCollisionFlags } from './collision';
import { createFlowFieldCache, sampleFlow as sampleFlowAt } from './flowfield';
import { findPath as findGridPath } from './pathfinding';
import { hasLineOfSight as gridHasLineOfSight, raycast as gridRaycast } from './raycast';
import { createTerrainGenerator } from './terrain';
import { CollisionFlag, OPAQUE_MASK, SOLID_MASK } from './types';
import type {
  CollisionFlags,
  FlowField,
  MoveResult,
  PathOptions,
  RaycastHit,
  TerrainGenerator,
  WorldService,
} from './types';

/**
 * Default staleness window for {@link WorldService.getFlowField}, in ticks.
 *
 * Three seconds at 20 Hz. {@link WorldService.getFlowField} has no age parameter - a
 * horde's followers must all get the *same* field, so the freshness policy has to belong
 * to the world, not to whichever agent asked first. Three seconds is long enough that one
 * player sprinting across a chunk costs a handful of integrations, and short enough that
 * nobody chases a ghost.
 */
export const DEFAULT_FLOW_FIELD_MAX_AGE_TICKS = 60;

/** Candidate budget for {@link WorldService.findSpawnPosition} when the caller omits one. */
export const DEFAULT_SPAWN_ATTEMPTS = 32;

/**
 * How many *probed* chunks stay memoised.
 *
 * A probe is a tile query in a chunk nobody loaded - the tail of a spawn scan, a system
 * looking one chunk ahead. Those legitimately happen (see {@link WorldService.getTile}),
 * but they must not turn into permanent state: a chunk the simulation never installed is a
 * chunk it will never unload, so caching probes in the resident map would leak a chunk of
 * terrain for every tile a player walked past.
 *
 * The memo is bounded and evicts least-recently-used. That is order-dependent *storage*,
 * not an order-dependent *answer*: terrain is a pure function of the seed and the override
 * map lives outside the memo, so a rebuilt entry is byte-identical to the one it replaced.
 * Thirty-two chunks covers a 5x5 spawn scan with room to spare.
 */
export const TERRAIN_PROBE_CACHE_CHUNKS = 32;

/**
 * Collision bits outside the world rectangle.
 *
 * Outside is {@link Tile.Void}, which is solid, so the map is a closed box. The bits are
 * derived from the tile table rather than written out, so the border cannot drift away
 * from what `Tile.Void` means.
 */
const VOID_COLLISION_FLAGS: CollisionFlags = terrainCollisionFlags(Tile.Void);

const TAU = Math.PI * 2;

/**
 * One override, plus the tile the generator would have put there.
 *
 * Keeping the generated value is what lets {@link WorldService.setTile} *remove* an
 * override that has become a no-op. Farming does exactly that on every harvest - till
 * grass, then set it back to grass - and without the check every crop cycle would leave a
 * permanent entry in the save file. The generated value is refreshed from the pristine
 * array every time the chunk is built, so it can never go stale.
 */
interface OverrideEntry {
  tile: number;
  generated: number;
}

/** A chunk's terrain plus the coordinates needed to address it, with overrides applied. */
interface CachedChunk {
  cx: number;
  cy: number;
  terrain: ChunkTerrain;
}

/**
 * Build the world service for one seed.
 *
 * The returned object owns every piece of mutable world state; two calls give two
 * independent worlds, which is what makes a test able to reload a chunk into a fresh
 * service and compare.
 */
export function createWorld(config: WorldGenConfig): WorldService {
  const generator: TerrainGenerator = createTerrainGenerator(config);
  const grid = createCollisionGrid();

  /**
   * Chunks the caller explicitly loaded. These own their collision and live until
   * {@link WorldService.unloadChunk}.
   */
  const residents = new Map<ChunkKey, CachedChunk>();
  /** Bounded LRU memo of probed chunks. Never seeded into the collision grid. */
  const probes = new Map<ChunkKey, CachedChunk>();
  /** Tile overrides per chunk, keyed by row-major tile index. Outlives an unload. */
  const overrides = new Map<ChunkKey, Map<number, OverrideEntry>>();

  /**
   * Doors are impassable to the shared field on purpose.
   *
   * One field serves everything chasing the same goal, and that includes animals and the
   * zombie types that cannot open or break doors. A field that routed through a closed
   * door would send a deer at it. Agents that *are* allowed through pay for their own A*
   * with their own `doorCost`, which is the only place that policy is per-creature.
   */
  const flowFields = createFlowFieldCache({ doorCost: 0 });

  // -------------------------------------------------------------------------
  // Chunk cache
  // -------------------------------------------------------------------------

  /**
   * Freshly generated terrain for a chunk, before any override is applied.
   *
   * Chunks outside the world get an all-{@link Tile.Void} map rather than terrain sampled
   * at out-of-range coordinates: the noise fields are perfectly happy to answer there, and
   * generating plausible grassland outside the playable area would put walkable ground on
   * the far side of the border.
   */
  function generateChunk(cx: number, cy: number): CachedChunk {
    if (!isChunkInWorld(cx, cy)) {
      return {
        cx,
        cy,
        terrain: {
          cx,
          cy,
          tiles: new Array<number>(CHUNK_TILE_COUNT).fill(Tile.Void),
          // Biome ids have no "void" member and `biomeProps` falls back to grassland, so
          // that is the honest value to report for a place that does not exist.
          biomes: new Array<number>(CHUNK_TILE_COUNT).fill(Biome.Grassland),
          version: generator.version,
        },
      };
    }
    return { cx, cy, terrain: generator.generate(cx, cy) };
  }

  /**
   * Patch a freshly generated chunk with the overrides recorded for it.
   *
   * Updates the tile array *and* the collision grid. The grid write goes through
   * `setTerrain`, which rewrites only the terrain bits, so an override applied to a tile
   * that already carries a structure or a resource node leaves those bits alone.
   *
   * Entries that no longer differ from the generated tile are dropped here as well: the
   * generator may have changed under an old save, and an override that agrees with terrain
   * is pure save-file weight.
   */
  function applyRecordedOverrides(chunk: CachedChunk): void {
    const key = chunkKey(chunk.cx, chunk.cy);
    const recorded = overrides.get(key);
    if (recorded === undefined) return;
    const originX = chunk.cx * CHUNK_TILES;
    const originY = chunk.cy * CHUNK_TILES;
    for (const [index, entry] of recorded) {
      const pristine = chunk.terrain.tiles[index] ?? Tile.Void;
      entry.generated = pristine;
      if (entry.tile === pristine) {
        // Deleting during iteration is well defined for a Map: the entry is simply not
        // revisited.
        recorded.delete(index);
        continue;
      }
      chunk.terrain.tiles[index] = entry.tile;
      grid.setTerrain(
        originX + (index % CHUNK_TILES),
        originY + Math.floor(index / CHUNK_TILES),
        entry.tile,
      );
    }
    if (recorded.size === 0) overrides.delete(key);
  }

  /** Remember a probed chunk, evicting the least recently used one past the cap. */
  function rememberProbe(key: ChunkKey, chunk: CachedChunk): void {
    probes.set(key, chunk);
    if (probes.size <= TERRAIN_PROBE_CACHE_CHUNKS) return;
    const oldest = probes.keys().next().value;
    if (oldest !== undefined) probes.delete(oldest);
  }

  /**
   * The chunk holding a tile, generating it if nobody has loaded it.
   *
   * Resident chunks win; otherwise the probe memo answers, and a miss generates into it.
   * A probe deliberately does **not** touch the collision grid: collision for a chunk the
   * simulation never installed is state nothing would ever clean up, and every collision
   * query already treats an unseeded chunk as open (see `collision.ts`).
   */
  function chunkFor(cx: number, cy: number): CachedChunk {
    const key = chunkKey(cx, cy);
    const resident = residents.get(key);
    if (resident !== undefined) return resident;
    const probe = probes.get(key);
    if (probe !== undefined) {
      // Refresh the LRU position.
      probes.delete(key);
      probes.set(key, probe);
      return probe;
    }
    const chunk = generateChunk(cx, cy);
    applyRecordedOverrides(chunk);
    rememberProbe(key, chunk);
    return chunk;
  }

  function ensureChunk(cx: number, cy: number): ChunkTerrain {
    const chunkX = Math.floor(cx);
    const chunkY = Math.floor(cy);
    const key = chunkKey(chunkX, chunkY);

    const resident = residents.get(key);
    if (resident !== undefined) {
      // The grid can only be missing if something cleared it without going through
      // `unloadChunk`. Re-seed from the tiles we are already holding rather than hand out
      // terrain the collision grid disagrees with. Overrides are already baked into those
      // tiles, so this needs no second pass.
      if (!grid.hasChunk(chunkX, chunkY)) grid.seedChunk(chunkX, chunkY, resident.terrain.tiles);
      return resident.terrain;
    }

    // Regenerate rather than promote the probe: a probed chunk already has its overrides
    // baked in, and seeding the grid from patched tiles would quietly skip the
    // generate -> seed -> override ordering this whole file depends on.
    probes.delete(key);

    const chunk = generateChunk(chunkX, chunkY);
    grid.seedChunk(chunkX, chunkY, chunk.terrain.tiles);
    applyRecordedOverrides(chunk);
    residents.set(key, chunk);
    return chunk.terrain;
  }

  function unloadChunk(key: ChunkKey): void {
    probes.delete(key);
    const chunk = residents.get(key);
    if (chunk === undefined) return;
    residents.delete(key);
    grid.clearChunk(chunk.cx, chunk.cy);
    // Overrides are deliberately kept. They are the caller's to persist, and dropping them
    // here would mean a chunk unloaded and re-entered inside one session came back with the
    // player's changes missing - a data loss the caller cannot defend against.
  }

  // -------------------------------------------------------------------------
  // Tiles
  // -------------------------------------------------------------------------

  function getTile(tileX: number, tileY: number): number {
    if (!isTileInWorld(tileX, tileY)) return Tile.Void;
    const chunk = chunkFor(tileToChunk(tileX), tileToChunk(tileY));
    return chunk.terrain.tiles[chunkTileIndex(tileX, tileY)] ?? Tile.Void;
  }

  function getTileAt(x: number, y: number): number {
    return getTile(pixelToTile(x), pixelToTile(y));
  }

  function getBiome(tileX: number, tileY: number): number {
    if (!isTileInWorld(tileX, tileY)) return Biome.Grassland;
    const key = chunkKey(tileToChunk(tileX), tileToChunk(tileY));
    const chunk = residents.get(key) ?? probes.get(key);
    if (chunk !== undefined)
      return chunk.terrain.biomes[chunkTileIndex(tileX, tileY)] ?? Biome.Grassland;
    // Nothing has loaded this chunk. `biomeAt` is the generator's point query and agrees
    // with the chunk it would have produced, so this answers without paying for 1024 tiles
    // - which matters because the spawn budget samples biomes across a whole chunk.
    return generator.biomeAt(tileX, tileY);
  }

  function setTile(tileX: number, tileY: number, tile: number): void {
    if (!isTileInWorld(tileX, tileY)) return;
    const cx = tileToChunk(tileX);
    const cy = tileToChunk(tileY);
    const chunk = chunkFor(cx, cy);
    const index = chunkTileIndex(tileX, tileY);
    const key = chunkKey(cx, cy);

    let recorded = overrides.get(key);
    const existing = recorded?.get(index);
    // For an index that is not overridden yet, the array still holds the generated tile.
    const generated =
      existing !== undefined ? existing.generated : (chunk.terrain.tiles[index] ?? Tile.Void);

    if (tile === generated) {
      if (recorded !== undefined) {
        recorded.delete(index);
        if (recorded.size === 0) overrides.delete(key);
      }
    } else if (existing !== undefined) {
      existing.tile = tile;
    } else {
      if (recorded === undefined) {
        recorded = new Map<number, OverrideEntry>();
        overrides.set(key, recorded);
      }
      recorded.set(index, { tile, generated });
    }

    chunk.terrain.tiles[index] = tile;
    // Terrain bits only: a wall built on this tile, or a tree standing on it, must survive
    // the ground underneath it changing.
    grid.setTerrain(tileX, tileY, tile);
  }

  /**
   * Overrides for a chunk, sorted by tile index.
   *
   * Sorted rather than insertion-ordered so the saved list is a function of *which* tiles
   * changed and not of the order the player changed them: two saves of the same world
   * compare equal, and a round trip through disk cannot reshuffle anything.
   */
  function getOverrides(cx: number, cy: number): TileOverride[] {
    const recorded = overrides.get(chunkKey(cx, cy));
    if (recorded === undefined) return [];
    const out: TileOverride[] = [];
    for (const [index, entry] of recorded) out.push({ index, tile: entry.tile });
    out.sort((a, b) => a.index - b.index);
    return out;
  }

  /**
   * Replace a chunk's overrides with the ones loaded from disk.
   *
   * Replace, not merge: this is the other half of {@link getOverrides}, and a load has to
   * be able to say "this chunk has exactly these changes". Tiles that were overridden
   * before and are absent from the list are reverted to their generated value, so applying
   * an empty list really does restore virgin terrain.
   */
  function applyOverrides(cx: number, cy: number, list: readonly TileOverride[]): void {
    const key = chunkKey(cx, cy);
    const previous = overrides.get(key);
    if (previous === undefined && list.length === 0) return;

    // Needed for the generated values, and to patch the tiles the caller will read next.
    const chunk = chunkFor(cx, cy);
    const originX = cx * CHUNK_TILES;
    const originY = cy * CHUNK_TILES;

    const next = new Map<number, OverrideEntry>();
    for (const entry of list) {
      const index = Math.floor(entry.index);
      if (!Number.isFinite(index) || index < 0 || index >= CHUNK_TILE_COUNT) continue;
      const before = previous?.get(index);
      // A previously overridden index no longer holds its generated tile in the array, so
      // the recorded generated value is the only source for it.
      const generated =
        before !== undefined ? before.generated : (chunk.terrain.tiles[index] ?? Tile.Void);
      if (entry.tile === generated) continue;
      // Later entries win, which makes a list containing the same index twice harmless.
      next.set(index, { tile: entry.tile, generated });
    }

    // Revert anything that dropped out of the set before writing the new values, so an
    // index that appears in both lists is not reverted after being applied.
    if (previous !== undefined) {
      for (const [index, entry] of previous) {
        if (next.has(index)) continue;
        chunk.terrain.tiles[index] = entry.generated;
        grid.setTerrain(
          originX + (index % CHUNK_TILES),
          originY + Math.floor(index / CHUNK_TILES),
          entry.generated,
        );
      }
    }
    for (const [index, entry] of next) {
      chunk.terrain.tiles[index] = entry.tile;
      grid.setTerrain(
        originX + (index % CHUNK_TILES),
        originY + Math.floor(index / CHUNK_TILES),
        entry.tile,
      );
    }

    if (next.size === 0) overrides.delete(key);
    else overrides.set(key, next);
  }

  // -------------------------------------------------------------------------
  // Collision
  // -------------------------------------------------------------------------

  /**
   * Raw bits at a tile, with the world border folded in.
   *
   * Outside the playable rectangle the answer is the `Tile.Void` bits *or* whatever the
   * grid holds, so the border reads solid whether or not anyone ever seeded a chunk out
   * there.
   */
  function getCollision(tileX: number, tileY: number): CollisionFlags {
    const flags = grid.get(tileX, tileY);
    return isTileInWorld(tileX, tileY) ? flags : flags | VOID_COLLISION_FLAGS;
  }

  function isSolidTile(tileX: number, tileY: number): boolean {
    return (getCollision(tileX, tileY) & SOLID_MASK) !== 0;
  }

  /**
   * True when any part of the circle lies outside the world rectangle.
   *
   * Exact touching does not count, matching the way the collision grid treats a circle
   * grazing a wall as contact rather than penetration.
   */
  function crossesBorder(x: number, y: number, radius: number): boolean {
    const r = radius > 0 ? radius : 0;
    return x - r < 0 || y - r < 0 || x + r > WORLD_SIZE || y + r > WORLD_SIZE;
  }

  function circleBlocked(x: number, y: number, radius: number): boolean {
    if (crossesBorder(x, y, radius)) return true;
    return grid.circleBlocked(x, y, radius);
  }

  /**
   * Swept move with sliding, then clamped to the world box.
   *
   * The clamp is here rather than in the grid because the grid only knows about tiles that
   * were seeded, and the ring of chunks outside the world never is. Clamping the *result*
   * (instead of pre-trimming the delta) keeps the slide behaviour identical everywhere the
   * border is not involved, and an entity that somehow started outside is nudged back in
   * rather than left stranded.
   */
  function moveCircle(x: number, y: number, dx: number, dy: number, radius: number): MoveResult {
    const moved = grid.moveCircle(x, y, dx, dy, radius);
    if (dx === 0 && dy === 0) return moved;

    const inset = Math.min(radius > 0 ? radius : 0, WORLD_SIZE / 2);
    const limit = WORLD_SIZE - inset;
    let { x: resolvedX, y: resolvedY, blockedX, blockedY } = moved;
    if (resolvedX < inset) {
      resolvedX = inset;
      blockedX = true;
    } else if (resolvedX > limit) {
      resolvedX = limit;
      blockedX = true;
    }
    if (resolvedY < inset) {
      resolvedY = inset;
      blockedY = true;
    } else if (resolvedY > limit) {
      resolvedY = limit;
      blockedY = true;
    }
    return { x: resolvedX, y: resolvedY, blockedX, blockedY };
  }

  // -------------------------------------------------------------------------
  // Spawning
  // -------------------------------------------------------------------------

  /**
   * Can a circle of `radius` be dropped here?
   *
   * The tile test goes through {@link getTile}, which generates on demand, so a candidate
   * in a chunk nobody has loaded is still judged against real terrain instead of against
   * an unseeded (and therefore empty) collision chunk. The circle test on top of that is
   * what catches structures, resource nodes, and a spot that is walkable but too tight.
   */
  function isSpawnable(x: number, y: number, radius: number): boolean {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    const props = tileProps(getTileAt(x, y));
    if (props.solid || props.deep) return false;
    // Deep can also arrive from the grid alone - a flooded tile under a structure - so the
    // bit is checked as well as the tile table.
    if ((getCollision(pixelToTile(x), pixelToTile(y)) & CollisionFlag.Deep) !== 0) return false;
    return !circleBlocked(x, y, radius);
  }

  /**
   * A walkable point near (x, y), or null.
   *
   * Candidates come from `roll()` and nothing else: no `Math.random`, no wall clock, no
   * "try the centre first" shortcut. The centre shortcut is specifically wrong here -
   * every creature spawned into one chunk asks about the same chunk centre, and handing
   * back the exact centre whenever it happens to be free would stack a whole night's
   * zombies on one pixel.
   *
   * Each attempt consumes exactly two rolls, angle then distance, and the distance is
   * `radius * sqrt(u)` so candidates are uniform over the disc rather than piling up near
   * the middle.
   */
  function findSpawnPosition(
    x: number,
    y: number,
    radius: number,
    entityRadius: number,
    roll: () => number,
    attempts = DEFAULT_SPAWN_ATTEMPTS,
  ): { x: number; y: number } | null {
    const budget = Number.isFinite(attempts) ? Math.max(0, Math.floor(attempts)) : 0;
    const span = radius > 0 ? radius : 0;
    for (let attempt = 0; attempt < budget; attempt++) {
      const angle = roll() * TAU;
      const distance = span * Math.sqrt(roll());
      const candidateX = x + Math.cos(angle) * distance;
      const candidateY = y + Math.sin(angle) * distance;
      if (isSpawnable(candidateX, candidateY, entityRadius)) {
        return { x: candidateX, y: candidateY };
      }
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // The service
  // -------------------------------------------------------------------------

  return {
    seed: config.seed,
    generator,

    ensureChunk,
    isChunkLoaded: (key) => residents.has(key),
    // Sorted so a log line or a save manifest is a function of *which* chunks are loaded,
    // not of the order players wandered into them.
    loadedChunkKeys: () => [...residents.keys()].sort(),
    unloadChunk,

    getTile,
    getTileAt,
    getBiome,
    setTile,
    getOverrides,
    applyOverrides,

    addCollision: (tileX, tileY, flags) => grid.add(tileX, tileY, flags),
    removeCollision: (tileX, tileY, flags) => grid.remove(tileX, tileY, flags),
    getCollision,
    isSolidTile,
    isSolidAt: (x, y) => isSolidTile(pixelToTile(x), pixelToTile(y)),
    isOpaqueTile: (tileX, tileY) => (getCollision(tileX, tileY) & OPAQUE_MASK) !== 0,
    speedAt: (x, y) => tileProps(getTileAt(x, y)).speed,
    circleBlocked,
    moveCircle,
    raycast: (x0, y0, x1, y1): RaycastHit | null => gridRaycast(grid, x0, y0, x1, y1),
    hasLineOfSight: (x0, y0, x1, y1) => gridHasLineOfSight(grid, x0, y0, x1, y1),

    /**
     * A* over the collision grid.
     *
     * Deliberately does not force chunks to load along the route: an unseeded chunk reads
     * as open, so a path may lead off towards terrain that has not streamed in yet, which
     * is exactly what an agent walking towards the edge of the loaded area should do.
     */
    findPath: (fromX, fromY, toX, toY, options?: PathOptions): number[] =>
      findGridPath(grid, fromX, fromY, toX, toY, options),

    getFlowField: (goalX, goalY, tick): FlowField =>
      flowFields.get(grid, goalX, goalY, tick, DEFAULT_FLOW_FIELD_MAX_AGE_TICKS),
    sampleFlow: (field, x, y) => sampleFlowAt(field, x, y),
    pruneFlowFields: (tick, maxAgeTicks) => flowFields.prune(tick, maxAgeTicks),
    get flowFieldBuilds() {
      return flowFields.builds;
    },

    findSpawnPosition,
  };
}
