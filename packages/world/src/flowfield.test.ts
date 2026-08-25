import { describe, expect, it } from 'vitest';
import { CHUNK_TILE_COUNT, Tile, tileCenter } from '@survive/protocol';
import { createCollisionGrid } from './collision';
import type { CollisionGrid } from './collision';
import {
  DEFAULT_FLOW_GOAL_QUANTUM_TILES,
  FLOW_DIR_NONE,
  MAX_FLOW_EXTENT_TILES,
  buildFlowField,
  createFlowFieldCache,
  sampleFlow,
  sampleFlowCost,
} from './flowfield';
import { CollisionFlag } from './types';
import type { FlowField } from './types';

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

function costAt(field: FlowField, tileX: number, tileY: number): number {
  return sampleFlowCost(field, tileCenter(tileX), tileCenter(tileY));
}

function dirAt(field: FlowField, tileX: number, tileY: number): number {
  const localX = tileX - field.minTileX;
  const localY = tileY - field.minTileY;
  return field.dir[localY * field.width + localX] ?? FLOW_DIR_NONE;
}

describe('buildFlowField', () => {
  it('centres a clamped window on the goal tile', () => {
    const grid = arena();
    const field = buildFlowField(grid, tileCenter(16), tileCenter(16), 7, 10);
    expect(field.goalTileX).toBe(16);
    expect(field.goalTileY).toBe(16);
    expect(field.minTileX).toBe(6);
    expect(field.minTileY).toBe(6);
    expect(field.width).toBe(21);
    expect(field.height).toBe(21);
    expect(field.builtTick).toBe(7);
    expect(field.cost.length).toBe(21 * 21);
    expect(field.dir.length).toBe(21 * 21);
  });

  it('clamps the window at the world edge', () => {
    const grid = arena();
    const field = buildFlowField(grid, tileCenter(2), tileCenter(2), 0, 10);
    expect(field.minTileX).toBe(0);
    expect(field.minTileY).toBe(0);
    expect(field.width).toBe(13);
  });

  it('clamps an absurd extent instead of allocating the world', () => {
    const grid = arena();
    const field = buildFlowField(grid, tileCenter(16), tileCenter(16), 0, 10_000);
    expect(field.width).toBeLessThanOrEqual(MAX_FLOW_EXTENT_TILES * 2 + 1);
  });

  it('has zero cost and no direction at the goal', () => {
    const grid = arena();
    const field = buildFlowField(grid, tileCenter(16), tileCenter(16), 0, 8);
    expect(costAt(field, 16, 16)).toBe(0);
    expect(dirAt(field, 16, 16)).toBe(FLOW_DIR_NONE);
    expect(sampleFlow(field, tileCenter(16), tileCenter(16))).toBeNull();
  });

  it('descends monotonically towards the goal from anywhere in the window', () => {
    const grid = arena();
    grid.setTerrain(14, 14, Tile.WallBrick);
    grid.setTerrain(14, 15, Tile.WallBrick);
    grid.setTerrain(14, 16, Tile.WallBrick);
    const field = buildFlowField(grid, tileCenter(20), tileCenter(20), 0, 12);

    for (let tileY = 9; tileY <= 30; tileY += 3) {
      for (let tileX = 9; tileX <= 30; tileX += 3) {
        if (grid.isSolid(tileX, tileY)) continue;
        let x = tileX;
        let y = tileY;
        let previous = costAt(field, x, y);
        expect(previous).toBeLessThan(Infinity);
        let steps = 0;
        while (!(x === field.goalTileX && y === field.goalTileY)) {
          const direction = sampleFlow(field, tileCenter(x), tileCenter(y));
          expect(direction).not.toBeNull();
          x += Math.round(direction?.x ?? 0);
          y += Math.round(direction?.y ?? 0);
          const cost = costAt(field, x, y);
          expect(cost).toBeLessThan(previous);
          previous = cost;
          steps++;
          expect(steps).toBeLessThan(200);
        }
        expect(previous).toBe(0);
      }
    }
  });

  it('costs a diagonal more than an orthogonal step', () => {
    const grid = arena();
    const field = buildFlowField(grid, tileCenter(16), tileCenter(16), 0, 8);
    expect(costAt(field, 17, 16)).toBeCloseTo(1, 5);
    expect(costAt(field, 17, 17)).toBeCloseTo(Math.SQRT2, 5);
    expect(costAt(field, 16, 16 - 3)).toBeCloseTo(3, 5);
  });

  it('leaves unreachable tiles at infinity with no direction', () => {
    const grid = arena();
    for (let tileY = 24; tileY <= 26; tileY++) {
      for (let tileX = 24; tileX <= 26; tileX++) {
        if (tileX !== 25 || tileY !== 25) grid.setTerrain(tileX, tileY, Tile.WallBrick);
      }
    }
    const field = buildFlowField(grid, tileCenter(16), tileCenter(16), 0, 16);
    expect(costAt(field, 25, 25)).toBe(Infinity);
    expect(dirAt(field, 25, 25)).toBe(FLOW_DIR_NONE);
    expect(sampleFlow(field, tileCenter(25), tileCenter(25))).toBeNull();
    // The wall tiles themselves are never entered either.
    expect(costAt(field, 24, 24)).toBe(Infinity);
  });

  it('does not cut diagonal corners', () => {
    const grid = arena();
    grid.setTerrain(16, 15, Tile.WallBrick);
    grid.setTerrain(15, 16, Tile.WallBrick);
    const field = buildFlowField(grid, tileCenter(16), tileCenter(16), 0, 8);
    // (15,15) must not point diagonally into the goal between the two walls.
    const direction = sampleFlow(field, tileCenter(15), tileCenter(15));
    expect(direction).not.toEqual({ x: Math.SQRT1_2, y: Math.SQRT1_2 });
    expect(costAt(field, 15, 15)).toBeGreaterThan(Math.SQRT2);
  });

  it('stops at a closed door unless a door cost is given', () => {
    const grid = arena();
    for (let tileY = 1; tileY <= 30; tileY++) grid.setTerrain(15, tileY, Tile.WallBrick);
    grid.setTerrain(15, 15, Tile.Grass);
    grid.add(15, 15, CollisionFlag.Door | CollisionFlag.StructureSolid);

    const sealed = buildFlowField(grid, tileCenter(20), tileCenter(15), 0, 18);
    expect(costAt(sealed, 5, 15)).toBe(Infinity);

    const breakable = buildFlowField(grid, tileCenter(20), tileCenter(15), 0, 18, { doorCost: 8 });
    expect(costAt(breakable, 5, 15)).toBeLessThan(Infinity);
    expect(costAt(breakable, 5, 15)).toBeGreaterThan(8);
  });

  it('nudges a goal that is inside a wall', () => {
    const grid = arena();
    for (let tileY = 15; tileY <= 17; tileY++) {
      for (let tileX = 15; tileX <= 17; tileX++) grid.setTerrain(tileX, tileY, Tile.WallBrick);
    }
    const field = buildFlowField(grid, tileCenter(16), tileCenter(16), 0, 10);
    expect(field.goalTileX).toBe(16);
    expect(costAt(field, 10, 10)).toBeLessThan(Infinity);
    expect(sampleFlow(field, tileCenter(10), tileCenter(10))).not.toBeNull();
  });

  it('returns an empty field when the goal is buried', () => {
    const grid = createCollisionGrid();
    grid.seedChunk(0, 0, new Array<number>(CHUNK_TILE_COUNT).fill(Tile.WallBrick));
    const field = buildFlowField(grid, tileCenter(16), tileCenter(16), 0, 4);
    expect(costAt(field, 16, 16)).toBe(Infinity);
    expect(dirAt(field, 16, 16)).toBe(FLOW_DIR_NONE);
  });

  it('is a pure function of the grid, the goal and the extent', () => {
    const grid = arena();
    grid.setTerrain(12, 12, Tile.WallBrick);
    const a = buildFlowField(grid, tileCenter(16), tileCenter(16), 0, 10);
    const b = buildFlowField(grid, tileCenter(16), tileCenter(16), 99, 10);
    expect(Array.from(a.cost)).toEqual(Array.from(b.cost));
    expect(Array.from(a.dir)).toEqual(Array.from(b.dir));
  });
});

describe('sampleFlow', () => {
  it('points towards the goal in open ground', () => {
    const grid = arena();
    const field = buildFlowField(grid, tileCenter(16), tileCenter(16), 0, 10);
    const west = sampleFlow(field, tileCenter(10), tileCenter(16));
    expect(west?.x).toBeCloseTo(1, 6);
    expect(west?.y).toBeCloseTo(0, 6);
    const south = sampleFlow(field, tileCenter(16), tileCenter(22));
    expect(south?.x).toBeCloseTo(0, 6);
    expect(south?.y).toBeCloseTo(-1, 6);
  });

  it('returns unit-length directions, diagonals included', () => {
    const grid = arena();
    const field = buildFlowField(grid, tileCenter(16), tileCenter(16), 0, 10);
    let sawDiagonal = false;
    for (let tileY = 7; tileY <= 25; tileY++) {
      for (let tileX = 7; tileX <= 25; tileX++) {
        const direction = sampleFlow(field, tileCenter(tileX), tileCenter(tileY));
        if (direction === null) continue;
        expect(Math.hypot(direction.x, direction.y)).toBeCloseTo(1, 6);
        if (direction.x !== 0 && direction.y !== 0) sawDiagonal = true;
      }
    }
    expect(sawDiagonal).toBe(true);
  });

  it('returns null outside the window', () => {
    const grid = arena();
    const field = buildFlowField(grid, tileCenter(16), tileCenter(16), 0, 4);
    expect(sampleFlow(field, tileCenter(30), tileCenter(30))).toBeNull();
    expect(sampleFlowCost(field, tileCenter(30), tileCenter(30))).toBe(Infinity);
  });
});

describe('flow field cache', () => {
  it('shares one field between goals in the same quantum cell', () => {
    const grid = arena();
    const cache = createFlowFieldCache({ extentTiles: 8 });
    const first = cache.get(grid, tileCenter(16), tileCenter(16), 0, 10);
    const nearby = cache.get(grid, tileCenter(17), tileCenter(16), 1, 10);
    expect(nearby).toBe(first);
    expect(cache.size).toBe(1);
  });

  it('builds a separate field for a goal in another cell', () => {
    const grid = arena();
    const cache = createFlowFieldCache({ extentTiles: 8 });
    const first = cache.get(grid, tileCenter(4), tileCenter(4), 0, 10);
    const far = cache.get(grid, tileCenter(24), tileCenter(24), 0, 10);
    expect(far).not.toBe(first);
    expect(cache.size).toBe(2);
    expect(DEFAULT_FLOW_GOAL_QUANTUM_TILES).toBeGreaterThan(1);
  });

  it('rebuilds once the field is older than maxAgeTicks', () => {
    const grid = arena();
    const cache = createFlowFieldCache({ extentTiles: 8 });
    const first = cache.get(grid, tileCenter(16), tileCenter(16), 100, 10);
    expect(cache.get(grid, tileCenter(16), tileCenter(16), 109, 10)).toBe(first);
    const rebuilt = cache.get(grid, tileCenter(16), tileCenter(16), 110, 10);
    expect(rebuilt).not.toBe(first);
    expect(rebuilt.builtTick).toBe(110);
    expect(cache.size).toBe(1);
  });

  it('rebuilds when the tick moves backwards, as it does after a reload', () => {
    const grid = arena();
    const cache = createFlowFieldCache({ extentTiles: 8 });
    const first = cache.get(grid, tileCenter(16), tileCenter(16), 500, 10);
    expect(cache.get(grid, tileCenter(16), tileCenter(16), 200, 10)).not.toBe(first);
  });

  it('picks up a wall built after the field was cached, once it expires', () => {
    const grid = arena();
    const cache = createFlowFieldCache({ extentTiles: 10 });
    const before = cache.get(grid, tileCenter(16), tileCenter(16), 0, 5);
    expect(sampleFlowCost(before, tileCenter(10), tileCenter(16))).toBeLessThan(Infinity);
    for (let tileY = 1; tileY <= 30; tileY++) grid.setTerrain(13, tileY, Tile.WallBrick);
    const after = cache.get(grid, tileCenter(16), tileCenter(16), 5, 5);
    expect(sampleFlowCost(after, tileCenter(10), tileCenter(16))).toBe(Infinity);
  });

  it('prunes stale fields and can be cleared', () => {
    const grid = arena();
    const cache = createFlowFieldCache({ extentTiles: 6 });
    cache.get(grid, tileCenter(6), tileCenter(6), 0, 10);
    cache.get(grid, tileCenter(24), tileCenter(24), 8, 10);
    expect(cache.size).toBe(2);
    cache.prune(10, 10);
    expect(cache.size).toBe(1);
    cache.prune(20, 10);
    expect(cache.size).toBe(0);
    cache.get(grid, tileCenter(6), tileCenter(6), 20, 10);
    cache.clear();
    expect(cache.size).toBe(0);
  });

  it('evicts the oldest field when it is full', () => {
    const grid = arena();
    const cache = createFlowFieldCache({ extentTiles: 4, maxEntries: 2 });
    const oldest = cache.get(grid, tileCenter(4), tileCenter(4), 0, 100);
    cache.get(grid, tileCenter(12), tileCenter(12), 1, 100);
    cache.get(grid, tileCenter(20), tileCenter(20), 2, 100);
    expect(cache.size).toBe(2);
    expect(cache.get(grid, tileCenter(4), tileCenter(4), 3, 100)).not.toBe(oldest);
  });

  it('routes hordes through doors when built with a door cost', () => {
    const grid = arena();
    for (let tileY = 1; tileY <= 30; tileY++) grid.setTerrain(15, tileY, Tile.WallBrick);
    grid.setTerrain(15, 15, Tile.Grass);
    grid.add(15, 15, CollisionFlag.Door | CollisionFlag.StructureSolid);
    const cache = createFlowFieldCache({ extentTiles: 18, doorCost: 8 });
    const field = cache.get(grid, tileCenter(20), tileCenter(15), 0, 20);
    expect(sampleFlowCost(field, tileCenter(5), tileCenter(15))).toBeLessThan(Infinity);
  });
});
