import { Tile } from '@survive/protocol';

/**
 * The game's colour vocabulary.
 *
 * There are no art assets in this repository, so every sprite and tile is drawn at
 * boot from these numbers (see `./canvasArt.ts`). That is a deliberate trade: the game
 * is playable and legible immediately, with no asset pipeline, and swapping in real art
 * later means replacing the texture factory rather than rewriting the renderer.
 *
 * The palette is desaturated and cool by default so that the things that matter -
 * blood, fire, ripe crops, item rarity - can be the only saturated things on screen.
 */

export interface TilePaint {
  /** Flat base colour. */
  base: number;
  /** Speckle colour, used for deterministic per-tile texture. */
  speckle: number;
  /** How much speckle to apply, 0..1. */
  grain: number;
  /** Optional edge/outline colour for solid tiles. */
  edge?: number;
}

function paint(base: number, speckle: number, grain = 0.12, edge?: number): TilePaint {
  return edge === undefined ? { base, speckle, grain } : { base, speckle, grain, edge };
}

export const TILE_PAINT: Readonly<Record<number, TilePaint>> = {
  [Tile.Void]: paint(0x07090a, 0x0d1113, 0.05),
  [Tile.Grass]: paint(0x3f5b34, 0x4a6a3c, 0.18),
  [Tile.GrassTall]: paint(0x364f2c, 0x476534, 0.32),
  [Tile.Dirt]: paint(0x5a4a37, 0x6a5842, 0.2),
  [Tile.Mud]: paint(0x453729, 0x4f4030, 0.26),
  [Tile.Sand]: paint(0x9c8b62, 0xaa9a72, 0.16),
  [Tile.Gravel]: paint(0x6b6a66, 0x7e7d78, 0.34),
  [Tile.StoneGround]: paint(0x5c5f60, 0x6a6d6e, 0.2),
  [Tile.WaterShallow]: paint(0x2e5f6e, 0x3b7385, 0.14),
  [Tile.WaterDeep]: paint(0x1c3f4e, 0x24505f, 0.1),
  [Tile.RoadAsphalt]: paint(0x3a3d3f, 0x45484a, 0.16),
  [Tile.RoadDirt]: paint(0x655641, 0x74644d, 0.2),
  [Tile.Sidewalk]: paint(0x6e6f6b, 0x7b7c78, 0.12),
  [Tile.FloorWood]: paint(0x6b5335, 0x7a5f3e, 0.14),
  [Tile.FloorTile]: paint(0x7d7f7a, 0x8b8d88, 0.1),
  [Tile.FloorConcrete]: paint(0x63666a, 0x6f7276, 0.12),
  [Tile.FarmlandDry]: paint(0x6a5539, 0x5c4a31, 0.22),
  [Tile.FarmlandWet]: paint(0x4c3c27, 0x412f1e, 0.24),
  [Tile.Snow]: paint(0xd3dde0, 0xe6eef0, 0.1),
  [Tile.Ice]: paint(0xa9c6cf, 0xbdd6dd, 0.08),
  [Tile.Ash]: paint(0x37383a, 0x424345, 0.24),
  [Tile.Rubble]: paint(0x54524e, 0x66635e, 0.4),
  [Tile.WallBrick]: paint(0x6d4438, 0x7d5142, 0.16, 0x3d251d),
  [Tile.WallConcrete]: paint(0x74777a, 0x83868a, 0.12, 0x43464a),
  [Tile.WallWood]: paint(0x7a5c39, 0x8a6a44, 0.18, 0x412f1b),
  [Tile.Cliff]: paint(0x4b4e50, 0x5a5d60, 0.3, 0x2a2c2e),
  [Tile.TreeTrunkStatic]: paint(0x4a3823, 0x59452c, 0.24, 0x281c11),
  [Tile.WindowStatic]: paint(0x5d7f8a, 0x7ba0ab, 0.1, 0x3a4b52),
};

export const DEFAULT_TILE_PAINT: TilePaint = paint(0x3f5b34, 0x4a6a3c, 0.18);

export function tilePaint(tile: number): TilePaint {
  return TILE_PAINT[tile] ?? DEFAULT_TILE_PAINT;
}

/** Colours by item category, so a glance at the inventory reads correctly. */
export const CATEGORY_COLOR: Record<string, number> = {
  resource: 0x8a7a5c,
  component: 0x9a9a8a,
  tool: 0x8c8f96,
  weapon: 0xb0563f,
  ammo: 0xc8a44a,
  armor: 0x5d7a8c,
  food: 0x7fa04a,
  drink: 0x4c8ba6,
  medical: 0xc45b62,
  seed: 0x9db85a,
  produce: 0xc9903c,
  placeable: 0x7a6a52,
  fuel: 0x50524f,
  container: 0x6f5c40,
  misc: 0x8e8e8e,
};

/** Rarity tint used for the item slot border. */
export const RARITY_COLOR: Record<string, number> = {
  common: 0x6f7674,
  uncommon: 0x66a26b,
  rare: 0x5a86bd,
  epic: 0xa06ec2,
};

/** Zombie body colours, keyed by definition id with a fallback. */
export const ZOMBIE_COLOR: Record<string, { body: number; trim: number }> = {
  walker: { body: 0x6c7f5e, trim: 0x4a5940 },
  shambler: { body: 0x5f6f57, trim: 0x3f4a3a },
  runner: { body: 0x7d6a4f, trim: 0x54452f },
  crawler: { body: 0x5b6250, trim: 0x3c412f },
  brute: { body: 0x7a5f52, trim: 0x503b31 },
  spitter: { body: 0x6f7d4a, trim: 0x4c5630 },
  screamer: { body: 0x8a6a72, trim: 0x5d4249 },
  bloater: { body: 0x7f8354, trim: 0x565933 },
  armored: { body: 0x5d666e, trim: 0x394147 },
  feral_dog: { body: 0x6a5b4a, trim: 0x453a2d },
};

export const DEFAULT_ZOMBIE_COLOR = { body: 0x6c7f5e, trim: 0x4a5940 };

export const ANIMAL_COLOR: Record<string, { body: number; trim: number }> = {
  rabbit: { body: 0xa89a86, trim: 0x7d7264 },
  deer: { body: 0x9a7a52, trim: 0x6f573a },
  boar: { body: 0x584a3f, trim: 0x3a302a },
  wolf: { body: 0x7d8288, trim: 0x565b60 },
  bear: { body: 0x5a4535, trim: 0x3b2d22 },
  chicken: { body: 0xd8d2c4, trim: 0xa39b8c },
  cow: { body: 0xc9c3b8, trim: 0x5a4a3d },
  fox: { body: 0xb5713c, trim: 0x7d4c26 },
};

export const DEFAULT_ANIMAL_COLOR = { body: 0x9a9084, trim: 0x6d655c };

/** Structure colours by category. */
export const STRUCTURE_COLOR: Record<string, { fill: number; edge: number }> = {
  foundation: { fill: 0x5f5b53, edge: 0x3d3a35 },
  wall: { fill: 0x7c6244, edge: 0x4a3826 },
  door: { fill: 0x8a6a3f, edge: 0x503c22 },
  window: { fill: 0x6d8b95, edge: 0x3f5158 },
  floor: { fill: 0x6b5335, edge: 0x4a3a25 },
  furniture: { fill: 0x6f5b41, edge: 0x453728 },
  station: { fill: 0x6a6f74, edge: 0x40454a },
  storage: { fill: 0x7a6340, edge: 0x4b3c26 },
  farm: { fill: 0x54432c, edge: 0x372c1c },
  light: { fill: 0xc9a554, edge: 0x6b5a2c },
  defense: { fill: 0x7b7367, edge: 0x4c463e },
  bed: { fill: 0x8d7f6c, edge: 0x574d40 },
  misc: { fill: 0x76736c, edge: 0x484540 },
};

export const DEFAULT_STRUCTURE_COLOR = { fill: 0x76736c, edge: 0x484540 };

/** Resource node colours by category. */
export const NODE_COLOR: Record<string, { primary: number; secondary: number }> = {
  tree: { primary: 0x35502c, secondary: 0x4a3823 },
  rock: { primary: 0x6d7073, secondary: 0x4d5053 },
  ore: { primary: 0x7a6a5a, secondary: 0xa8763f },
  bush: { primary: 0x3f5c38, secondary: 0x8c3f4a },
  plant: { primary: 0x53713f, secondary: 0x7d9a55 },
  water: { primary: 0x35708a, secondary: 0x4e93ad },
  scrap: { primary: 0x6b6257, secondary: 0x9a5f42 },
  corpse: { primary: 0x6f5a52, secondary: 0x8c4a48 },
};

export const DEFAULT_NODE_COLOR = { primary: 0x4a5a40, secondary: 0x6a5a40 };

/** UI chrome. */
export const UI = {
  panel: 0x121718,
  panelAlpha: 0.94,
  panelEdge: 0x2c3437,
  slot: 0x1b2224,
  slotEdge: 0x323b3e,
  slotHover: 0x27343a,
  text: 0xdfe6e6,
  textMuted: 0x8ba09f,
  accent: 0x6fbf73,
  danger: 0xd1584f,
  warn: 0xd8a54a,
  health: 0xc4514a,
  stamina: 0x62a9c4,
  hunger: 0xc98a3f,
  thirst: 0x4d9fc0,
  fatigue: 0x9a7fc0,
  infection: 0x9ac04d,
  bleed: 0xa3312c,
} as const;

/** Convert a 0xRRGGBB integer into a CSS colour string. */
export function cssColor(value: number, alpha = 1): string {
  const r = (value >> 16) & 0xff;
  const g = (value >> 8) & 0xff;
  const b = value & 0xff;
  return alpha >= 1 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${alpha})`;
}

/** Lighten or darken a colour. `amount` is -1..1. */
export function shade(value: number, amount: number): number {
  const r = (value >> 16) & 0xff;
  const g = (value >> 8) & 0xff;
  const b = value & 0xff;
  const mix = (channel: number) =>
    Math.max(
      0,
      Math.min(
        255,
        Math.round(amount >= 0 ? channel + (255 - channel) * amount : channel * (1 + amount)),
      ),
    );
  return (mix(r) << 16) | (mix(g) << 8) | mix(b);
}
