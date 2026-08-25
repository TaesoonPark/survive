import type {
  AnimalState,
  ItemEntityState,
  ResourceNodeState,
  StructureState,
  ZombieState,
} from './state/entities';
import type { PlayerState } from './state/player';
import type { ChunkKey } from './state/ids';
import type { TileOverride, WeatherState } from './state/world';
import type { RngState } from './rng';

/**
 * On-disk shapes.
 *
 * Static terrain is never saved: it regenerates from the seed. Only the *dynamic*
 * layer is written (spec section 29), chunk by chunk (section 30), through the
 * repository abstraction (section 31). Single-player and dedicated servers use the
 * identical format so a world can be moved between them (section 32).
 */

/** Format version. Bumped whenever a migration is needed. */
export const SAVE_FORMAT_VERSION = 1;

/** Everything dynamic inside one chunk. */
export interface ChunkDynamicPayload {
  key: ChunkKey;
  cx: number;
  cy: number;
  /** Save format version this chunk was written with. */
  version: number;
  /** True once one-time content generation has run for this chunk. */
  populated: boolean;
  /** Tiles changed away from their generated value. */
  overrides: TileOverride[];
  structures: StructureState[];
  nodes: ResourceNodeState[];
  items: ItemEntityState[];
  zombies: ZombieState[];
  animals: AnimalState[];
  /** Next tick this chunk may roll a spawn, preserved so saves are not exploitable. */
  nextSpawnTick: number;
}

export function createEmptyChunkPayload(
  key: ChunkKey,
  cx: number,
  cy: number,
): ChunkDynamicPayload {
  return {
    key,
    cx,
    cy,
    version: SAVE_FORMAT_VERSION,
    populated: false,
    overrides: [],
    structures: [],
    nodes: [],
    items: [],
    zombies: [],
    animals: [],
    nextSpawnTick: 0,
  };
}

/** One player's persisted character. */
export interface PlayerSavePayload {
  version: number;
  player: PlayerState;
  /** Wall-clock ms of the last save, for the "last played" display only. */
  savedAtMs: number;
}

/** World-level metadata: the bits that are not per-chunk and not per-player. */
export interface WorldMetaPayload {
  version: number;
  name: string;
  seed: number;
  tick: number;
  /** Full serialized world clock state is derived from `tick`; weather is not. */
  weather: WeatherState;
  rng: RngState;
  nextId: number;
  /** Wall-clock ms the world was created. Display only. */
  createdAtMs: number;
  savedAtMs: number;
  /** Total ticks simulated across all sessions. */
  totalTicks: number;
}

/** Summary shown in the "load world" list. */
export interface WorldSummary {
  name: string;
  seed: number;
  tick: number;
  day: number;
  savedAtMs: number;
  playerCount: number;
  sizeBytes: number;
}
