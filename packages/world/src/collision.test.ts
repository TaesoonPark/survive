import { describe, expect, it } from 'vitest';
import { CHUNK_TILE_COUNT, TILE_SIZE, Tile, tileCenter } from '@survive/protocol';
import { TERRAIN_MASK, createCollisionGrid, terrainCollisionFlags } from './collision';
import { CollisionFlag, OPAQUE_MASK, SOLID_MASK } from './types';

function chunkOf(tile: number): number[] {
  return new Array<number>(CHUNK_TILE_COUNT).fill(tile);
}

function grassGrid(chunksX = 1, chunksY = 1) {
  const grid = createCollisionGrid();
  for (let cy = 0; cy < chunksY; cy++) {
    for (let cx = 0; cx < chunksX; cx++) grid.seedChunk(cx, cy, chunkOf(Tile.Grass));
  }
  return grid;
}

describe('every flag fits the store', () => {
  /*
   * This is the test that was missing, and its absence cost real time.
   *
   * `CollisionFlag` held exactly eight bits and the store was a `Uint8Array`. Adding a
   * ninth flag truncated it to zero on the way in - silently. Nothing failed: the whole
   * simulation suite runs against `createFlatWorld`, whose store is a plain array, so the
   * bit survived there and every test passed while the shipping grid dropped it. The
   * consequence would have been trees that no longer block sight at all.
   *
   * So the invariant is asserted directly against the real grid, for every flag there is.
   */
  it('round-trips every CollisionFlag through the real grid', () => {
    for (const [name, flag] of Object.entries(CollisionFlag)) {
      if (flag === 0) continue;
      const grid = grassGrid();
      grid.add(3, 3, flag);
      const stored = grid.get(3, 3);
      expect(stored & flag, `${name} (${flag}) did not survive storage`).toBe(flag);
    }
  });

  it('round-trips every flag at once', () => {
    const all = Object.values(CollisionFlag).reduce<number>((mask, flag) => mask | flag, 0);
    const grid = grassGrid();
    grid.add(4, 4, all);
    expect(grid.get(4, 4) & all).toBe(all);
  });
});

describe('collision grid storage', () => {
  it('derives terrain bits from tile properties when a chunk is seeded', () => {
    const grid = createCollisionGrid();
    grid.seedChunk(0, 0, chunkOf(Tile.WallBrick));
    expect(grid.isSolid(4, 7)).toBe(true);
    expect(grid.isOpaque(4, 7)).toBe(true);
    expect(grid.get(4, 7) & CollisionFlag.TerrainSolid).not.toBe(0);
    expect(grid.get(4, 7) & CollisionFlag.StructureSolid).toBe(0);
  });

  it('marks deep water as deep but not solid or opaque', () => {
    const grid = createCollisionGrid();
    grid.seedChunk(0, 0, chunkOf(Tile.WaterDeep));
    expect(grid.get(1, 1) & CollisionFlag.Deep).not.toBe(0);
    expect(grid.isSolid(1, 1)).toBe(false);
    expect(grid.isOpaque(1, 1)).toBe(false);
  });

  it('treats a window as solid but transparent', () => {
    expect(terrainCollisionFlags(Tile.WindowStatic) & CollisionFlag.TerrainSolid).not.toBe(0);
    expect(terrainCollisionFlags(Tile.WindowStatic) & CollisionFlag.TerrainOpaque).toBe(0);
  });

  it('reads unseeded chunks as open instead of throwing', () => {
    const grid = grassGrid();
    expect(() => grid.get(9000, -9000)).not.toThrow();
    expect(grid.get(9000, -9000)).toBe(CollisionFlag.None);
    expect(grid.isSolid(9000, -9000)).toBe(false);
    expect(grid.isOpaque(9000, -9000)).toBe(false);
    expect(grid.circleBlocked(-4000, -4000, 12)).toBe(false);
  });

  it('drops writes outside loaded chunks', () => {
    const grid = grassGrid();
    grid.add(9000, 9000, CollisionFlag.StructureSolid);
    expect(grid.get(9000, 9000)).toBe(CollisionFlag.None);
    expect(grid.chunkCount).toBe(1);
  });

  it('tracks and clears chunks', () => {
    const grid = grassGrid(2, 2);
    expect(grid.chunkCount).toBe(4);
    expect(grid.hasChunk(1, 1)).toBe(true);
    grid.seedChunk(1, 1, chunkOf(Tile.WallBrick));
    expect(grid.isSolid(40, 40)).toBe(true);
    grid.clearChunk(1, 1);
    expect(grid.hasChunk(1, 1)).toBe(false);
    expect(grid.isSolid(40, 40)).toBe(false);
    expect(grid.chunkCount).toBe(3);
  });

  it('rejects a chunk of the wrong size rather than half-seeding it', () => {
    const grid = createCollisionGrid();
    expect(() => grid.seedChunk(0, 0, [Tile.Grass, Tile.Grass])).toThrow();
  });

  it('produces identical bits regardless of the order chunks are seeded', () => {
    const forwards = createCollisionGrid();
    const backwards = createCollisionGrid();
    const tiles = [Tile.Grass, Tile.WallBrick, Tile.WaterDeep, Tile.WindowStatic];
    const chunkFor = (cx: number, cy: number) =>
      Array.from(
        { length: CHUNK_TILE_COUNT },
        (_unused, i) => tiles[(i + cx * 3 + cy * 7) % tiles.length] ?? Tile.Grass,
      );
    for (let i = 0; i < 4; i++)
      forwards.seedChunk(i % 2, (i / 2) | 0, chunkFor(i % 2, (i / 2) | 0));
    for (let i = 3; i >= 0; i--)
      backwards.seedChunk(i % 2, (i / 2) | 0, chunkFor(i % 2, (i / 2) | 0));
    for (let tileY = 0; tileY < 64; tileY += 3) {
      for (let tileX = 0; tileX < 64; tileX += 3) {
        expect(forwards.get(tileX, tileY)).toBe(backwards.get(tileX, tileY));
      }
    }
  });

  it('resets structure bits when a chunk is regenerated', () => {
    const grid = grassGrid();
    grid.add(2, 2, CollisionFlag.StructureSolid | CollisionFlag.Door);
    grid.seedChunk(0, 0, chunkOf(Tile.Grass));
    expect(grid.get(2, 2)).toBe(CollisionFlag.None);
  });
});

describe('terrain and structure bits are independent', () => {
  it('keeps a structure solid when the terrain under it changes', () => {
    const grid = grassGrid();
    grid.add(3, 3, CollisionFlag.StructureSolid | CollisionFlag.StructureOpaque);
    expect(grid.isSolid(3, 3)).toBe(true);

    grid.setTerrain(3, 3, Tile.WallBrick);
    expect(grid.get(3, 3) & TERRAIN_MASK).toBe(
      CollisionFlag.TerrainSolid | CollisionFlag.TerrainOpaque,
    );
    expect(grid.get(3, 3) & CollisionFlag.StructureSolid).not.toBe(0);

    grid.setTerrain(3, 3, Tile.Grass);
    expect(grid.get(3, 3) & TERRAIN_MASK).toBe(0);
    expect(grid.isSolid(3, 3)).toBe(true);
    expect(grid.isOpaque(3, 3)).toBe(true);
  });

  it('keeps terrain solid when a structure is destroyed on top of it', () => {
    const grid = grassGrid();
    grid.setTerrain(4, 4, Tile.Cliff);
    grid.add(4, 4, CollisionFlag.StructureSolid);
    grid.remove(4, 4, CollisionFlag.StructureSolid | CollisionFlag.StructureOpaque);
    expect(grid.isSolid(4, 4)).toBe(true);
    expect(grid.isOpaque(4, 4)).toBe(true);
    expect(grid.get(4, 4) & CollisionFlag.StructureSolid).toBe(0);
  });

  it('clears a tile completely when both layers are removed', () => {
    const grid = grassGrid();
    grid.setTerrain(5, 5, Tile.WallBrick);
    grid.add(5, 5, CollisionFlag.NodeSolid);
    grid.remove(5, 5, CollisionFlag.NodeSolid);
    grid.setTerrain(5, 5, Tile.Dirt);
    expect(grid.get(5, 5)).toBe(CollisionFlag.None);
    expect(grid.isSolid(5, 5)).toBe(false);
  });

  it('separates the solid and opaque masks', () => {
    const grid = grassGrid();
    grid.add(6, 6, CollisionFlag.StructureOpaque);
    expect(grid.get(6, 6) & SOLID_MASK).toBe(0);
    expect(grid.get(6, 6) & OPAQUE_MASK).not.toBe(0);
    expect(grid.isSolid(6, 6)).toBe(false);
    expect(grid.isOpaque(6, 6)).toBe(true);
  });
});

describe('circleBlocked', () => {
  it('uses an exact circle test, not the tile bounding box', () => {
    const grid = grassGrid();
    grid.setTerrain(5, 5, Tile.WallBrick);
    // Diagonally off the tile's top-left corner: the tile ranges overlap on both axes, so
    // an AABB test would report a hit, but the corner is 8.49 px away.
    expect(grid.circleBlocked(160 - 6, 160 - 6, 8)).toBe(false);
    expect(grid.circleBlocked(160 - 5, 160 - 5, 8)).toBe(true);
  });

  it('reports overlap on the flat face of a wall', () => {
    const grid = grassGrid();
    grid.setTerrain(5, 5, Tile.WallBrick);
    expect(grid.circleBlocked(160 - 9, tileCenter(5), 8)).toBe(false);
    expect(grid.circleBlocked(160 - 7, tileCenter(5), 8)).toBe(true);
  });

  it('ignores deep water', () => {
    const grid = createCollisionGrid();
    grid.seedChunk(0, 0, chunkOf(Tile.WaterDeep));
    expect(grid.circleBlocked(tileCenter(5), tileCenter(5), 12)).toBe(false);
  });
});

describe('moveCircle', () => {
  /** Solid column at tile x = 5, spanning the whole seeded chunk. */
  function wallColumn(tileX: number) {
    const grid = grassGrid();
    for (let tileY = 0; tileY < 32; tileY++) grid.setTerrain(tileX, tileY, Tile.WallBrick);
    return grid;
  }

  it('slides along a wall instead of sticking in the corner', () => {
    const grid = wallColumn(5);
    const start = 150;
    const move = grid.moveCircle(start, 150, 6, 6, 8);
    expect(move.blockedX).toBe(true);
    expect(move.blockedY).toBe(false);
    expect(move.x).toBe(start);
    expect(move.y).toBeCloseTo(156, 6);
  });

  it('keeps sliding tick after tick once it is touching the wall', () => {
    const grid = wallColumn(5);
    let x = 152; // right edge exactly on the wall face: contact, not penetration
    let y = 100;
    for (let tick = 0; tick < 5; tick++) {
      const move = grid.moveCircle(x, y, 6, 6, 8);
      expect(move.blockedX).toBe(true);
      x = move.x;
      y = move.y;
    }
    expect(x).toBe(152);
    expect(y).toBeCloseTo(130, 6);
  });

  it('does not tunnel through a wall at sprint speed', () => {
    const grid = wallColumn(5);
    const move = grid.moveCircle(100, 150, 300, 0, 8);
    expect(move.blockedX).toBe(true);
    expect(move.x).toBeLessThanOrEqual(152);
  });

  it('does not tunnel a projectile-sized circle at projectile speed', () => {
    const grid = wallColumn(5);
    const move = grid.moveCircle(64, tileCenter(9), 2000, 0, 1);
    expect(move.blockedX).toBe(true);
    expect(move.x).toBeLessThan(160);
  });

  it('sub-steps diagonal motion instead of jumping over the wall', () => {
    const grid = wallColumn(5);
    const move = grid.moveCircle(tileCenter(3), tileCenter(3), 128, 128, 8);
    expect(move.blockedX).toBe(true);
    expect(move.x).toBeLessThanOrEqual(152);
    expect(move.y).toBeCloseTo(tileCenter(3) + 128, 6);
    expect(grid.circleBlocked(move.x, move.y, 8)).toBe(false);
  });

  it('keeps moving past a lone pillar instead of stopping dead', () => {
    const grid = grassGrid();
    grid.setTerrain(5, 5, Tile.WallBrick);
    const move = grid.moveCircle(tileCenter(3), tileCenter(3), 128, 128, 8);
    // Axis-separated resolution around a single tile slides on whichever axis is still
    // clear; the guarantees are that progress is made and that we never end up inside it.
    expect(grid.circleBlocked(move.x, move.y, 8)).toBe(false);
    expect(move.x + move.y).toBeGreaterThan(tileCenter(3) * 2 + 64);
  });

  it('moves freely when nothing is in the way', () => {
    const grid = grassGrid();
    const move = grid.moveCircle(100, 100, 40, -25, 8);
    expect(move.x).toBeCloseTo(140, 6);
    expect(move.y).toBeCloseTo(75, 6);
    expect(move.blockedX).toBe(false);
    expect(move.blockedY).toBe(false);
  });

  it('never reports a blocked axis it was not asked to move along', () => {
    const grid = wallColumn(5);
    const move = grid.moveCircle(150, 150, 0, 6, 8);
    expect(move.blockedX).toBe(false);
    expect(move.x).toBe(150);
    expect(move.y).toBeCloseTo(156, 6);
  });

  it('lets an entity walk out of geometry it is already inside', () => {
    const grid = grassGrid();
    for (let tileY = 4; tileY <= 6; tileY++) {
      for (let tileX = 4; tileX <= 6; tileX++) grid.setTerrain(tileX, tileY, Tile.WallBrick);
    }
    const move = grid.moveCircle(tileCenter(5), tileCenter(5), TILE_SIZE * 2, 0, 8);
    expect(move.x).toBeGreaterThan(tileCenter(5));
  });

  it('ignores non-finite motion', () => {
    const grid = grassGrid();
    const move = grid.moveCircle(100, 100, Number.NaN, 0, 8);
    expect(move).toEqual({ x: 100, y: 100, blockedX: false, blockedY: false });
  });

  it('ignores an infinite impulse rather than sub-stepping forever', () => {
    // The step count is derived from the distance asked for, so `Infinity / stepSize` is
    // an infinite loop, not a big number. This is not hypothetical: a bad knockback is
    // exactly how a non-finite delta reaches here.
    const grid = grassGrid();
    expect(grid.moveCircle(100, 100, 0, Number.POSITIVE_INFINITY, 8)).toEqual({
      x: 100,
      y: 100,
      blockedX: false,
      blockedY: false,
    });
  });

  it('returns promptly for an absurd but finite delta', () => {
    // Finite, so the non-finite guard does not catch it, and large enough that one
    // sub-step per half tile would be tens of millions of overlap tests. `MAX_SWEEP_
    // SUBSTEPS` is what keeps this a coarse move instead of a frozen tick.
    const grid = grassGrid();
    const move = grid.moveCircle(100, 100, 1e9, 0, 8);
    expect(Number.isFinite(move.x)).toBe(true);
    // It went *somewhere* - the cap makes the sweep coarse, not inert. Callers clamp the
    // result back into the world; see `clampIntoWorld`.
    expect(move.x).toBeGreaterThan(100);
  });

  it('is a pure function of position and grid state', () => {
    const grid = wallColumn(5);
    const a = grid.moveCircle(120, 120, 60, 17, 8);
    const b = grid.moveCircle(120, 120, 60, 17, 8);
    expect(a).toEqual(b);
  });
});
