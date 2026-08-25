import type { BodyState } from './body';
import type { CraftJobState } from './crafting';
import type { StatusEffectState } from './effects';
import type { EquipmentState, InventoryState } from './item';
import type { EntityId, PlayerId, StructureDefId } from './ids';
import type { SkillsState } from './skills';

/** How the player is currently moving. Affects speed, stamina and noise. */
export type MoveMode = 'walk' | 'run' | 'crouch';

/** Lifetime counters, shown on the death screen and used by achievements. */
export interface PlayerStats {
  zombieKills: number;
  animalKills: number;
  playerKills: number;
  deaths: number;
  daysSurvived: number;
  distanceTravelled: number;
  itemsCrafted: number;
  structuresBuilt: number;
  cropsHarvested: number;
  resourcesGathered: number;
}

export function createPlayerStats(): PlayerStats {
  return {
    zombieKills: 0,
    animalKills: 0,
    playerKills: 0,
    deaths: 0,
    daysSurvived: 0,
    distanceTravelled: 0,
    itemsCrafted: 0,
    structuresBuilt: 0,
    cropsHarvested: 0,
    resourcesGathered: 0,
  };
}

/**
 * Everything the server knows about a player.
 *
 * Pure data, JSON-serializable, no Phaser types anywhere near it. The client receives
 * this (its own copy in full, other players' in reduced form) and renders it.
 */
export interface PlayerState {
  id: PlayerId;
  name: string;

  /** World position in pixels. */
  x: number;
  y: number;
  /** Velocity in px/second, kept for prediction smoothing and knockback. */
  vx: number;
  vy: number;
  /** Body facing in radians; follows movement. */
  facing: number;
  /** Where the player is aiming, in radians. Independent of facing. */
  aimAngle: number;

  health: number;
  maxHealth: number;
  /** Need semantics: 0 = fed, 100 = starving. */
  hunger: number;
  /** Need semantics: 0 = hydrated, 100 = dying of thirst. */
  thirst: number;
  /** Need semantics: 0 = rested, 100 = collapsing. */
  fatigue: number;
  stamina: number;
  maxStamina: number;
  /** Core body temperature in degrees Celsius. 37 is normal. */
  temperature: number;
  /** Blood volume, 0..100. Falls while bleeding, refills slowly when fed. */
  blood: number;

  moveMode: MoveMode;
  alive: boolean;
  /** Tick of death, or -1 when alive. */
  deathTick: number;
  /** Earliest tick a respawn is allowed. */
  respawnAtTick: number;
  /** How the player died, for the death screen. */
  deathCause?: string;

  body: BodyState;

  inventory: InventoryState;
  equipment: EquipmentState;
  /** Hotbar entries hold inventory slot indices, or null for an empty hotbar slot. */
  hotbar: (number | null)[];
  /** Index into `hotbar` of the selected entry. */
  activeHotbar: number;

  skills: SkillsState;
  effects: StatusEffectState[];
  craftQueue: CraftJobState[];

  /** Structure whose container UI is open, if any. Server-validated proximity. */
  openContainerId?: EntityId;
  /** Earliest tick the player may attack again. */
  attackReadyTick: number;
  /** Earliest tick the player may use/interact again. */
  useReadyTick: number;
  /** Earliest tick the player may move again (stagger, animation lock). */
  actionLockedUntilTick: number;

  /** Ghost placement selection: what the player is about to build. */
  buildDefId?: StructureDefId;
  /** Rotation index 0..3 for the build ghost. */
  buildRotation: number;

  /** Where the player respawns. Set by sleeping in a bed. */
  spawnX: number;
  spawnY: number;
  /** Bed that owns this spawn point, if any. */
  bedStructureId?: EntityId;

  stats: PlayerStats;

  /** Total carried weight in kilograms, recomputed whenever the inventory changes. */
  carryWeight: number;
  /** Weight the player can carry before being slowed. */
  carryCapacity: number;

  /** Last input sequence number the server has consumed. Echoed for reconciliation. */
  lastInputSeq: number;

  /** Monotonic revision, bumped on every mutation. Drives snapshot deltas. */
  rev: number;
}
