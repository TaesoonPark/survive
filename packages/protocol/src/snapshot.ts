import type { SimEvent } from './events';
import type { ItemStack } from './state/item';
import type { PlayerState } from './state/player';
import type {
  AnimalAiState,
  ResourceNodeState,
  StructureState,
  ZombieAiState,
} from './state/entities';
import type { EntityId, ChunkKey } from './state/ids';
import type { WeatherState, WorldTimeState } from './state/world';

/**
 * Area-of-interest replication payloads.
 *
 * The server sends each client only what is near it (spec section 21). Own player
 * state goes out in full; other entities go out as slim projections that carry only
 * what a renderer needs. Every projection carries `rev`, so the server can skip
 * entities that have not changed since the client's last acknowledged snapshot.
 */

/** Another player, as seen by this client. No inventory, no skills, no secrets. */
export interface RemotePlayerSnapshot {
  id: EntityId;
  name: string;
  x: number;
  y: number;
  facing: number;
  aimAngle: number;
  health: number;
  maxHealth: number;
  moveMode: string;
  alive: boolean;
  /** Item in the main hand, so the client can draw the right weapon. */
  heldDefId?: string;
  /** Worn armour, for the paper-doll sprite. */
  headDefId?: string;
  chestDefId?: string;
  legsDefId?: string;
  /** True while the player is swinging, for animation triggering. */
  attacking: boolean;
  rev: number;
}

export interface ZombieSnapshot {
  id: EntityId;
  defId: string;
  x: number;
  y: number;
  facing: number;
  health: number;
  maxHealth: number;
  ai: ZombieAiState;
  crawling: boolean;
  attacking: boolean;
  rev: number;
}

export interface AnimalSnapshot {
  id: EntityId;
  defId: string;
  x: number;
  y: number;
  facing: number;
  health: number;
  maxHealth: number;
  ai: AnimalAiState;
  rev: number;
}

export interface ItemEntitySnapshot {
  id: EntityId;
  x: number;
  y: number;
  stack: ItemStack;
  rev: number;
}

export interface ProjectileSnapshot {
  id: EntityId;
  defId: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  rev: number;
}

/** Tagged union of everything the AOI stream can carry. */
export type EntitySnapshot =
  | ({ k: 'player' } & RemotePlayerSnapshot)
  | ({ k: 'zombie' } & ZombieSnapshot)
  | ({ k: 'animal' } & AnimalSnapshot)
  | ({ k: 'item' } & ItemEntitySnapshot)
  | ({ k: 'projectile' } & ProjectileSnapshot)
  /** Structures change rarely, so they ship whole. */
  | ({ k: 'structure' } & StructureState)
  | ({ k: 'node' } & ResourceNodeState);

export type EntitySnapshotKind = EntitySnapshot['k'];

/** Contents of the container the player currently has open. */
export interface OpenContainerView {
  structureId: EntityId;
  defId: string;
  slots: (ItemStack | null)[];
  capacity: number;
}

/** One authoritative world update for one client. */
export interface WorldSnapshot {
  tick: number;
  /** Server wall-clock at send time, in ms. Only used for latency estimation. */
  serverTimeMs: number;
  /** Highest input sequence the server has consumed for this client. */
  ackSeq: number;
  /** Full state of the receiving player. */
  self: PlayerState;
  /** Entities inside the client's area of interest that changed. */
  entities: EntitySnapshot[];
  /** Entities that left the area of interest or were destroyed. */
  removed: EntityId[];
  time: WorldTimeState;
  weather: WeatherState;
  container?: OpenContainerView;
  /** True while the simulation is paused (single-player only). */
  paused: boolean;
}

/** Static terrain for one chunk, sent once when a client comes into range. */
export interface ChunkPayload {
  key: ChunkKey;
  cx: number;
  cy: number;
  /** Row-major tile ids, CHUNK_TILE_COUNT entries. */
  tiles: number[];
  /** Row-major biome ids, CHUNK_TILE_COUNT entries. */
  biomes: number[];
  version: number;
}

/** Events for one tick, already filtered to this client's area of interest. */
export interface EventBatch {
  tick: number;
  events: SimEvent[];
}

/** World identity, sent once on join. */
export interface WorldInfo {
  name: string;
  seed: number;
  tileSize: number;
  chunkTiles: number;
  worldChunks: number;
  /** Tick the world was created at, always 0 for a fresh world. */
  createdTick: number;
}
