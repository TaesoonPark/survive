import { describe, expect, it } from 'vitest';
import { CHUNK_TILE_COUNT, Tile, tileCenter } from '@survive/protocol';
import { createCollisionGrid } from './collision';
import type { CollisionGrid } from './collision';
import {
  DEFAULT_DOOR_COST,
  findNearestFreeTile,
  findPath,
  isWalkableLine,
  smoothPath,
} from './pathfinding';
import { CollisionFlag, SOLID_MASK } from './types';

/**
 * One grass chunk with a solid border, so a search cannot escape into the unloaded (and
 * therefore open) space around it. Interior tiles are 1..30.
 */
function arena(): CollisionGrid {
  const grid = createCollisionGrid();
  grid.seedChunk(0, 0, new Array<number>(CHUNK_TILE_COUNT).fill(Tile.Grass));
  for (let i = 0; i < 32; i++) {
    grid.setTerrain(i, 0, Tile.WallBrick);
    grid.setTerrain(i, 31, Tile.WallBrick);
    grid.setTerrain(0, i, Tile.WallBrick);
    grid.setTerrain(31, i, Tile.WallBrick);
  }
  return grid;
}

/** Solid column with a single gap, spanning the arena interior. */
function divide(grid: CollisionGrid, tileX: number, gapTileY: number): void {
  for (let tileY = 1; tileY <= 30; tileY++) {
    if (tileY !== gapTileY) grid.setTerrain(tileX, tileY, Tile.WallBrick);
  }
}

function pathFromTile(
  grid: CollisionGrid,
  fromTileX: number,
  fromTileY: number,
  toTileX: number,
  toTileY: number,
  options?: Parameters<typeof findPath>[5],
): number[] {
  return findPath(
    grid,
    tileCenter(fromTileX),
    tileCenter(fromTileY),
    tileCenter(toTileX),
    tileCenter(toTileY),
    options,
  );
}

function contains(path: readonly number[], tileX: number, tileY: number): boolean {
  for (let i = 0; i < path.length; i += 2) {
    if (path[i] === tileX && path[i + 1] === tileY) return true;
  }
  return false;
}

/** Every step is a real 8-way step, lands on an enterable tile, and cuts no corner. */
function expectValidPath(grid: CollisionGrid, path: readonly number[], doorCost = 0): void {
  expect(path.length % 2).toBe(0);
  expect(path.length).toBeGreaterThan(0);
  for (let i = 0; i < path.length; i += 2) {
    const tileX = path[i] as number;
    const tileY = path[i + 1] as number;
    const flags = grid.get(tileX, tileY);
    if ((flags & SOLID_MASK) !== 0) {
      expect(doorCost).toBeGreaterThan(0);
      expect(flags & CollisionFlag.Door).not.toBe(0);
    }
    if (i === 0) continue;
    const prevX = path[i - 2] as number;
    const prevY = path[i - 1] as number;
    const stepX = tileX - prevX;
    const stepY = tileY - prevY;
    expect(Math.abs(stepX)).toBeLessThanOrEqual(1);
    expect(Math.abs(stepY)).toBeLessThanOrEqual(1);
    expect(Math.abs(stepX) + Math.abs(stepY)).toBeGreaterThan(0);
    if (stepX !== 0 && stepY !== 0) {
      // No corner cutting: both shared orthogonals must be open.
      expect(grid.get(prevX + stepX, prevY) & SOLID_MASK).toBe(0);
      expect(grid.get(prevX, prevY + stepY) & SOLID_MASK).toBe(0);
    }
  }
}

describe('findPath', () => {
  it('routes around a wall through its only gap', () => {
    const grid = arena();
    divide(grid, 15, 25);
    const path = pathFromTile(grid, 3, 3, 28, 3);
    expectValidPath(grid, path);
    expect(path.slice(0, 2)).toEqual([3, 3]);
    expect(path.slice(-2)).toEqual([28, 3]);
    expect(contains(path, 15, 25)).toBe(true);
  });

  it('takes the shorter of two gaps', () => {
    const grid = arena();
    for (let tileY = 1; tileY <= 30; tileY++) {
      if (tileY !== 4 && tileY !== 28) grid.setTerrain(15, tileY, Tile.WallBrick);
    }
    const path = pathFromTile(grid, 3, 3, 28, 3);
    expect(contains(path, 15, 4)).toBe(true);
    expect(contains(path, 15, 28)).toBe(false);
  });

  it('returns an empty path when walled in', () => {
    const grid = arena();
    for (let tileY = 2; tileY <= 6; tileY++) {
      for (let tileX = 2; tileX <= 6; tileX++) {
        const onEdge = tileX === 2 || tileX === 6 || tileY === 2 || tileY === 6;
        if (onEdge) grid.setTerrain(tileX, tileY, Tile.WallBrick);
      }
    }
    expect(pathFromTile(grid, 4, 4, 20, 20)).toEqual([]);
  });

  it('returns a single waypoint when it is already there', () => {
    const grid = arena();
    expect(pathFromTile(grid, 7, 9, 7, 9)).toEqual([7, 9]);
  });

  it('gives up inside the node budget', () => {
    const grid = arena();
    divide(grid, 15, 25);
    expect(pathFromTile(grid, 3, 3, 28, 3, { maxNodes: 8 })).toEqual([]);
    expect(pathFromTile(grid, 3, 3, 28, 3, { maxNodes: 4096 }).length).toBeGreaterThan(0);
  });

  it('walks orthogonally only when diagonals are disallowed', () => {
    const grid = arena();
    const path = pathFromTile(grid, 3, 3, 8, 8, { allowDiagonal: false });
    expectValidPath(grid, path);
    for (let i = 2; i < path.length; i += 2) {
      const stepX = Math.abs((path[i] as number) - (path[i - 2] as number));
      const stepY = Math.abs((path[i + 1] as number) - (path[i - 1] as number));
      expect(stepX + stepY).toBe(1);
    }
    // 5 tiles across and 5 down: 10 steps plus the starting tile.
    expect(path.length / 2).toBe(11);
  });

  it('prefers the diagonal when diagonals are allowed', () => {
    const grid = arena();
    const path = pathFromTile(grid, 3, 3, 8, 8);
    expect(path.length / 2).toBe(6);
  });
});

describe('findPath corner rules', () => {
  it('never cuts the corner between two diagonally touching walls', () => {
    const grid = arena();
    grid.setTerrain(10, 9, Tile.WallBrick);
    grid.setTerrain(9, 10, Tile.WallBrick);
    const path = pathFromTile(grid, 9, 9, 10, 10);
    expectValidPath(grid, path);
    // The single diagonal step would squeeze between the two walls.
    expect(path.length / 2).toBeGreaterThan(2);
  });

  it('cannot pass a diagonal wall that only touches at the corners', () => {
    const grid = arena();
    for (let i = 0; i < 30; i++) {
      const tileX = 1 + i;
      const tileY = 30 - i;
      if (tileX <= 30 && tileY >= 1) grid.setTerrain(tileX, tileY, Tile.WallBrick);
    }
    expect(pathFromTile(grid, 3, 3, 28, 28)).toEqual([]);
  });

  it('keeps the corner rule when routing a long way round', () => {
    const grid = arena();
    divide(grid, 15, 25);
    for (let tileY = 5; tileY <= 20; tileY++) grid.setTerrain(8, tileY, Tile.WallBrick);
    const path = pathFromTile(grid, 3, 12, 28, 12);
    expectValidPath(grid, path);
  });
});

describe('findPath doors', () => {
  function withDoor(): CollisionGrid {
    const grid = arena();
    for (let tileY = 1; tileY <= 30; tileY++) grid.setTerrain(15, tileY, Tile.WallBrick);
    // Swap one wall tile for a closed door: no terrain solid, a structure one instead.
    grid.setTerrain(15, 15, Tile.Grass);
    grid.add(15, 15, CollisionFlag.Door | CollisionFlag.StructureSolid);
    return grid;
  }

  it('refuses a closed door by default', () => {
    expect(pathFromTile(withDoor(), 3, 15, 28, 15)).toEqual([]);
  });

  it('routes through a closed door when the caller pays for it', () => {
    const grid = withDoor();
    const path = pathFromTile(grid, 3, 15, 28, 15, { doorCost: DEFAULT_DOOR_COST });
    expectValidPath(grid, path, DEFAULT_DOOR_COST);
    expect(contains(path, 15, 15)).toBe(true);
    expect(path.slice(-2)).toEqual([28, 15]);
  });

  it('prefers an open gap over a door that costs more than the detour', () => {
    const grid = withDoor();
    grid.setTerrain(15, 18, Tile.Grass);
    const path = pathFromTile(grid, 3, 15, 28, 15, { doorCost: 40 });
    expect(contains(path, 15, 18)).toBe(true);
    expect(contains(path, 15, 15)).toBe(false);
  });

  it('does not treat a boarded-up door frame as a door', () => {
    const grid = arena();
    for (let tileY = 1; tileY <= 30; tileY++) grid.setTerrain(15, tileY, Tile.WallBrick);
    grid.add(15, 15, CollisionFlag.Door);
    expect(pathFromTile(grid, 3, 15, 28, 15, { doorCost: DEFAULT_DOOR_COST })).toEqual([]);
  });

  it('walks straight through an open door', () => {
    const grid = arena();
    for (let tileY = 1; tileY <= 30; tileY++) grid.setTerrain(15, tileY, Tile.WallBrick);
    grid.setTerrain(15, 15, Tile.Grass);
    grid.add(15, 15, CollisionFlag.Door);
    const path = pathFromTile(grid, 3, 15, 28, 15);
    expectValidPath(grid, path);
    expect(contains(path, 15, 15)).toBe(true);
  });
});

describe('findPath goal handling', () => {
  it('paths to the nearest free tile when the goal is inside a wall', () => {
    const grid = arena();
    for (let tileY = 19; tileY <= 21; tileY++) {
      for (let tileX = 19; tileX <= 21; tileX++) grid.setTerrain(tileX, tileY, Tile.WallBrick);
    }
    const path = pathFromTile(grid, 3, 3, 20, 20);
    expectValidPath(grid, path);
    const lastX = path[path.length - 2] as number;
    const lastY = path[path.length - 1] as number;
    expect(grid.isSolid(lastX, lastY)).toBe(false);
    expect(Math.max(Math.abs(lastX - 20), Math.abs(lastY - 20))).toBeLessThanOrEqual(2);
  });

  it('stops within the goal tolerance', () => {
    const grid = arena();
    const exact = pathFromTile(grid, 3, 3, 20, 3);
    const loose = pathFromTile(grid, 3, 3, 20, 3, { goalTolerance: 4 });
    expect(loose.length).toBeLessThan(exact.length);
    const lastX = loose[loose.length - 2] as number;
    const lastY = loose[loose.length - 1] as number;
    expect(Math.max(Math.abs(lastX - 20), Math.abs(lastY - 3))).toBeLessThanOrEqual(4);
  });

  it('rejects non-finite endpoints', () => {
    const grid = arena();
    expect(findPath(grid, Number.NaN, 0, 100, 100)).toEqual([]);
    expect(findPath(grid, 0, 0, 100, Number.POSITIVE_INFINITY)).toEqual([]);
  });

  it('returns identical paths for identical requests, whatever ran in between', () => {
    const grid = arena();
    divide(grid, 15, 25);
    const first = pathFromTile(grid, 3, 3, 28, 3);
    pathFromTile(grid, 28, 28, 2, 2);
    findPath(grid, 0, 0, 900, 900, { allowDiagonal: false, maxNodes: 64 });
    const second = pathFromTile(grid, 3, 3, 28, 3);
    expect(second).toEqual(first);
  });

  it('survives a search large enough to grow the workspace', () => {
    const grid = arena();
    const path = pathFromTile(grid, 1, 1, 30, 30, { maxNodes: 20_000 });
    expectValidPath(grid, path);
    expect(pathFromTile(grid, 1, 1, 30, 30, { maxNodes: 20_000 })).toEqual(path);
  });
});

describe('findNearestFreeTile', () => {
  it('returns the tile itself when it is already free', () => {
    const grid = arena();
    expect(findNearestFreeTile(grid, 5, 5, 3)).toEqual({ tileX: 5, tileY: 5 });
  });

  it('finds the closest free tile in an expanding ring', () => {
    const grid = arena();
    for (let tileY = 9; tileY <= 11; tileY++) {
      for (let tileX = 9; tileX <= 11; tileX++) grid.setTerrain(tileX, tileY, Tile.WallBrick);
    }
    const found = findNearestFreeTile(grid, 10, 10, 4);
    expect(found).not.toBeNull();
    expect(Math.max(Math.abs((found?.tileX ?? 0) - 10), Math.abs((found?.tileY ?? 0) - 10))).toBe(
      2,
    );
  });

  it('gives up outside its radius', () => {
    const grid = arena();
    for (let tileY = 5; tileY <= 25; tileY++) {
      for (let tileX = 5; tileX <= 25; tileX++) grid.setTerrain(tileX, tileY, Tile.WallBrick);
    }
    expect(findNearestFreeTile(grid, 15, 15, 3)).toBeNull();
  });
});

describe('smoothPath', () => {
  it('collapses a staircase across open ground to its endpoints', () => {
    const grid = arena();
    const zigzag = [3, 3, 4, 3, 4, 4, 5, 4, 5, 5, 6, 5, 6, 6, 7, 6, 7, 7];
    const smoothed = smoothPath(grid, zigzag, 8);
    expect(smoothed).toEqual([3, 3, 7, 7]);
  });

  it('keeps the endpoints and never lengthens the path', () => {
    const grid = arena();
    divide(grid, 15, 25);
    const path = pathFromTile(grid, 3, 3, 28, 3);
    const smoothed = smoothPath(grid, path, 8);
    expect(smoothed.slice(0, 2)).toEqual(path.slice(0, 2));
    expect(smoothed.slice(-2)).toEqual(path.slice(-2));
    expect(smoothed.length).toBeLessThanOrEqual(path.length);
  });

  it('does not shortcut across a wall', () => {
    const grid = arena();
    divide(grid, 15, 25);
    const path = pathFromTile(grid, 3, 3, 28, 3);
    const smoothed = smoothPath(grid, path, 8);
    for (let i = 2; i < smoothed.length; i += 2) {
      expect(
        isWalkableLine(
          grid,
          tileCenter(smoothed[i - 2] as number),
          tileCenter(smoothed[i - 1] as number),
          tileCenter(smoothed[i] as number),
          tileCenter(smoothed[i + 1] as number),
          8,
        ),
      ).toBe(true);
    }
    // The straight line between the endpoints crosses the wall, so it cannot collapse.
    expect(smoothed.length).toBeGreaterThan(4);
  });

  it('leaves a route hugging a wall alone when the body is too wide to cut it', () => {
    const grid = arena();
    grid.setTerrain(6, 6, Tile.WallBrick);
    const detour = [4, 6, 5, 5, 6, 5, 7, 5, 8, 6];
    const smoothed = smoothPath(grid, detour, 14);
    expect(smoothed.length).toBeGreaterThan(4);
  });

  it('passes short paths through untouched', () => {
    const grid = arena();
    expect(smoothPath(grid, [4, 4], 8)).toEqual([4, 4]);
    expect(smoothPath(grid, [4, 4, 5, 5], 8)).toEqual([4, 4, 5, 5]);
    expect(smoothPath(grid, [], 8)).toEqual([]);
  });
});

describe('isWalkableLine', () => {
  it('sees a wall the centre line crosses', () => {
    const grid = arena();
    grid.setTerrain(10, 10, Tile.WallBrick);
    expect(
      isWalkableLine(grid, tileCenter(8), tileCenter(8), tileCenter(12), tileCenter(12), 6),
    ).toBe(false);
  });

  it('lets a thin body through a gap a wide one cannot use', () => {
    const grid = arena();
    grid.setTerrain(10, 9, Tile.WallBrick);
    grid.setTerrain(10, 11, Tile.WallBrick);
    const from = tileCenter(8);
    const to = tileCenter(12);
    expect(isWalkableLine(grid, from, tileCenter(10), to, tileCenter(10), 8)).toBe(true);
    expect(isWalkableLine(grid, from, tileCenter(10), to, tileCenter(10), 24)).toBe(false);
  });
});
