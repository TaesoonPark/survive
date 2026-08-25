import type { ChunkKey } from './ids';

export type Season = 'spring' | 'summer' | 'autumn' | 'winter';

export const SEASONS: readonly Season[] = ['spring', 'summer', 'autumn', 'winter'];

/** Derived world clock. Recomputed from `tick` every simulation step. */
export interface WorldTimeState {
  /** Absolute simulation tick. The single source of truth; everything else derives. */
  tick: number;
  /** Day number since world creation, starting at 1. */
  day: number;
  /** 0..23 */
  hour: number;
  /** 0..59 */
  minute: number;
  season: Season;
  /** Year number, starting at 1. */
  year: number;
  /** Progress through the current day, 0..1. */
  dayProgress: number;
  isNight: boolean;
  /** Ambient light, 0 (pitch dark) .. 1 (noon). Drives rendering and stealth. */
  lightLevel: number;
}

export type WeatherType = 'clear' | 'cloudy' | 'overcast' | 'rain' | 'storm' | 'fog' | 'snow';

export const WEATHER_TYPES: readonly WeatherType[] = [
  'clear',
  'cloudy',
  'overcast',
  'rain',
  'storm',
  'fog',
  'snow',
];

export interface WeatherState {
  type: WeatherType;
  /** 0..1 severity within the type. */
  intensity: number;
  /** Ambient air temperature in degrees Celsius. */
  temperature: number;
  /** Wind direction in radians. */
  windAngle: number;
  /** Wind speed, px/second equivalent (used for particle drift and fire spread). */
  windSpeed: number;
  /** Tick at which the current weather rolls over. */
  nextChangeTick: number;
  /** Set for one tick when lightning strikes, so clients can flash. */
  lightning: boolean;
}

/** Integer chunk coordinate. */
export interface ChunkCoord {
  cx: number;
  cy: number;
}

/**
 * Static terrain for one chunk.
 *
 * Never persisted: it is a pure function of the world seed and the chunk coordinate
 * (spec section 29). Only {@link ChunkDynamicState} is written to disk.
 */
export interface ChunkTerrain {
  cx: number;
  cy: number;
  /** CHUNK_TILE_COUNT tile ids, row-major. */
  tiles: number[];
  /** CHUNK_TILE_COUNT biome ids, row-major. */
  biomes: number[];
  /** Generator version, so saves can be migrated when generation changes. */
  version: number;
}

/** A single tile changed away from its generated value (tilled soil, broken road). */
export interface TileOverride {
  /** Index into the chunk's row-major tile array. */
  index: number;
  tile: number;
}

/** Which chunk simulation tier a chunk is currently in. */
export type ChunkActivity = 'active' | 'low' | 'dormant';

/** Runtime bookkeeping for a loaded chunk. */
export interface ChunkRuntimeState {
  key: ChunkKey;
  cx: number;
  cy: number;
  activity: ChunkActivity;
  /** Tick the chunk was last inside some player's load radius. */
  lastTouchedTick: number;
  /** Tick the chunk was last simulated (low-frequency chunks catch up in bulk). */
  lastSimulatedTick: number;
  /** True once one-time content (nodes, loot, spawns) has been generated. */
  populated: boolean;
  /** Set when something changed and the chunk needs saving. */
  dirty: boolean;
  /** Next tick this chunk may roll a zombie spawn. */
  nextSpawnTick: number;
}
