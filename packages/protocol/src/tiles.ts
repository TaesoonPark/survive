/**
 * Terrain tile ids and their gameplay properties.
 *
 * Tiles are the *static* world layer: a pure function of the world seed, never
 * persisted (spec section 29). Anything that changes at runtime is either a tile
 * override or a structure entity.
 *
 * Ids are numeric because a chunk ships 1024 of them per message.
 */
export const Tile = {
  Void: 0,
  Grass: 1,
  GrassTall: 2,
  Dirt: 3,
  Mud: 4,
  Sand: 5,
  Gravel: 6,
  StoneGround: 7,
  WaterShallow: 8,
  WaterDeep: 9,
  RoadAsphalt: 10,
  RoadDirt: 11,
  Sidewalk: 12,
  FloorWood: 13,
  FloorTile: 14,
  FloorConcrete: 15,
  FarmlandDry: 16,
  FarmlandWet: 17,
  Snow: 18,
  Ice: 19,
  Ash: 20,
  Rubble: 21,
  // Static solids. These are part of the generated map (buildings, cliffs).
  WallBrick: 30,
  WallConcrete: 31,
  WallWood: 32,
  Cliff: 33,
  TreeTrunkStatic: 34,
  WindowStatic: 35,
} as const;

export type TileId = (typeof Tile)[keyof typeof Tile];

export interface TileProps {
  /** Blocks walking. */
  solid: boolean;
  /** Blocks line of sight (vision, gunfire). */
  opaque: boolean;
  /** Movement speed multiplier for anything standing on it. */
  speed: number;
  /** Drinkable / fillable water. */
  water: boolean;
  /** Deep water: entities must swim, and drop what they cannot carry. */
  deep: boolean;
  /** Can be turned into farmland with a hoe. */
  tillable: boolean;
  /** Player structures may be placed here. */
  buildable: boolean;
  /** Footstep sound key, also used to pick a noise loudness. */
  footstep: 'grass' | 'dirt' | 'stone' | 'wood' | 'water' | 'snow' | 'none';
  /** Base loudness multiplier for footsteps on this tile. */
  noise: number;
}

const defaults: TileProps = {
  solid: false,
  opaque: false,
  speed: 1,
  water: false,
  deep: false,
  tillable: false,
  buildable: true,
  footstep: 'dirt',
  noise: 1,
};

function props(overrides: Partial<TileProps>): TileProps {
  return { ...defaults, ...overrides };
}

/** Property lookup by tile id. Missing ids fall back to {@link DEFAULT_TILE_PROPS}. */
export const TILE_PROPS: Readonly<Record<number, TileProps>> = {
  [Tile.Void]: props({ solid: true, opaque: false, buildable: false, footstep: 'none' }),
  [Tile.Grass]: props({ footstep: 'grass', tillable: true, noise: 0.8 }),
  [Tile.GrassTall]: props({ footstep: 'grass', tillable: true, speed: 0.85, noise: 1.1 }),
  [Tile.Dirt]: props({ footstep: 'dirt', tillable: true }),
  [Tile.Mud]: props({ footstep: 'dirt', speed: 0.7, tillable: true, noise: 1.2 }),
  [Tile.Sand]: props({ footstep: 'dirt', speed: 0.88 }),
  [Tile.Gravel]: props({ footstep: 'stone', noise: 1.3 }),
  [Tile.StoneGround]: props({ footstep: 'stone' }),
  [Tile.WaterShallow]: props({
    speed: 0.55,
    water: true,
    footstep: 'water',
    buildable: false,
    noise: 1.4,
  }),
  [Tile.WaterDeep]: props({
    speed: 0.35,
    water: true,
    deep: true,
    footstep: 'water',
    buildable: false,
    noise: 1.2,
  }),
  [Tile.RoadAsphalt]: props({ speed: 1.12, footstep: 'stone', noise: 1.1 }),
  [Tile.RoadDirt]: props({ speed: 1.06, footstep: 'dirt' }),
  [Tile.Sidewalk]: props({ speed: 1.08, footstep: 'stone', noise: 1.1 }),
  [Tile.FloorWood]: props({ footstep: 'wood', noise: 1.25 }),
  [Tile.FloorTile]: props({ footstep: 'stone', noise: 1.2 }),
  [Tile.FloorConcrete]: props({ footstep: 'stone', noise: 1.1 }),
  [Tile.FarmlandDry]: props({ footstep: 'dirt', speed: 0.95, tillable: false }),
  [Tile.FarmlandWet]: props({ footstep: 'dirt', speed: 0.9, tillable: false }),
  [Tile.Snow]: props({ footstep: 'snow', speed: 0.82, noise: 0.7 }),
  [Tile.Ice]: props({ footstep: 'stone', speed: 1.15 }),
  [Tile.Ash]: props({ footstep: 'dirt', noise: 0.9 }),
  [Tile.Rubble]: props({ footstep: 'stone', speed: 0.7, noise: 1.4 }),
  [Tile.WallBrick]: props({ solid: true, opaque: true, buildable: false, footstep: 'none' }),
  [Tile.WallConcrete]: props({ solid: true, opaque: true, buildable: false, footstep: 'none' }),
  [Tile.WallWood]: props({ solid: true, opaque: true, buildable: false, footstep: 'none' }),
  [Tile.Cliff]: props({ solid: true, opaque: true, buildable: false, footstep: 'none' }),
  [Tile.TreeTrunkStatic]: props({ solid: true, opaque: true, buildable: false, footstep: 'none' }),
  [Tile.WindowStatic]: props({ solid: true, opaque: false, buildable: false, footstep: 'none' }),
};

export const DEFAULT_TILE_PROPS: TileProps = defaults;

export function tileProps(tile: number): TileProps {
  return TILE_PROPS[tile] ?? defaults;
}

export function isTileSolid(tile: number): boolean {
  return tileProps(tile).solid;
}

export function isTileWater(tile: number): boolean {
  return tileProps(tile).water;
}

export function isTileOpaque(tile: number): boolean {
  return tileProps(tile).opaque;
}

/** Biome ids. Drive terrain, spawns, resource mix and temperature offsets. */
export const Biome = {
  Grassland: 0,
  Forest: 1,
  DeepForest: 2,
  Rocky: 3,
  Beach: 4,
  Lake: 5,
  Swamp: 6,
  Town: 7,
  Farmland: 8,
  Road: 9,
} as const;

export type BiomeId = (typeof Biome)[keyof typeof Biome];

export interface BiomeProps {
  name: string;
  /** Temperature offset in degrees Celsius relative to the seasonal baseline. */
  temperatureOffset: number;
  /** Multiplier on zombie spawn weight. */
  zombieWeight: number;
  /** Multiplier on animal spawn weight. */
  animalWeight: number;
  /** Multiplier on resource-node density. */
  resourceWeight: number;
}

export const BIOME_PROPS: Readonly<Record<number, BiomeProps>> = {
  [Biome.Grassland]: {
    name: 'Grassland',
    temperatureOffset: 0,
    zombieWeight: 0.6,
    animalWeight: 1.2,
    resourceWeight: 0.7,
  },
  [Biome.Forest]: {
    name: 'Forest',
    temperatureOffset: -1,
    zombieWeight: 0.7,
    animalWeight: 1.5,
    resourceWeight: 1.6,
  },
  [Biome.DeepForest]: {
    name: 'Deep Forest',
    temperatureOffset: -2,
    zombieWeight: 0.9,
    animalWeight: 1.8,
    resourceWeight: 2.2,
  },
  [Biome.Rocky]: {
    name: 'Rocky Hills',
    temperatureOffset: -2,
    zombieWeight: 0.5,
    animalWeight: 0.6,
    resourceWeight: 1.8,
  },
  [Biome.Beach]: {
    name: 'Beach',
    temperatureOffset: 1,
    zombieWeight: 0.3,
    animalWeight: 0.5,
    resourceWeight: 0.4,
  },
  [Biome.Lake]: {
    name: 'Lake',
    temperatureOffset: -1,
    zombieWeight: 0.1,
    animalWeight: 0.8,
    resourceWeight: 0.3,
  },
  [Biome.Swamp]: {
    name: 'Swamp',
    temperatureOffset: 1,
    zombieWeight: 1.1,
    animalWeight: 0.9,
    resourceWeight: 1.1,
  },
  [Biome.Town]: {
    name: 'Town',
    temperatureOffset: 1,
    zombieWeight: 3.2,
    animalWeight: 0.2,
    resourceWeight: 0.5,
  },
  [Biome.Farmland]: {
    name: 'Farmland',
    temperatureOffset: 0,
    zombieWeight: 0.8,
    animalWeight: 1.1,
    resourceWeight: 0.8,
  },
  [Biome.Road]: {
    name: 'Road',
    temperatureOffset: 1,
    zombieWeight: 1.4,
    animalWeight: 0.3,
    resourceWeight: 0.2,
  },
};

export function biomeProps(biome: number): BiomeProps {
  return BIOME_PROPS[biome] ?? BIOME_PROPS[Biome.Grassland]!;
}
