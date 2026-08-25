import { beforeAll, describe, expect, it } from 'vitest';
import {
  Biome,
  CHUNK_SIZE,
  CHUNK_TILES,
  CHUNK_TILE_COUNT,
  TILE_SIZE,
  Tile,
  WORLD_SIZE,
  WORLD_TILES,
  chunkKey,
  chunkTileIndex,
  defaultWorldGenConfig,
  pixelToTile,
  tileCenter,
  tileProps,
  tileToChunk,
} from '@survive/protocol';
import type { WorldGenConfig } from '@survive/protocol';
import { CollisionFlag, SOLID_MASK } from './types';
import type { WorldService } from './types';
import { DEFAULT_FLOW_FIELD_MAX_AGE_TICKS, createWorld } from './world';

/**
 * These tests run against *real generated terrain*, not a hand-painted grid.
 *
 * That is the point: the flat test world in `@survive/test-utils` already proves the
 * algorithms, and what is left to prove is that they are wired to the generator, to the
 * override layer and to the collision grid correctly - the seams where a chunk reload
 * loses a farm, or where a wall the generator placed is not in the grid.
 *
 * Terrain is a pure function of the seed, so the features the tests need (a wall with
 * open ground beside it, a window in a wall, a lake, a clearing) are *found* by a bounded
 * scan rather than hard-coded as magic coordinates. A search that comes up empty fails
 * loudly with the pattern it was looking for, so a change to the generator produces a
 * readable failure instead of a mystery assertion.
 */

const SEED = 20260824;

/** Chunk window every scan and every test works inside. Chosen to contain a town. */
const REGION_MIN_CX = 124;
const REGION_MAX_CX = 131;
const REGION_MIN_CY = 123;
const REGION_MAX_CY = 126;

function config(overrides: Partial<WorldGenConfig> = {}): WorldGenConfig {
  return { ...defaultWorldGenConfig(SEED), ...overrides };
}

function newWorld(overrides: Partial<WorldGenConfig> = {}): WorldService {
  return createWorld(config(overrides));
}

/** Load the chunks around a tile so collision queries there have something to read. */
function ensureAround(world: WorldService, tileX: number, tileY: number, chunkRadius = 1): void {
  const cx = tileToChunk(tileX);
  const cy = tileToChunk(tileY);
  for (let dy = -chunkRadius; dy <= chunkRadius; dy++) {
    for (let dx = -chunkRadius; dx <= chunkRadius; dx++) world.ensureChunk(cx + dx, cy + dy);
  }
}

interface Tile2 {
  tileX: number;
  tileY: number;
}

/**
 * The generated features the tests below need.
 *
 * Found once, from one throwaway world: terrain depends only on the seed, so a coordinate
 * discovered here is valid in every world built from the same config.
 */
interface Features {
  /** Solid tile with open ground to its west, north-west and south-west. */
  slide: Tile2;
  /** {@link Tile.WindowStatic} with standable, transparent tiles due east and west. */
  window: Tile2;
  /** Opaque wall tile with standable, transparent tiles due east and west. */
  wall: Tile2;
  /** Wall tile with open ground to its west and a building floor to its east. */
  crossing: Tile2;
  /** Centre of a 5x5 patch of deep water. */
  deep: Tile2;
  /** Centre of a 9x9 patch with nothing solid and no deep water. */
  clear: Tile2;
}

let features: Features;

function findFeatures(): Features {
  const world = newWorld();
  for (let cy = REGION_MIN_CY; cy <= REGION_MAX_CY; cy++) {
    for (let cx = REGION_MIN_CX; cx <= REGION_MAX_CX; cx++) world.ensureChunk(cx, cy);
  }
  const minTileX = REGION_MIN_CX * CHUNK_TILES;
  const maxTileX = (REGION_MAX_CX + 1) * CHUNK_TILES - 1;
  const minTileY = REGION_MIN_CY * CHUNK_TILES;
  const maxTileY = (REGION_MAX_CY + 1) * CHUNK_TILES - 1;

  const solid = (tileX: number, tileY: number) => tileProps(world.getTile(tileX, tileY)).solid;
  const opaque = (tileX: number, tileY: number) => tileProps(world.getTile(tileX, tileY)).opaque;
  const open = (tileX: number, tileY: number) => !solid(tileX, tileY) && !opaque(tileX, tileY);
  const floor = (tileX: number, tileY: number) => {
    const tile = world.getTile(tileX, tileY);
    return tile === Tile.FloorWood || tile === Tile.FloorConcrete || tile === Tile.FloorTile;
  };

  let slide: Tile2 | null = null;
  let window: Tile2 | null = null;
  let wall: Tile2 | null = null;
  let crossing: Tile2 | null = null;
  let deep: Tile2 | null = null;
  let clear: Tile2 | null = null;

  for (let tileY = minTileY + 5; tileY <= maxTileY - 5; tileY++) {
    for (let tileX = minTileX + 5; tileX <= maxTileX - 5; tileX++) {
      const tile = world.getTile(tileX, tileY);
      const isSolid = tileProps(tile).solid;

      if (
        slide === null &&
        isSolid &&
        !solid(tileX - 1, tileY - 1) &&
        !solid(tileX - 1, tileY) &&
        !solid(tileX - 1, tileY + 1)
      ) {
        slide = { tileX, tileY };
      }
      if (
        window === null &&
        tile === Tile.WindowStatic &&
        open(tileX - 1, tileY) &&
        open(tileX + 1, tileY)
      ) {
        window = { tileX, tileY };
      }
      if (
        wall === null &&
        tileProps(tile).opaque &&
        open(tileX - 1, tileY) &&
        open(tileX + 1, tileY)
      ) {
        wall = { tileX, tileY };
      }
      if (crossing === null && isSolid && open(tileX - 1, tileY) && floor(tileX + 1, tileY)) {
        crossing = { tileX, tileY };
      }
      if (deep === null && world.getTile(tileX, tileY) === Tile.WaterDeep) {
        let allDeep = true;
        for (let dy = -2; dy <= 2 && allDeep; dy++) {
          for (let dx = -2; dx <= 2 && allDeep; dx++) {
            if (world.getTile(tileX + dx, tileY + dy) !== Tile.WaterDeep) allDeep = false;
          }
        }
        if (allDeep) deep = { tileX, tileY };
      }
      if (clear === null && !isSolid) {
        let allClear = true;
        for (let dy = -4; dy <= 4 && allClear; dy++) {
          for (let dx = -4; dx <= 4 && allClear; dx++) {
            if (solid(tileX + dx, tileY + dy)) allClear = false;
            if (world.getTile(tileX + dx, tileY + dy) === Tile.WaterDeep) allClear = false;
          }
        }
        if (allClear) clear = { tileX, tileY };
      }
    }
  }

  const missing: string[] = [];
  if (slide === null) missing.push('a solid tile with open ground west of it');
  if (window === null) missing.push('a window with open tiles either side');
  if (wall === null) missing.push('an opaque wall with open tiles either side');
  if (crossing === null) missing.push('a wall between open ground and a building floor');
  if (deep === null) missing.push('a 5x5 patch of deep water');
  if (clear === null) missing.push('a 9x9 clearing');
  if (missing.length > 0) {
    throw new Error(
      `generated terrain in the test region no longer contains: ${missing.join('; ')}`,
    );
  }
  return {
    slide: slide as Tile2,
    window: window as Tile2,
    wall: wall as Tile2,
    crossing: crossing as Tile2,
    deep: deep as Tile2,
    clear: clear as Tile2,
  };
}

beforeAll(() => {
  features = findFeatures();
});

// ---------------------------------------------------------------------------
// Chunk lifecycle
// ---------------------------------------------------------------------------

describe('createWorld chunk lifecycle', () => {
  it('regenerates an unloaded chunk to exactly the same tiles', () => {
    const world = newWorld();
    const key = chunkKey(126, 124);
    const first = world.ensureChunk(126, 124);
    const tiles = [...first.tiles];
    const biomes = [...first.biomes];
    expect(tiles).toHaveLength(CHUNK_TILE_COUNT);
    expect(world.isChunkLoaded(key)).toBe(true);

    // Unrelated work between the two loads: a cache keyed on anything but the coordinate,
    // or a buffer shared between chunks, would show up here.
    world.ensureChunk(129, 126);
    world.ensureChunk(125, 123);
    world.unloadChunk(key);
    expect(world.isChunkLoaded(key)).toBe(false);

    const again = world.ensureChunk(126, 124);
    expect([...again.tiles]).toEqual(tiles);
    expect([...again.biomes]).toEqual(biomes);
    expect(again.version).toBe(first.version);

    // And an independent service built from the same config agrees, which is what makes a
    // save portable between a single-player session and a dedicated server.
    expect([...newWorld().ensureChunk(126, 124).tiles]).toEqual(tiles);
  });

  it('reports loaded chunks and drops their collision on unload', () => {
    const world = newWorld();
    world.ensureChunk(126, 124);
    world.ensureChunk(125, 124);
    expect(world.loadedChunkKeys()).toEqual([chunkKey(125, 124), chunkKey(126, 124)]);

    const { tileX, tileY } = features.slide;
    ensureAround(world, tileX, tileY);
    expect(world.isSolidTile(tileX, tileY)).toBe(true);
    world.unloadChunk(chunkKey(tileToChunk(tileX), tileToChunk(tileY)));
    // An unloaded chunk reads as open, not as an error: the simulation probes past the
    // edge of the loaded area all the time.
    expect(world.getCollision(tileX, tileY)).toBe(CollisionFlag.None);
  });

  it('answers a tile query in an ungenerated chunk without loading it', () => {
    const world = newWorld();
    expect(world.loadedChunkKeys()).toEqual([]);
    const tile = world.getTile(126 * CHUNK_TILES + 7, 124 * CHUNK_TILES + 9);
    expect(tile).toBe(world.ensureChunk(126, 124).tiles[9 * CHUNK_TILES + 7]);
    // The probe answered from a memo, so it never became state the caller has to unload.
    const probeOnly = newWorld();
    probeOnly.getTile(126 * CHUNK_TILES + 7, 124 * CHUNK_TILES + 9);
    expect(probeOnly.loadedChunkKeys()).toEqual([]);
    expect(probeOnly.isChunkLoaded(chunkKey(126, 124))).toBe(false);
  });

  it('treats everything outside the world as solid void', () => {
    const world = newWorld();
    expect(world.getTile(-1, 10)).toBe(Tile.Void);
    expect(world.getTile(WORLD_TILES, 10)).toBe(Tile.Void);
    expect(world.getTileAt(-16, 16)).toBe(Tile.Void);
    expect(world.getBiome(-1, 10)).toBe(Biome.Grassland);
    expect(world.isSolidTile(-1, 10)).toBe(true);
    expect(world.isSolidAt(-16, 16)).toBe(true);
    expect(world.circleBlocked(4, 4, 8)).toBe(true);
    expect(world.circleBlocked(WORLD_SIZE - 4, 512, 8)).toBe(true);

    // The border stops a walk instead of letting it leave the map.
    const moved = world.moveCircle(20, 512, -40, 0, 12);
    expect(moved.blockedX).toBe(true);
    expect(moved.x).toBe(12);
    expect(world.circleBlocked(moved.x, moved.y, 12)).toBe(false);
  });

  it('reports the same biome whether or not the chunk is loaded', () => {
    // getBiome reads the loaded chunk when there is one and the generator's point query
    // otherwise; the two must not disagree or spawn budgets would shift on chunk load.
    const loaded = newWorld();
    const unloaded = newWorld();
    const terrain = loaded.ensureChunk(127, 125);
    for (let index = 0; index < CHUNK_TILE_COUNT; index += 7) {
      const tileX = 127 * CHUNK_TILES + (index % CHUNK_TILES);
      const tileY = 125 * CHUNK_TILES + Math.floor(index / CHUNK_TILES);
      expect(unloaded.getBiome(tileX, tileY)).toBe(terrain.biomes[index]);
      expect(loaded.getBiome(tileX, tileY)).toBe(terrain.biomes[index]);
    }
  });
});

// ---------------------------------------------------------------------------
// Tile overrides
// ---------------------------------------------------------------------------

describe('createWorld tile overrides', () => {
  it('survives getOverrides -> unload -> ensureChunk -> applyOverrides', () => {
    const world = newWorld();
    const { tileX, tileY } = features.clear;
    const cx = tileToChunk(tileX);
    const cy = tileToChunk(tileY);
    const key = chunkKey(cx, cy);
    const index = chunkTileIndex(tileX, tileY);

    world.ensureChunk(cx, cy);
    const generated = world.getTile(tileX, tileY);
    expect(generated).not.toBe(Tile.FarmlandWet);

    world.setTile(tileX, tileY, Tile.FarmlandWet);
    expect(world.getTile(tileX, tileY)).toBe(Tile.FarmlandWet);
    // The array the replication path ships is patched too, not just the query.
    expect(world.ensureChunk(cx, cy).tiles[index]).toBe(Tile.FarmlandWet);

    const saved = world.getOverrides(cx, cy);
    expect(saved).toEqual([{ index, tile: Tile.FarmlandWet }]);

    // Reload inside one session: the overrides are the caller's to persist, so the world
    // keeps them and replays them on the next load.
    world.unloadChunk(key);
    world.ensureChunk(cx, cy);
    expect(world.getTile(tileX, tileY)).toBe(Tile.FarmlandWet);

    // Reload from disk into a fresh service: only the saved list carries the change.
    const reloaded = newWorld();
    reloaded.ensureChunk(cx, cy);
    expect(reloaded.getTile(tileX, tileY)).toBe(generated);
    reloaded.applyOverrides(cx, cy, saved);
    expect(reloaded.getTile(tileX, tileY)).toBe(Tile.FarmlandWet);
    expect(reloaded.getOverrides(cx, cy)).toEqual(saved);
    expect(reloaded.ensureChunk(cx, cy).tiles[index]).toBe(Tile.FarmlandWet);
  });

  it('reverts a tile that dropped out of the override list', () => {
    const world = newWorld();
    const { tileX, tileY } = features.clear;
    const cx = tileToChunk(tileX);
    const cy = tileToChunk(tileY);
    world.ensureChunk(cx, cy);
    const generated = world.getTile(tileX, tileY);

    world.setTile(tileX, tileY, Tile.FarmlandDry);
    world.applyOverrides(cx, cy, []);
    expect(world.getTile(tileX, tileY)).toBe(generated);
    expect(world.getOverrides(cx, cy)).toEqual([]);
    expect(world.isSolidTile(tileX, tileY)).toBe(false);

    // Setting a tile back to what the generator produced is not a change worth saving.
    world.setTile(tileX, tileY, Tile.FarmlandDry);
    world.setTile(tileX, tileY, generated);
    expect(world.getOverrides(cx, cy)).toEqual([]);
    expect(world.getTile(tileX, tileY)).toBe(generated);
  });

  it('records overrides for a chunk nobody loaded and replays them on load', () => {
    const world = newWorld();
    const { tileX, tileY } = features.clear;
    const cx = tileToChunk(tileX);
    const cy = tileToChunk(tileY);
    // No ensureChunk: the tile layer has to work ahead of the collision layer, because a
    // command can legitimately land on a chunk that has not streamed in yet.
    world.setTile(tileX, tileY, Tile.FarmlandDry);
    expect(world.isChunkLoaded(chunkKey(cx, cy))).toBe(false);
    expect(world.getTile(tileX, tileY)).toBe(Tile.FarmlandDry);

    world.ensureChunk(cx, cy);
    expect(world.getTile(tileX, tileY)).toBe(Tile.FarmlandDry);
    expect(world.getOverrides(cx, cy)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Collision
// ---------------------------------------------------------------------------

describe('createWorld collision', () => {
  it('updates solidity from a tile override', () => {
    const world = newWorld();
    const { tileX, tileY } = features.clear;
    ensureAround(world, tileX, tileY);
    expect(world.isSolidTile(tileX, tileY)).toBe(false);
    expect(world.isOpaqueTile(tileX, tileY)).toBe(false);

    world.setTile(tileX, tileY, Tile.WallConcrete);
    expect(world.isSolidTile(tileX, tileY)).toBe(true);
    expect(world.isOpaqueTile(tileX, tileY)).toBe(true);
    expect(world.getCollision(tileX, tileY) & CollisionFlag.TerrainSolid).not.toBe(0);
    expect(world.circleBlocked(tileCenter(tileX), tileCenter(tileY), 10)).toBe(true);

    world.setTile(tileX, tileY, Tile.WaterDeep);
    const flags = world.getCollision(tileX, tileY);
    expect(flags & CollisionFlag.TerrainSolid).toBe(0);
    expect(flags & CollisionFlag.Deep).not.toBe(0);
    expect(world.speedAt(tileCenter(tileX), tileCenter(tileY))).toBe(
      tileProps(Tile.WaterDeep).speed,
    );
  });

  it('keeps terrain and structure collision bits independent in both directions', () => {
    const world = newWorld();
    const structure = CollisionFlag.StructureSolid | CollisionFlag.StructureOpaque;

    // A structure on open ground, then removed again.
    const open = features.clear;
    ensureAround(world, open.tileX, open.tileY);
    world.addCollision(open.tileX, open.tileY, structure | CollisionFlag.Door);
    expect(world.isSolidTile(open.tileX, open.tileY)).toBe(true);
    // Retiling the ground under a wall must not knock the wall down.
    world.setTile(open.tileX, open.tileY, Tile.FloorWood);
    const flags = world.getCollision(open.tileX, open.tileY);
    expect(flags & CollisionFlag.StructureSolid).not.toBe(0);
    expect(flags & CollisionFlag.Door).not.toBe(0);
    expect(flags & CollisionFlag.TerrainSolid).toBe(0);
    world.removeCollision(open.tileX, open.tileY, structure | CollisionFlag.Door);
    expect(world.getCollision(open.tileX, open.tileY)).toBe(CollisionFlag.None);
    expect(world.isSolidTile(open.tileX, open.tileY)).toBe(false);

    // A structure on top of generated rock: taking it away must not clear the rock.
    const rock = features.slide;
    ensureAround(world, rock.tileX, rock.tileY);
    const terrainFlags = world.getCollision(rock.tileX, rock.tileY);
    expect(terrainFlags & CollisionFlag.TerrainSolid).not.toBe(0);
    world.addCollision(rock.tileX, rock.tileY, structure);
    world.removeCollision(rock.tileX, rock.tileY, structure);
    expect(world.getCollision(rock.tileX, rock.tileY)).toBe(terrainFlags);
    expect(world.isSolidTile(rock.tileX, rock.tileY)).toBe(true);
  });

  it('slides along a generated wall instead of sticking to it', () => {
    const world = newWorld();
    const { tileX, tileY } = features.slide;
    ensureAround(world, tileX, tileY);

    const radius = 10;
    const startX = tileCenter(tileX - 1);
    const startY = tileCenter(tileY);
    expect(world.circleBlocked(startX, startY, radius)).toBe(false);

    // Pressing diagonally into the wall: X is refused, Y still advances.
    const moved = world.moveCircle(startX, startY, 8, 8, radius);
    expect(moved.blockedX).toBe(true);
    expect(moved.x).toBe(startX);
    expect(moved.blockedY).toBe(false);
    expect(moved.y).toBeGreaterThan(startY);
    expect(world.circleBlocked(moved.x, moved.y, radius)).toBe(false);
  });

  it('sees through a generated window but not through a generated wall', () => {
    const world = newWorld();
    const glass = features.window;
    const brick = features.wall;
    ensureAround(world, glass.tileX, glass.tileY);
    ensureAround(world, brick.tileX, brick.tileY);

    expect(world.getTile(glass.tileX, glass.tileY)).toBe(Tile.WindowStatic);
    const glassY = tileCenter(glass.tileY);
    const westOfGlass = tileCenter(glass.tileX - 1);
    const eastOfGlass = tileCenter(glass.tileX + 1);
    expect(world.hasLineOfSight(westOfGlass, glassY, eastOfGlass, glassY)).toBe(true);
    // Transparent, but a bullet still stops in the frame.
    const hit = world.raycast(westOfGlass, glassY, eastOfGlass, glassY);
    expect(hit).not.toBeNull();
    expect(hit?.tileX).toBe(glass.tileX);
    expect((hit?.flags ?? 0) & CollisionFlag.TerrainSolid).not.toBe(0);

    const brickY = tileCenter(brick.tileY);
    expect(
      world.hasLineOfSight(
        tileCenter(brick.tileX - 1),
        brickY,
        tileCenter(brick.tileX + 1),
        brickY,
      ),
    ).toBe(false);
  });

  it('never ends a 2000 px walk inside a solid tile', () => {
    const world = newWorld();
    const { tileX, tileY } = features.clear;
    // Three chunks of margin: 2000 px is a bit under two chunks, so every tile the walk
    // can reach is really in the collision grid rather than reading as unseeded space.
    ensureAround(world, tileX, tileY, 3);

    const radius = 11;
    const step = 6; // one tick of a walking player at 120 px/s and 20 Hz
    const directions: Array<[number, number]> = [
      [1, 0],
      [0, 1],
      [-1, 0],
      [0, -1],
      [Math.SQRT1_2, Math.SQRT1_2],
      [-Math.SQRT1_2, Math.SQRT1_2],
    ];

    for (const [dirX, dirY] of directions) {
      let x = tileCenter(tileX);
      let y = tileCenter(tileY);
      expect(world.circleBlocked(x, y, radius)).toBe(false);
      let travelled = 0;
      while (travelled < 2000) {
        const moved = world.moveCircle(x, y, dirX * step, dirY * step, radius);
        x = moved.x;
        y = moved.y;
        travelled += step;
        // The invariant that matters: a swept move never leaves the mover embedded in
        // geometry, however fast it was going or whatever it walked into.
        expect(world.circleBlocked(x, y, radius)).toBe(false);
        expect(world.isSolidAt(x, y)).toBe(false);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

describe('createWorld navigation', () => {
  it('routes around a generated wall rather than through it', () => {
    const world = newWorld();
    const { tileX, tileY } = features.crossing;
    ensureAround(world, tileX, tileY, 2);

    const fromX = tileCenter(tileX - 1);
    const fromY = tileCenter(tileY);
    const toX = tileCenter(tileX + 1);
    const toY = tileCenter(tileY);

    // The straight line really is blocked, so any route at all is a detour.
    expect(world.raycast(fromX, fromY, toX, toY)).not.toBeNull();

    const path = world.findPath(fromX, fromY, toX, toY);
    expect(path.length).toBeGreaterThan(0);
    expect(path.slice(0, 2)).toEqual([tileX - 1, tileY]);
    expect(path.slice(-2)).toEqual([tileX + 1, tileY]);
    // Two tiles apart in a straight line would be three waypoints; going around is longer.
    expect(path.length / 2).toBeGreaterThan(3);
    for (let i = 0; i < path.length; i += 2) {
      const waypointX = path[i] as number;
      const waypointY = path[i + 1] as number;
      expect(world.isSolidTile(waypointX, waypointY)).toBe(false);
      expect(waypointX === tileX && waypointY === tileY).toBe(false);
    }
  });

  it('swims across deep water instead of routing around it', () => {
    // Deep water is passable - entities swim, and the speed penalty is the movement
    // system's business (spec section 12). Asserted so the choice cannot drift silently.
    const world = newWorld();
    const { tileX, tileY } = features.deep;
    ensureAround(world, tileX, tileY);
    expect(world.getCollision(tileX, tileY) & CollisionFlag.Deep).not.toBe(0);
    expect(world.getCollision(tileX, tileY) & SOLID_MASK).toBe(0);

    const path = world.findPath(
      tileCenter(tileX - 2),
      tileCenter(tileY),
      tileCenter(tileX + 2),
      tileCenter(tileY),
    );
    expect(path.length / 2).toBe(5);
    expect(path.slice(4, 6)).toEqual([tileX, tileY]);
  });

  it('returns an empty path when the goal cannot be reached', () => {
    const world = newWorld();
    const { tileX, tileY } = features.clear;
    ensureAround(world, tileX, tileY);

    // Seal one tile off completely. Built with setTile so it goes through the real
    // override path, collision bits included.
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        world.setTile(tileX + dx, tileY + dy, Tile.WallConcrete);
      }
    }
    expect(world.isSolidTile(tileX, tileY)).toBe(false);

    const outsideX = tileCenter(tileX + 6);
    const outsideY = tileCenter(tileY + 6);
    // Into the pocket...
    expect(world.findPath(outsideX, outsideY, tileCenter(tileX), tileCenter(tileY))).toEqual([]);
    // ...and out of it.
    expect(world.findPath(tileCenter(tileX), tileCenter(tileY), outsideX, outsideY)).toEqual([]);
  });

  it('shares a flow field for one goal and rebuilds it after pruning', () => {
    const world = newWorld();
    const { tileX, tileY } = features.clear;
    ensureAround(world, tileX, tileY, 2);
    const goalX = tileCenter(tileX);
    const goalY = tileCenter(tileY);

    const first = world.getFlowField(goalX, goalY, 0);
    expect(first).not.toBeNull();
    // Every follower of the same target integrates the field once, not once each.
    expect(world.getFlowField(goalX, goalY, 0)).toBe(first);
    expect(world.getFlowField(goalX + 4, goalY - 4, 3)).toBe(first);
    expect(world.getFlowField(goalX, goalY, DEFAULT_FLOW_FIELD_MAX_AGE_TICKS - 1)).toBe(first);

    // Past the staleness window it is rebuilt even without an explicit prune.
    const refreshed = world.getFlowField(goalX, goalY, DEFAULT_FLOW_FIELD_MAX_AGE_TICKS);
    expect(refreshed).not.toBe(first);

    world.pruneFlowFields(1000, 100);
    const rebuilt = world.getFlowField(goalX, goalY, 1000);
    expect(rebuilt).not.toBe(refreshed);
    expect(rebuilt?.builtTick).toBe(1000);

    // The field actually points home: from four tiles east of the goal, walk west.
    const direction = rebuilt && world.sampleFlow(rebuilt, goalX + 4 * TILE_SIZE, goalY);
    expect(direction).not.toBeNull();
    expect(direction?.x).toBeLessThan(0);
  });
});

// ---------------------------------------------------------------------------
// Spawning
// ---------------------------------------------------------------------------

/** Small LCG: the tests must not reach for `Math.random` either. */
function makeRoll(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

describe('createWorld findSpawnPosition', () => {
  it('never returns a blocked or deep-water position', () => {
    const world = newWorld();
    const { tileX, tileY } = features.clear;
    // A wide radius over a town: the candidates land on roads, in buildings and in water.
    ensureAround(world, tileX, tileY, 3);

    let found = 0;
    const roll = makeRoll(7);
    for (let trial = 0; trial < 200; trial++) {
      const position = world.findSpawnPosition(
        tileCenter(tileX),
        tileCenter(tileY),
        CHUNK_SIZE,
        12,
        roll,
        24,
      );
      if (position === null) continue;
      found++;
      expect(world.circleBlocked(position.x, position.y, 12)).toBe(false);
      expect(world.isSolidAt(position.x, position.y)).toBe(false);
      expect(tileProps(world.getTileAt(position.x, position.y)).deep).toBe(false);
      expect(
        world.getCollision(pixelToTile(position.x), pixelToTile(position.y)) & CollisionFlag.Deep,
      ).toBe(0);
    }
    expect(found).toBeGreaterThan(150);
  });

  it('is deterministic for a deterministic roll', () => {
    const world = newWorld();
    const { tileX, tileY } = features.clear;
    ensureAround(world, tileX, tileY, 2);
    const centreX = tileCenter(tileX);
    const centreY = tileCenter(tileY);

    const first: Array<{ x: number; y: number } | null> = [];
    const rollA = makeRoll(20260824);
    for (let i = 0; i < 20; i++) {
      first.push(world.findSpawnPosition(centreX, centreY, 512, 10, rollA, 16));
    }
    const rollB = makeRoll(20260824);
    const second: Array<{ x: number; y: number } | null> = [];
    for (let i = 0; i < 20; i++) {
      second.push(world.findSpawnPosition(centreX, centreY, 512, 10, rollB, 16));
    }
    expect(second).toEqual(first);
    expect(first.some((entry) => entry !== null)).toBe(true);

    // A fresh service with the same seed answers identically, which is what makes a
    // spawn reproducible from a save.
    const reloaded = newWorld();
    ensureAround(reloaded, tileX, tileY, 2);
    const rollC = makeRoll(20260824);
    const third: Array<{ x: number; y: number } | null> = [];
    for (let i = 0; i < 20; i++) {
      third.push(reloaded.findSpawnPosition(centreX, centreY, 512, 10, rollC, 16));
    }
    expect(third).toEqual(first);
  });

  it('gives up inside its attempt budget', () => {
    const world = newWorld();
    const { tileX, tileY } = features.deep;
    ensureAround(world, tileX, tileY);
    // Every candidate inside one tile of the middle of a lake is deep water.
    let calls = 0;
    const roll = () => {
      calls++;
      return 0.5;
    };
    expect(
      world.findSpawnPosition(tileCenter(tileX), tileCenter(tileY), TILE_SIZE, 10, roll, 9),
    ).toBeNull();
    expect(calls).toBe(18);
    expect(
      world.findSpawnPosition(tileCenter(tileX), tileCenter(tileY), TILE_SIZE, 10, roll, 0),
    ).toBeNull();
    expect(calls).toBe(18);
  });
});
