import type Phaser from 'phaser';
import {
  CHUNK_SIZE,
  CHUNK_TILES,
  TILE_SIZE,
  parseChunkKey,
  type ChunkKey,
  type ChunkPayload,
} from '@survive/protocol';
import { TILESET_KEY, tileVariantFor, tilesetIndex, tilesetRowCount } from '../art/textures';

/**
 * Terrain.
 *
 * One Phaser tilemap layer per chunk, built when the server sends the chunk's terrain and
 * destroyed when it tells us to drop it. A loaded window is ~25 chunks, i.e. ~25 000
 * tiles: a tilemap layer draws that in one batch, where a sprite per tile would not.
 *
 * Terrain is static (it is a pure function of the world seed), so a layer is built once
 * and never touched again unless a tile override arrives.
 */

export class TerrainRenderer {
  private readonly layers = new Map<ChunkKey, Phaser.Tilemaps.TilemapLayer>();
  private readonly maps = new Map<ChunkKey, Phaser.Tilemaps.Tilemap>();
  /** Terrain payloads, kept so the minimap and the build ghost can read tiles. */
  private readonly payloads = new Map<ChunkKey, ChunkPayload>();

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly depth = -100,
  ) {}

  get chunkCount(): number {
    return this.layers.size;
  }

  has(key: ChunkKey): boolean {
    return this.layers.has(key);
  }

  /** Build (or rebuild) the layer for one chunk. */
  apply(payload: ChunkPayload): void {
    this.drop(payload.key);
    this.payloads.set(payload.key, payload);

    const map = this.scene.make.tilemap({
      tileWidth: TILE_SIZE,
      tileHeight: TILE_SIZE,
      width: CHUNK_TILES,
      height: CHUNK_TILES,
    });
    const tileset = map.addTilesetImage(TILESET_KEY, TILESET_KEY, TILE_SIZE, TILE_SIZE, 0, 0);
    if (!tileset) return;

    const layer = map.createBlankLayer(
      `chunk:${payload.key}`,
      tileset,
      payload.cx * CHUNK_SIZE,
      payload.cy * CHUNK_SIZE,
      CHUNK_TILES,
      CHUNK_TILES,
    );
    if (!layer) {
      map.destroy();
      return;
    }
    layer.setDepth(this.depth);

    const originTileX = payload.cx * CHUNK_TILES;
    const originTileY = payload.cy * CHUNK_TILES;
    for (let localY = 0; localY < CHUNK_TILES; localY++) {
      for (let localX = 0; localX < CHUNK_TILES; localX++) {
        const tileId = payload.tiles[localY * CHUNK_TILES + localX];
        if (tileId === undefined) continue;
        const variant = tileVariantFor(originTileX + localX, originTileY + localY);
        layer.putTileAt(tilesetIndex(tileId, variant), localX, localY, false);
      }
    }

    this.maps.set(payload.key, map);
    this.layers.set(payload.key, layer);
  }

  /** Change one tile in place, for a tilled-soil or destroyed-road update. */
  setTile(tileX: number, tileY: number, tileId: number): void {
    const cx = Math.floor(tileX / CHUNK_TILES);
    const cy = Math.floor(tileY / CHUNK_TILES);
    const key = `${cx},${cy}`;
    const layer = this.layers.get(key);
    if (!layer) return;
    const localX = tileX - cx * CHUNK_TILES;
    const localY = tileY - cy * CHUNK_TILES;
    layer.putTileAt(tilesetIndex(tileId, tileVariantFor(tileX, tileY)), localX, localY, false);
    const payload = this.payloads.get(key);
    if (payload) payload.tiles[localY * CHUNK_TILES + localX] = tileId;
  }

  /** Tile id at a tile coordinate, or undefined when the chunk is not loaded. */
  tileAt(tileX: number, tileY: number): number | undefined {
    const cx = Math.floor(tileX / CHUNK_TILES);
    const cy = Math.floor(tileY / CHUNK_TILES);
    const payload = this.payloads.get(`${cx},${cy}`);
    if (!payload) return undefined;
    const localX = tileX - cx * CHUNK_TILES;
    const localY = tileY - cy * CHUNK_TILES;
    return payload.tiles[localY * CHUNK_TILES + localX];
  }

  /** Biome id at a tile coordinate, for the minimap's colouring. */
  biomeAt(tileX: number, tileY: number): number | undefined {
    const cx = Math.floor(tileX / CHUNK_TILES);
    const cy = Math.floor(tileY / CHUNK_TILES);
    const payload = this.payloads.get(`${cx},${cy}`);
    if (!payload) return undefined;
    const localX = tileX - cx * CHUNK_TILES;
    const localY = tileY - cy * CHUNK_TILES;
    return payload.biomes[localY * CHUNK_TILES + localX];
  }

  /** Terrain payloads currently held, for the minimap. */
  chunks(): Iterable<ChunkPayload> {
    return this.payloads.values();
  }

  drop(key: ChunkKey): void {
    this.layers.get(key)?.destroy();
    this.maps.get(key)?.destroy();
    this.layers.delete(key);
    this.maps.delete(key);
    this.payloads.delete(key);
  }

  dropMany(keys: readonly ChunkKey[]): void {
    for (const key of keys) this.drop(key);
  }

  /** Which chunk keys the client is missing inside a radius, so it can ask for them. */
  missingAround(x: number, y: number, radius: number): ChunkKey[] {
    const centreX = Math.floor(x / CHUNK_SIZE);
    const centreY = Math.floor(y / CHUNK_SIZE);
    const missing: ChunkKey[] = [];
    for (let cy = centreY - radius; cy <= centreY + radius; cy++) {
      for (let cx = centreX - radius; cx <= centreX + radius; cx++) {
        if (cx < 0 || cy < 0) continue;
        const key = `${cx},${cy}`;
        if (!this.payloads.has(key)) missing.push(key);
      }
    }
    return missing;
  }

  destroy(): void {
    for (const key of [...this.layers.keys()]) this.drop(key);
  }

  /** Diagnostic: how many rows the tileset atlas has. */
  static tilesetRows(): number {
    return tilesetRowCount();
  }

  /** Diagnostic helper used by the debug overlay. */
  static chunkOf(key: ChunkKey): { cx: number; cy: number } {
    return parseChunkKey(key);
  }
}
