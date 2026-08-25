import type Phaser from 'phaser';
import { Tile } from '@survive/protocol';
import type { GameData } from '@survive/game-data';
import {
  ICON_PX,
  TILE_PX,
  animalSpec,
  drawCreature,
  drawCrop,
  drawDeadCrop,
  drawItemIcon,
  drawNode,
  drawParticle,
  drawPixel,
  drawPlayer,
  drawProjectile,
  drawRing,
  drawSoftCircle,
  drawStructure,
  drawTile,
  drawTileOutline,
  zombieSpec,
} from './canvasArt';
import { UI } from './palette';

/**
 * Texture registration.
 *
 * Everything is generated once during the boot scene and lives in Phaser's texture
 * manager for the rest of the session. Roughly 400 small canvases: measured at a few
 * tens of milliseconds, which is well inside a loading screen and saves shipping an
 * atlas.
 *
 * Key naming is flat and predictable (`item:wood_log`, `zombie:runner:crawl`) so the
 * renderer can compose a key from state without a lookup table.
 */

/** How many deterministic variants each terrain tile gets. */
export const TILE_VARIANTS = 4;

/** Columns in the generated tileset atlas. One column per variant. */
const ATLAS_COLUMNS = TILE_VARIANTS;

/** Texture key of the combined tileset atlas used by the terrain tilemaps. */
export const TILESET_KEY = 'tileset';

export const TextureKey = {
  tile: (tileId: number, variant: number) => `tile:${tileId}:${variant}`,
  playerSelf: 'player:self',
  playerRemote: 'player:remote',
  zombie: (defId: string, crawling = false) => `zombie:${defId}${crawling ? ':crawl' : ''}`,
  animal: (defId: string) => `animal:${defId}`,
  item: (defId: string) => `item:${defId}`,
  structure: (defId: string, open = false) => `structure:${defId}${open ? ':open' : ''}`,
  node: (defId: string, variant: number) => `node:${defId}:${variant}`,
  crop: (cropId: string, stage: number) => `crop:${cropId}:${stage}`,
  cropDead: 'crop:dead',
  projectile: (defId: string) => `projectile:${defId}`,
  pixel: 'fx:pixel',
  light: 'fx:light',
  muzzle: 'fx:muzzle',
  bloodPuff: 'fx:blood',
  dust: 'fx:dust',
  spark: 'fx:spark',
  leaf: 'fx:leaf',
  rain: 'fx:rain',
  snow: 'fx:snow',
  selectRing: 'fx:selectRing',
  targetRing: 'fx:targetRing',
  ghostValid: 'fx:ghostValid',
  ghostInvalid: 'fx:ghostInvalid',
  tileCursor: 'fx:tileCursor',
} as const;

interface TextureSink {
  exists(key: string): boolean;
  addCanvas(key: string, source: HTMLCanvasElement): unknown;
}

function register(textures: TextureSink, key: string, canvas: HTMLCanvasElement): void {
  // Re-registering would leak GPU textures on a scene restart.
  if (textures.exists(key)) return;
  textures.addCanvas(key, canvas);
}

/** Every tile id the terrain generator can emit, in a stable order. */
const TILE_IDS: readonly number[] = Object.values(Tile)
  .slice()
  .sort((a, b) => a - b);

/** Row of a tile id inside the atlas. Built once, alongside the atlas itself. */
const atlasRowByTile = new Map<number, number>();
TILE_IDS.forEach((tileId, row) => atlasRowByTile.set(tileId, row));

/**
 * Index of one (tile, variant) pair inside the tileset atlas.
 *
 * Terrain is drawn through a Phaser tilemap rather than one sprite per tile: a loaded
 * window is around 25 chunks, which is 25 000 tiles, and that is the difference between
 * one draw call per chunk and twenty-five thousand game objects.
 */
export function tilesetIndex(tileId: number, variant: number): number {
  const row = atlasRowByTile.get(tileId) ?? atlasRowByTile.get(Tile.Grass) ?? 0;
  return row * ATLAS_COLUMNS + (variant % TILE_VARIANTS);
}

/** Rows in the atlas, i.e. how many distinct tile ids it holds. */
export function tilesetRowCount(): number {
  return TILE_IDS.length;
}

/**
 * Stitch every tile variant into a single atlas image.
 *
 * Laid out with one row per tile id and one column per variant, so
 * {@link tilesetIndex} is pure arithmetic with no lookup table to keep in sync.
 */
function buildTilesetAtlas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = ATLAS_COLUMNS * TILE_PX;
  canvas.height = TILE_IDS.length * TILE_PX;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable');
  ctx.imageSmoothingEnabled = false;
  TILE_IDS.forEach((tileId, row) => {
    for (let variant = 0; variant < TILE_VARIANTS; variant++) {
      ctx.drawImage(drawTile(tileId, variant), variant * TILE_PX, row * TILE_PX);
    }
  });
  return canvas;
}

/**
 * Build every texture the game needs.
 *
 * Takes the loaded {@link GameData} so the item, structure, node and crop tables drive
 * what gets drawn - add an item to the content tables and its icon appears with no
 * change here.
 */
export function generateAllTextures(scene: Phaser.Scene, data: GameData): number {
  const textures = scene.textures as unknown as TextureSink;
  let count = 0;

  // The atlas for the terrain tilemaps, plus individual tile textures for the UI
  // (the map screen and the build ghost draw single tiles).
  register(textures, TILESET_KEY, buildTilesetAtlas());
  count++;
  for (const tileId of TILE_IDS) {
    for (let variant = 0; variant < TILE_VARIANTS; variant++) {
      register(textures, TextureKey.tile(tileId, variant), drawTile(tileId, variant));
      count++;
    }
  }

  register(textures, TextureKey.playerSelf, drawPlayer('self'));
  register(textures, TextureKey.playerRemote, drawPlayer('remote'));
  count += 2;

  for (const def of data.zombies.all()) {
    register(
      textures,
      TextureKey.zombie(def.id),
      drawCreature(def.id, zombieSpec(def.id, def.radius)),
    );
    register(
      textures,
      TextureKey.zombie(def.id, true),
      drawCreature(`${def.id}:crawl`, zombieSpec(def.id, def.radius, true)),
    );
    count += 2;
  }

  for (const def of data.animals.all()) {
    register(
      textures,
      TextureKey.animal(def.id),
      drawCreature(def.id, animalSpec(def.id, def.radius)),
    );
    count++;
  }

  for (const def of data.items.all()) {
    register(textures, TextureKey.item(def.id), drawItemIcon(def.id, def.category, def.tags));
    count++;
  }

  for (const def of data.structures.all()) {
    register(
      textures,
      TextureKey.structure(def.id),
      drawStructure(def.id, {
        category: def.category,
        widthTiles: def.width,
        heightTiles: def.height,
      }),
    );
    count++;
    if (def.door) {
      register(
        textures,
        TextureKey.structure(def.id, true),
        drawStructure(def.id, {
          category: def.category,
          widthTiles: def.width,
          heightTiles: def.height,
          open: true,
        }),
      );
      count++;
    }
  }

  for (const def of data.nodes.all()) {
    const variants = Math.max(1, def.variants);
    for (let variant = 0; variant < variants; variant++) {
      register(
        textures,
        TextureKey.node(def.id, variant),
        drawNode(def.id, {
          category: def.category,
          radius: def.radius > 0 ? def.radius : 10,
          variant,
        }),
      );
      count++;
    }
  }

  for (const def of data.crops.all()) {
    for (let stage = 0; stage < def.stages; stage++) {
      register(textures, TextureKey.crop(def.id, stage), drawCrop(def.id, stage, def.stages));
      count++;
    }
  }
  register(textures, TextureKey.cropDead, drawDeadCrop());
  count++;

  for (const def of data.projectiles.all()) {
    // Longer streaks for faster projectiles reads as speed without any animation.
    const length = Math.max(6, Math.min(20, Math.round(def.speed / 60)));
    register(textures, TextureKey.projectile(def.id), drawProjectile(length, 0xe8dcb4));
    count++;
  }

  register(textures, TextureKey.pixel, drawPixel());
  register(textures, TextureKey.light, drawSoftCircle(256, 0xffe9b0, 0.75));
  register(textures, TextureKey.muzzle, drawSoftCircle(64, 0xffe07a, 0.95));
  register(textures, TextureKey.bloodPuff, drawSoftCircle(48, 0x8c2723, 0.8));
  register(textures, TextureKey.dust, drawParticle(3, 0x9a8f7c));
  register(textures, TextureKey.spark, drawParticle(2, 0xffd88a));
  register(textures, TextureKey.leaf, drawParticle(3, 0x4a6a3c));
  register(textures, TextureKey.rain, drawProjectile(7, 0x8fb6c4));
  register(textures, TextureKey.snow, drawParticle(2, 0xe8f1f3));
  register(textures, TextureKey.selectRing, drawRing(40, UI.accent, 2));
  register(textures, TextureKey.targetRing, drawRing(48, UI.danger, 2));
  register(textures, TextureKey.ghostValid, drawTileOutline(UI.accent, true));
  register(textures, TextureKey.ghostInvalid, drawTileOutline(UI.danger, true));
  register(textures, TextureKey.tileCursor, drawTileOutline(UI.textMuted, false));
  count += 15;

  return count;
}

/**
 * Deterministic tile variant for a world position.
 *
 * Position-derived rather than random so the same patch of grass looks the same every
 * time the chunk is drawn, including after an unload and reload.
 */
export function tileVariantFor(tileX: number, tileY: number): number {
  // Cheap integer hash; the exact mix does not matter, only that it is stable.
  const h = (tileX * 73856093) ^ (tileY * 19349663);
  return Math.abs(h) % TILE_VARIANTS;
}

export { TILE_PX, ICON_PX };
