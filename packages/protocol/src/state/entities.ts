import type { BodyState } from './body';
import type { CraftJobState } from './crafting';
import type { ItemStack } from './item';
import type {
  AnimalDefId,
  ChunkKey,
  CropDefId,
  EntityId,
  LootTableId,
  PlayerId,
  ProjectileDefId,
  ResourceNodeDefId,
  StructureDefId,
  ZombieDefId,
} from './ids';

/** Every replicated entity kind. Used as the snapshot discriminator. */
export type EntityKind =
  'player' | 'zombie' | 'animal' | 'item' | 'projectile' | 'structure' | 'node';

// ---------------------------------------------------------------------------
// Zombies
// ---------------------------------------------------------------------------

/**
 * Zombie AI states, in escalating order of awareness (spec section 22).
 * The update frequency of a zombie is derived from this plus its LOD tier.
 */
export type ZombieAiState =
  | 'dormant'
  | 'idle'
  | 'wander'
  | 'alerted'
  | 'investigate'
  | 'pursue'
  | 'attack'
  | 'stagger'
  | 'dead';

/**
 * Simulation level of detail. 0 is closest/most expensive.
 * Tier is a function of distance to the nearest player and current AI state.
 */
export type LodTier = 0 | 1 | 2 | 3;

export interface ZombieState {
  id: EntityId;
  /**
   * Tick this zombie died, for the corpse reaper. Absent while it is alive.
   *
   * A corpse used to stay in the world forever. That is not scenery, it is a leak with
   * gameplay consequences: the per-chunk population census counts every record with a
   * matching `homeChunk` regardless of whether it is breathing, so a chunk a player had
   * fought in stopped spawning - and the same census governs animals, so a hunted-out
   * chunk stopped regrowing wildlife. `lod.ts` already described the intended behaviour
   * ("a corpse only wakes up to be cleaned away"); nothing implemented it.
   */
  deadTick?: number;
  defId: ZombieDefId;
  x: number;
  y: number;
  vx: number;
  vy: number;
  facing: number;
  health: number;
  maxHealth: number;

  ai: ZombieAiState;
  lod: LodTier;
  /** Next tick this zombie's AI brain runs. Movement still runs at fixed rate. */
  nextThinkTick: number;

  /** Current chase target, if any. */
  targetId?: EntityId;
  /** Last position the target was seen at; the zombie walks here after losing sight. */
  lastSeenX?: number;
  lastSeenY?: number;
  /** Point of interest from a heard noise. */
  investigateX?: number;
  investigateY?: number;
  /** Tick at which an unconfirmed investigation is abandoned. */
  loseInterestTick: number;

  attackReadyTick: number;
  staggerUntilTick: number;

  /** Chunk the zombie was spawned in, for population accounting. */
  homeChunk: ChunkKey;
  /** Anchor for wandering so idle zombies do not drift across the map. */
  homeX: number;
  homeY: number;

  /** Limb damage: shoot the legs off and the zombie starts crawling. */
  body: BodyState;
  crawling: boolean;

  /** Horde membership, so groups can share a path. */
  hordeId?: string;

  /** Flattened tile path `[tx0, ty0, tx1, ty1, ...]`, or empty when unpathed. */
  path: number[];
  pathIndex: number;
  /** Tick the path was computed; stale paths get recomputed. */
  pathTick: number;

  rev: number;
}

// ---------------------------------------------------------------------------
// Animals (hunting, and a few things that hunt back)
// ---------------------------------------------------------------------------

export type AnimalAiState =
  'idle' | 'graze' | 'wander' | 'alert' | 'flee' | 'stalk' | 'attack' | 'dead';

export interface AnimalState {
  id: EntityId;
  /**
   * Tick this animal died, for the corpse reaper. Absent while it is alive.
   *
   * A corpse used to stay in the world forever. That is not scenery, it is a leak with
   * gameplay consequences: the per-chunk population census counts every record with a
   * matching `homeChunk` regardless of whether it is breathing, so a chunk a player had
   * fought in stopped spawning - and the same census governs animals, so a hunted-out
   * chunk stopped regrowing wildlife. `lod.ts` already described the intended behaviour
   * ("a corpse only wakes up to be cleaned away"); nothing implemented it.
   */
  deadTick?: number;
  defId: AnimalDefId;
  x: number;
  y: number;
  vx: number;
  vy: number;
  facing: number;
  health: number;
  maxHealth: number;
  ai: AnimalAiState;
  lod: LodTier;
  nextThinkTick: number;
  targetId?: EntityId;
  fleeUntilTick: number;
  attackReadyTick: number;
  homeChunk: ChunkKey;
  homeX: number;
  homeY: number;
  wanderX: number;
  wanderY: number;
  rev: number;
}

// ---------------------------------------------------------------------------
// Ground items
// ---------------------------------------------------------------------------

export interface ItemEntityState {
  id: EntityId;
  x: number;
  y: number;
  stack: ItemStack;
  droppedTick: number;
  /** Tick at which the item disappears. -1 means it never despawns. */
  despawnTick: number;
  /** Player who dropped it; used for short-lived pickup priority. */
  droppedBy?: PlayerId;
  rev: number;
}

// ---------------------------------------------------------------------------
// Projectiles
// ---------------------------------------------------------------------------

export interface ProjectileState {
  id: EntityId;
  defId: ProjectileDefId;
  x: number;
  y: number;
  /** Position at the start of the current tick, so hit tests can sweep the segment. */
  prevX: number;
  prevY: number;
  vx: number;
  vy: number;
  ownerId: EntityId;
  /**
   * Whether the owner was a player when the shot was fired.
   *
   * Recorded rather than looked up. `state.players` loses an entry the instant a socket
   * closes, so asking "is the owner a player?" mid-flight answered *no* for a round fired
   * by someone who has since disconnected - and a round with no player owner is treated
   * like a zombie's, hitting other players at full damage on a server with PvP off. The
   * client chooses when to disconnect, so the client was choosing whether friendly fire
   * applied. Absent on projectiles from an older save, which fall back to the lookup.
   */
  ownerWasPlayer?: boolean;
  /** Weapon that fired it, for damage attribution and skill XP. */
  weaponDefId?: string;
  damage: number;
  /** Fraction of armour ignored, 0..1. */
  armorPen: number;
  /** Distance travelled so far, px. Used for range falloff and despawn. */
  travelled: number;
  maxRange: number;
  /** How many more entities this projectile may pass through. */
  pierceLeft: number;
  spawnTick: number;
  rev: number;
}

// ---------------------------------------------------------------------------
// Structures: everything placed on the tile grid, generated or player-built
// ---------------------------------------------------------------------------

export interface DoorSubState {
  open: boolean;
  locked: boolean;
  /** Lock code; only the owner and anyone told the code can open it. */
  code?: string;
}

export interface ContainerSubState {
  slots: (ItemStack | null)[];
  capacity: number;
  /** Loot table to roll the first time a player opens it. */
  lootTableId?: LootTableId;
  /** Set once the loot table has been rolled. */
  rolled: boolean;
  /** Players currently viewing this container, so the server can push updates. */
  viewers: PlayerId[];
}

export interface StationSubState {
  /** Whether a fuel-burning station is currently lit. */
  lit: boolean;
  fuel: number;
  maxFuel: number;
  /** Heat output, drives cooking speed and warmth. */
  heat: number;
  jobs: CraftJobState[];
}

/** A crop growing in a farm plot. */
export interface CropSubState {
  defId: CropDefId;
  plantedTick: number;
  /** Current growth stage index, 0-based. */
  stage: number;
  /** Progress towards the next stage, 0..1. */
  stageProgress: number;
  /** Soil water available to this plant, 0..100. */
  water: number;
  /** Plant health, 0..100. Falls when dry, frozen or diseased. */
  health: number;
  /** Disease progression, 0..100. */
  blight: number;
  /** Remaining fertilizer boost, in ticks. */
  fertilizedTicks: number;
  /** Ratoon crops (e.g. tomatoes) can be picked more than once. */
  harvestsLeft: number;
  /** Set when the crop died. It can still be cleared for a little fibre. */
  dead: boolean;
}

export interface PlotSubState {
  tilled: boolean;
  /** Soil moisture, 0..100. Rain and watering raise it; sun lowers it. */
  moisture: number;
  /** Soil fertility, 0..100. Harvesting depletes it; compost restores it. */
  fertility: number;
  crop?: CropSubState;
}

export interface LightSubState {
  on: boolean;
  fuel: number;
  /** Light radius in pixels. */
  radius: number;
}

export interface BedSubState {
  occupantId?: PlayerId;
  /** Tick sleeping started, for the fast-forward calculation. */
  sleepStartTick: number;
}

/**
 * A placed structure. One row of the tile grid's object layer.
 *
 * Anything buildable, lootable, openable or farmable is a structure, distinguished
 * by which optional sub-state it carries. That keeps the collision grid, damage model
 * and persistence uniform across walls, chests, campfires and farm plots.
 */
export interface StructureState {
  id: EntityId;
  defId: StructureDefId;
  /** Tile coordinates of the structure's origin (top-left for multi-tile pieces). */
  tileX: number;
  tileY: number;
  /** Rotation index, 0..3, in 90-degree steps. */
  rotation: number;
  health: number;
  maxHealth: number;
  /** Player who built it. Absent for world-generated structures. */
  ownerId?: PlayerId;
  builtTick: number;
  /** Build progress, 0..1. Below 1 the structure is a blueprint frame. */
  progress: number;

  door?: DoorSubState;
  container?: ContainerSubState;
  station?: StationSubState;
  plot?: PlotSubState;
  light?: LightSubState;
  bed?: BedSubState;

  rev: number;
}

// ---------------------------------------------------------------------------
// Resource nodes: trees, rocks, ore, bushes, water
// ---------------------------------------------------------------------------

export interface ResourceNodeState {
  id: EntityId;
  defId: ResourceNodeDefId;
  x: number;
  y: number;
  tileX: number;
  tileY: number;
  health: number;
  maxHealth: number;
  /** Times harvested since the last full regrowth. */
  harvests: number;
  depleted: boolean;
  /** Tick the node regrows, or -1 if it never does. */
  respawnAtTick: number;
  /** Visual variant index, so a forest is not identical trees. */
  variant: number;
  rev: number;
}
