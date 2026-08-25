import { describe, expect, it } from 'vitest';
import {
  chunkDistance,
  chunkKey,
  chunkKeyAtPixel,
  chunkKeyAtTile,
  chunkKeysAround,
  chunkTileIndex,
  clampToWorld,
  isChunkInWorld,
  isTileInWorld,
  parseChunkKey,
  pixelToChunk,
  pixelToTile,
  tileCenter,
  tileToChunk,
  tileToPixel,
  tileWithinChunk,
} from './chunks';
import { CHUNK_SIZE, CHUNK_TILES, TILE_SIZE, WORLD_CHUNKS, WORLD_TILES } from './constants';

describe('chunk coordinates', () => {
  it('round-trips a chunk key', () => {
    expect(parseChunkKey(chunkKey(31, 42))).toEqual({ cx: 31, cy: 42 });
    expect(parseChunkKey(chunkKey(-3, 0))).toEqual({ cx: -3, cy: 0 });
  });

  it('rejects a malformed key rather than silently returning NaN', () => {
    expect(() => parseChunkKey('nope')).toThrow();
    expect(() => parseChunkKey('a,b')).toThrow();
  });

  it('maps pixels to tiles, flooring towards negative infinity', () => {
    expect(pixelToTile(0)).toBe(0);
    expect(pixelToTile(TILE_SIZE - 1)).toBe(0);
    expect(pixelToTile(TILE_SIZE)).toBe(1);
    expect(pixelToTile(-1)).toBe(-1);
  });

  it('maps tiles back to pixels and centres', () => {
    expect(tileToPixel(3)).toBe(3 * TILE_SIZE);
    expect(tileCenter(3)).toBe(3 * TILE_SIZE + TILE_SIZE / 2);
  });

  it('maps tiles and pixels to chunks', () => {
    expect(tileToChunk(0)).toBe(0);
    expect(tileToChunk(CHUNK_TILES - 1)).toBe(0);
    expect(tileToChunk(CHUNK_TILES)).toBe(1);
    expect(tileToChunk(-1)).toBe(-1);
    expect(pixelToChunk(CHUNK_SIZE)).toBe(1);
    expect(pixelToChunk(-1)).toBe(-1);
  });

  it('keeps chunk-local tile coordinates positive', () => {
    expect(tileWithinChunk(0)).toBe(0);
    expect(tileWithinChunk(CHUNK_TILES)).toBe(0);
    expect(tileWithinChunk(-1)).toBe(CHUNK_TILES - 1);
  });

  it('computes a row-major index inside the chunk', () => {
    expect(chunkTileIndex(0, 0)).toBe(0);
    expect(chunkTileIndex(1, 0)).toBe(1);
    expect(chunkTileIndex(0, 1)).toBe(CHUNK_TILES);
    expect(chunkTileIndex(-1, -1)).toBe(CHUNK_TILES * CHUNK_TILES - 1);
  });

  it('agrees between the pixel and tile chunk-key helpers', () => {
    const x = 5000;
    const y = 9000;
    expect(chunkKeyAtPixel(x, y)).toBe(chunkKeyAtTile(pixelToTile(x), pixelToTile(y)));
  });

  it('enumerates the ring of chunks around a position', () => {
    const keys = chunkKeysAround(CHUNK_SIZE * 5 + 10, CHUNK_SIZE * 5 + 10, 1);
    expect(keys).toHaveLength(9);
    expect(keys).toContain(chunkKey(5, 5));
    expect(keys).toContain(chunkKey(4, 4));
    expect(keys).toContain(chunkKey(6, 6));
  });

  it('clips the ring at the world edge instead of returning out-of-bounds chunks', () => {
    const keys = chunkKeysAround(0, 0, 2);
    expect(keys.every((key) => isChunkInWorld(parseChunkKey(key).cx, parseChunkKey(key).cy))).toBe(
      true,
    );
    expect(keys).toHaveLength(9); // quarter of a 5x5 ring
  });

  it('knows world bounds', () => {
    expect(isTileInWorld(0, 0)).toBe(true);
    expect(isTileInWorld(-1, 0)).toBe(false);
    expect(isTileInWorld(WORLD_TILES, 0)).toBe(false);
    expect(isChunkInWorld(WORLD_CHUNKS - 1, WORLD_CHUNKS - 1)).toBe(true);
    expect(isChunkInWorld(WORLD_CHUNKS, 0)).toBe(false);
  });

  it('clamps positions into the playable area', () => {
    expect(clampToWorld(-50)).toBe(0);
    expect(clampToWorld(WORLD_TILES * TILE_SIZE + 100)).toBe(WORLD_TILES * TILE_SIZE - 1);
    expect(clampToWorld(1234)).toBe(1234);
  });

  it('measures chunk distance with the Chebyshev metric', () => {
    expect(chunkDistance(0, 0, 3, 1)).toBe(3);
    expect(chunkDistance(0, 0, 0, 0)).toBe(0);
  });
});
