import { describe, expect, it } from 'vitest';
import { CHUNK_TILE_COUNT, TILE_SIZE, Tile, tileCenter } from '@survive/protocol';
import { createCollisionGrid } from './collision';
import { hasLineOfSight, raycast } from './raycast';
import { CollisionFlag } from './types';

function grassGrid() {
  const grid = createCollisionGrid();
  grid.seedChunk(0, 0, new Array<number>(CHUNK_TILE_COUNT).fill(Tile.Grass));
  return grid;
}

function wallColumn(tileX: number) {
  const grid = grassGrid();
  for (let tileY = 0; tileY < 32; tileY++) grid.setTerrain(tileX, tileY, Tile.WallBrick);
  return grid;
}

function wallRow(tileY: number) {
  const grid = grassGrid();
  for (let tileX = 0; tileX < 32; tileX++) grid.setTerrain(tileX, tileY, Tile.WallBrick);
  return grid;
}

describe('raycast traversal', () => {
  it('stops on the near face of an axis-aligned wall', () => {
    const grid = wallColumn(5);
    const hit = raycast(grid, 100, tileCenter(3), 400, tileCenter(3));
    expect(hit).not.toBeNull();
    expect(hit?.tileX).toBe(5);
    expect(hit?.tileY).toBe(3);
    expect(hit?.x).toBeCloseTo(160, 6);
    expect(hit?.y).toBeCloseTo(tileCenter(3), 6);
    expect(hit?.distance).toBeCloseTo(60, 6);
    expect((hit?.flags ?? 0) & CollisionFlag.TerrainSolid).not.toBe(0);
  });

  it('does not divide by zero on a perfectly vertical ray', () => {
    const grid = wallRow(7);
    const hit = raycast(grid, tileCenter(3), 100, tileCenter(3), 400);
    expect(hit).not.toBeNull();
    expect(hit?.tileY).toBe(7);
    expect(hit?.tileX).toBe(3);
    expect(hit?.y).toBeCloseTo(224, 6);
    expect(Number.isFinite(hit?.distance ?? Number.NaN)).toBe(true);
  });

  it('walks backwards along both axes', () => {
    const grid = wallColumn(5);
    const hit = raycast(grid, 400, tileCenter(3), 100, tileCenter(3));
    expect(hit?.tileX).toBe(5);
    expect(hit?.x).toBeCloseTo(192, 6);
    expect(hit?.distance).toBeCloseTo(208, 6);
  });

  it('returns null when the ray ends short of the wall', () => {
    const grid = wallColumn(5);
    expect(raycast(grid, 100, tileCenter(3), 150, tileCenter(3))).toBeNull();
  });

  it('returns null for a zero-length ray in open ground', () => {
    const grid = grassGrid();
    expect(raycast(grid, 100, 100, 100, 100)).toBeNull();
  });

  it('reports an immediate hit for a ray starting inside a solid tile', () => {
    const grid = grassGrid();
    grid.setTerrain(4, 4, Tile.WallBrick);
    const hit = raycast(grid, tileCenter(4), tileCenter(4), 400, 400);
    expect(hit?.distance).toBe(0);
    expect(hit?.tileX).toBe(4);
    expect(hit?.tileY).toBe(4);
    expect(hit?.x).toBe(tileCenter(4));

    const zeroLength = raycast(grid, tileCenter(4), tileCenter(4), tileCenter(4), tileCenter(4));
    expect(zeroLength?.distance).toBe(0);
  });

  it('crosses tiles diagonally without skipping the wall it passes through', () => {
    const grid = wallColumn(5);
    const hit = raycast(grid, tileCenter(1), tileCenter(1), tileCenter(9), tileCenter(9));
    expect(hit).not.toBeNull();
    expect(hit?.tileX).toBe(5);
    // 45 degrees, so the impact lands on the wall's left face at the same y.
    expect(hit?.x).toBeCloseTo(160, 6);
    expect(hit?.y).toBeCloseTo(160, 6);
    expect(hit?.distance).toBeCloseTo(Math.hypot(160 - tileCenter(1), 160 - tileCenter(1)), 6);
  });

  it('cannot slip diagonally between two tiles that touch at a corner', () => {
    const grid = grassGrid();
    grid.setTerrain(5, 4, Tile.WallBrick);
    grid.setTerrain(4, 5, Tile.WallBrick);
    // Exactly through the lattice corner at (160, 160), the classic DDA tie case.
    const hit = raycast(grid, tileCenter(4), tileCenter(4), tileCenter(5), tileCenter(5));
    expect(hit).not.toBeNull();
    expect(hit?.distance).toBeCloseTo(Math.hypot(16, 16), 6);
  });

  it('cannot slip through the joint of a diagonal wall', () => {
    const grid = grassGrid();
    // A diagonal wall: consecutive tiles only touch at their corners, and the ray below
    // aims straight through one of those corners from one free tile to the other.
    for (let i = 0; i < 6; i++) grid.setTerrain(4 + i, 4 + i, Tile.WallBrick);
    const hit = raycast(grid, tileCenter(5), tileCenter(4), tileCenter(4), tileCenter(5));
    expect(hit).not.toBeNull();
    expect(hit?.tileX === hit?.tileY).toBe(true);
  });

  it('crosses a diagonal wall head-on', () => {
    const grid = grassGrid();
    for (let i = 0; i < 6; i++) grid.setTerrain(4 + i, 4 + i, Tile.WallBrick);
    expect(
      raycast(grid, tileCenter(8), tileCenter(2), tileCenter(2), tileCenter(8)),
    ).not.toBeNull();
  });

  it('never reports a hit further away than the ray is long', () => {
    const grid = wallColumn(5);
    for (let offset = 0; offset < TILE_SIZE; offset += 3) {
      const hit = raycast(grid, 100, 100 + offset, 400, 400 - offset);
      const length = Math.hypot(300, 300 - offset * 2);
      expect(hit?.distance ?? 0).toBeLessThanOrEqual(length + 1e-9);
    }
  });

  it('is a pure function of the grid', () => {
    const grid = wallColumn(5);
    expect(raycast(grid, 33, 77, 401, 233)).toEqual(raycast(grid, 33, 77, 401, 233));
  });
});

describe('line of sight versus movement blocking', () => {
  it('lets you see through a window you cannot walk through', () => {
    const grid = grassGrid();
    grid.setTerrain(5, 3, Tile.WindowStatic);
    expect(raycast(grid, 100, tileCenter(3), 400, tileCenter(3))).not.toBeNull();
    expect(hasLineOfSight(grid, 100, tileCenter(3), 400, tileCenter(3))).toBe(true);
  });

  it('lets you see over a fence structure', () => {
    const grid = grassGrid();
    grid.add(5, 3, CollisionFlag.StructureSolid);
    expect(raycast(grid, 100, tileCenter(3), 400, tileCenter(3))?.tileX).toBe(5);
    expect(hasLineOfSight(grid, 100, tileCenter(3), 400, tileCenter(3))).toBe(true);
  });

  it('blocks sight but not movement through something opaque and passable', () => {
    const grid = grassGrid();
    grid.add(5, 3, CollisionFlag.StructureOpaque);
    expect(raycast(grid, 100, tileCenter(3), 400, tileCenter(3))).toBeNull();
    expect(hasLineOfSight(grid, 100, tileCenter(3), 400, tileCenter(3))).toBe(false);
  });

  it('blocks both through a brick wall', () => {
    const grid = wallColumn(5);
    expect(raycast(grid, 100, tileCenter(3), 400, tileCenter(3))).not.toBeNull();
    expect(hasLineOfSight(grid, 100, tileCenter(3), 400, tileCenter(3))).toBe(false);
  });

  it('sees across open ground and out of the loaded area', () => {
    const grid = grassGrid();
    expect(hasLineOfSight(grid, 100, 100, 400, 400)).toBe(true);
    expect(hasLineOfSight(grid, 100, 100, 100_000, 100_000)).toBe(true);
  });

  it('closes sight when a door closes and opens it again', () => {
    const grid = grassGrid();
    const from = { x: 100, y: tileCenter(3) };
    const to = { x: 400, y: tileCenter(3) };
    grid.add(
      5,
      3,
      CollisionFlag.Door | CollisionFlag.StructureSolid | CollisionFlag.StructureOpaque,
    );
    expect(hasLineOfSight(grid, from.x, from.y, to.x, to.y)).toBe(false);
    grid.remove(5, 3, CollisionFlag.StructureSolid | CollisionFlag.StructureOpaque);
    expect(hasLineOfSight(grid, from.x, from.y, to.x, to.y)).toBe(true);
    expect(raycast(grid, from.x, from.y, to.x, to.y)).toBeNull();
    expect(grid.get(5, 3) & CollisionFlag.Door).not.toBe(0);
  });

  it('ignores non-finite endpoints', () => {
    const grid = wallColumn(5);
    expect(raycast(grid, Number.NaN, 0, 400, 400)).toBeNull();
    expect(hasLineOfSight(grid, 0, 0, Number.POSITIVE_INFINITY, 0)).toBe(true);
  });
});
