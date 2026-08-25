import { CHUNK_SIZE, CHUNK_TILES, TILE_SIZE, WORLD_CHUNKS, WORLD_TILES } from './constants';
import type { ChunkKey } from './state/ids';

/** Build the canonical `"cx,cy"` chunk key. */
export function chunkKey(cx: number, cy: number): ChunkKey {
  return `${cx},${cy}`;
}

/** Parse a chunk key back into coordinates. Throws on a malformed key. */
export function parseChunkKey(key: ChunkKey): { cx: number; cy: number } {
  const comma = key.indexOf(',');
  if (comma < 0) throw new Error(`Malformed chunk key: ${key}`);
  const cx = Number.parseInt(key.slice(0, comma), 10);
  const cy = Number.parseInt(key.slice(comma + 1), 10);
  if (!Number.isFinite(cx) || !Number.isFinite(cy)) throw new Error(`Malformed chunk key: ${key}`);
  return { cx, cy };
}

/** World pixel -> tile index (floor). */
export function pixelToTile(px: number): number {
  return Math.floor(px / TILE_SIZE);
}

/** Tile index -> world pixel of the tile's top-left corner. */
export function tileToPixel(tile: number): number {
  return tile * TILE_SIZE;
}

/** Tile index -> world pixel of the tile's centre. */
export function tileCenter(tile: number): number {
  return tile * TILE_SIZE + TILE_SIZE / 2;
}

/** Tile index -> containing chunk index. */
export function tileToChunk(tile: number): number {
  return Math.floor(tile / CHUNK_TILES);
}

/** World pixel -> containing chunk index. */
export function pixelToChunk(px: number): number {
  return Math.floor(px / CHUNK_SIZE);
}

/** Chunk-local tile coordinate, always 0..CHUNK_TILES-1. */
export function tileWithinChunk(tile: number): number {
  const local = tile % CHUNK_TILES;
  return local < 0 ? local + CHUNK_TILES : local;
}

/** Row-major index of a tile inside its chunk's tile array. */
export function chunkTileIndex(tileX: number, tileY: number): number {
  return tileWithinChunk(tileY) * CHUNK_TILES + tileWithinChunk(tileX);
}

/** Chunk key containing the given world pixel position. */
export function chunkKeyAtPixel(x: number, y: number): ChunkKey {
  return chunkKey(pixelToChunk(x), pixelToChunk(y));
}

/** Chunk key containing the given tile. */
export function chunkKeyAtTile(tileX: number, tileY: number): ChunkKey {
  return chunkKey(tileToChunk(tileX), tileToChunk(tileY));
}

/** True when the tile is inside world bounds. */
export function isTileInWorld(tileX: number, tileY: number): boolean {
  return tileX >= 0 && tileY >= 0 && tileX < WORLD_TILES && tileY < WORLD_TILES;
}

/** True when the chunk is inside world bounds. */
export function isChunkInWorld(cx: number, cy: number): boolean {
  return cx >= 0 && cy >= 0 && cx < WORLD_CHUNKS && cy < WORLD_CHUNKS;
}

/** Clamp a world pixel coordinate into the playable area. */
export function clampToWorld(value: number): number {
  const max = WORLD_TILES * TILE_SIZE - 1;
  return value < 0 ? 0 : value > max ? max : value;
}

/** All chunk keys within `radius` chunks of the chunk containing (x, y). */
export function chunkKeysAround(x: number, y: number, radius: number): ChunkKey[] {
  const centerX = pixelToChunk(x);
  const centerY = pixelToChunk(y);
  const keys: ChunkKey[] = [];
  for (let cy = centerY - radius; cy <= centerY + radius; cy++) {
    for (let cx = centerX - radius; cx <= centerX + radius; cx++) {
      if (isChunkInWorld(cx, cy)) keys.push(chunkKey(cx, cy));
    }
  }
  return keys;
}

/** Chebyshev distance in chunks between two chunk coordinates. */
export function chunkDistance(ax: number, ay: number, bx: number, by: number): number {
  return Math.max(Math.abs(ax - bx), Math.abs(ay - by));
}
