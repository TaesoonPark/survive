import type { BodyPartId } from './state/body';
import type { ItemStack } from './state/item';
import type { SkillId } from './state/skills';
import type { StatusEffectId } from './state/effects';
import type { WeatherType } from './state/world';
import type { EntityId, ItemDefId, PlayerId, RecipeDefId, StructureDefId } from './state/ids';

/**
 * Things that happened during a tick.
 *
 * Events are the simulation's outbound narration. They drive client effects (sound,
 * particles, floating numbers, toasts), server logging, and assertions in tests -
 * without any of those needing to diff state. They are never load-bearing for
 * correctness: a client that drops every event still ends up in the right state.
 */

/** Why damage was dealt, for resistance lookups and UI colouring. */
export type DamageType =
  | 'blunt'
  | 'slash'
  | 'pierce'
  | 'bullet'
  | 'explosive'
  | 'fire'
  | 'bleed'
  | 'infection'
  | 'starvation'
  | 'dehydration'
  | 'exhaustion'
  | 'cold'
  | 'heat'
  | 'fall'
  | 'poison'
  | 'zombieBite'
  | 'suffocation';

/**
 * A message for the player, as a key and its values rather than a finished sentence.
 *
 * The simulation used to send prose: `Added 3 x Wood Log to the campfire.` That works
 * exactly once, in English. Word order, pluralisation and where the number goes are all
 * decisions the *reader's* language makes, and a server that has already assembled the
 * sentence has taken them away - so a translated client could do nothing with it.
 *
 * `code` names the sentence; `params` fills its blanks. The client owns the wording, which
 * is also the only place that knows which language to word it in.
 */
export interface LocalizedMessage {
  code: string;
  params?: Record<string, string | number>;
}

export type SimEvent =
  // --- combat ------------------------------------------------------------
  | {
      type: 'attackSwing';
      attackerId: EntityId;
      weaponDefId?: ItemDefId;
      angle: number;
      x: number;
      y: number;
      /** True if the swing connected with at least one target. */
      hit: boolean;
    }
  | {
      type: 'damage';
      targetId: EntityId;
      attackerId?: EntityId;
      amount: number;
      damageType: DamageType;
      bodyPart?: BodyPartId;
      critical: boolean;
      /** Damage absorbed by armour. */
      blocked: number;
      x: number;
      y: number;
      remainingHealth: number;
    }
  | { type: 'heal'; targetId: EntityId; amount: number; bodyPart?: BodyPartId }
  | {
      type: 'death';
      entityId: EntityId;
      killerId?: EntityId;
      cause: DamageType | string;
      x: number;
      y: number;
    }
  | { type: 'knockback'; entityId: EntityId; vx: number; vy: number }
  | { type: 'block'; defenderId: EntityId; attackerId?: EntityId; absorbed: number }
  | {
      type: 'projectileFired';
      projectileId: EntityId;
      ownerId: EntityId;
      x: number;
      y: number;
      angle: number;
      defId: string;
    }
  | { type: 'projectileHit'; projectileId: EntityId; targetId?: EntityId; x: number; y: number }
  | { type: 'weaponBroke'; ownerId: EntityId; defId: ItemDefId }
  | { type: 'reloaded'; ownerId: EntityId; weaponDefId: ItemDefId; rounds: number }
  | { type: 'outOfAmmo'; ownerId: EntityId; weaponDefId: ItemDefId }

  // --- injury / survival -------------------------------------------------
  | { type: 'bleedingStarted'; entityId: EntityId; bodyPart: BodyPartId; rate: number }
  | { type: 'bleedingStopped'; entityId: EntityId; bodyPart: BodyPartId }
  | { type: 'fractured'; entityId: EntityId; bodyPart: BodyPartId }
  | { type: 'bitten'; entityId: EntityId; bodyPart: BodyPartId }
  | { type: 'infectionChanged'; entityId: EntityId; bodyPart: BodyPartId; value: number }
  | {
      type: 'treated';
      entityId: EntityId;
      bodyPart: BodyPartId;
      itemDefId: ItemDefId;
      success: boolean;
    }
  | {
      type: 'effectApplied';
      entityId: EntityId;
      effect: StatusEffectId;
      magnitude: number;
      durationTicks: number;
    }
  | { type: 'effectExpired'; entityId: EntityId; effect: StatusEffectId }
  | { type: 'ateFood'; playerId: PlayerId; itemDefId: ItemDefId; nutrition: number }
  | { type: 'drank'; playerId: PlayerId; itemDefId: ItemDefId; hydration: number }
  | { type: 'sleepStarted'; playerId: PlayerId; structureId: EntityId }
  | { type: 'sleepEnded'; playerId: PlayerId; ticksSlept: number }

  // --- items -------------------------------------------------------------
  | { type: 'itemPickedUp'; playerId: PlayerId; stack: ItemStack }
  | { type: 'itemDropped'; playerId: PlayerId; stack: ItemStack; x: number; y: number }
  | { type: 'itemMoved'; playerId: PlayerId; defId: ItemDefId; count: number }
  | { type: 'itemSpoiled'; entityId: EntityId; defId: ItemDefId }
  | { type: 'containerOpened'; playerId: PlayerId; structureId: EntityId }
  | { type: 'containerClosed'; playerId: PlayerId; structureId: EntityId }
  | { type: 'lootRolled'; structureId: EntityId; items: number }

  // --- crafting ----------------------------------------------------------
  | { type: 'craftQueued'; playerId: PlayerId; recipeId: RecipeDefId; count: number }
  | { type: 'craftProgress'; playerId: PlayerId; recipeId: RecipeDefId; progress: number }
  | { type: 'craftCompleted'; playerId: PlayerId; recipeId: RecipeDefId; output: ItemStack }
  | { type: 'craftFailed'; playerId: PlayerId; recipeId: RecipeDefId; reason: string }
  | { type: 'craftCancelled'; playerId: PlayerId; recipeId: RecipeDefId }

  // --- building ----------------------------------------------------------
  | {
      type: 'structurePlaced';
      structureId: EntityId;
      defId: StructureDefId;
      tileX: number;
      tileY: number;
      builderId?: PlayerId;
    }
  | { type: 'structureDamaged'; structureId: EntityId; amount: number; remainingHealth: number }
  | {
      type: 'structureDestroyed';
      structureId: EntityId;
      defId: StructureDefId;
      tileX: number;
      tileY: number;
    }
  | { type: 'structureRepaired'; structureId: EntityId; amount: number }
  | { type: 'structureDemolished'; structureId: EntityId; refund: ItemStack[] }
  | { type: 'buildRejected'; playerId: PlayerId; defId: StructureDefId; reason: string }
  | { type: 'doorToggled'; structureId: EntityId; open: boolean; byId?: EntityId }
  | { type: 'stationLit'; structureId: EntityId; lit: boolean }

  // --- gathering ---------------------------------------------------------
  | {
      type: 'nodeHarvested';
      nodeId: EntityId;
      playerId: PlayerId;
      yields: ItemStack[];
      remainingHealth: number;
    }
  | { type: 'nodeDepleted'; nodeId: EntityId; defId: string; x: number; y: number }
  | { type: 'nodeRespawned'; nodeId: EntityId }
  | { type: 'toolIneffective'; playerId: PlayerId; nodeId: EntityId; requiredTool: string }

  // --- farming -----------------------------------------------------------
  | { type: 'plotTilled'; structureId: EntityId; tileX: number; tileY: number }
  | { type: 'cropPlanted'; structureId: EntityId; cropDefId: string }
  | { type: 'cropWatered'; structureId: EntityId; moisture: number }
  | { type: 'cropFertilized'; structureId: EntityId }
  | { type: 'cropStageAdvanced'; structureId: EntityId; stage: number }
  | { type: 'cropHarvested'; structureId: EntityId; playerId: PlayerId; yields: ItemStack[] }
  | { type: 'cropDied'; structureId: EntityId; reason: string }
  | { type: 'cropBlighted'; structureId: EntityId }

  // --- AI / world --------------------------------------------------------
  | { type: 'noise'; x: number; y: number; radius: number; loudness: number; sourceId?: EntityId }
  | { type: 'zombieSpawned'; zombieId: EntityId; defId: string; x: number; y: number }
  | { type: 'zombieAlerted'; zombieId: EntityId; targetId?: EntityId; x: number; y: number }
  | { type: 'hordeFormed'; hordeId: string; size: number; x: number; y: number }
  | { type: 'animalSpawned'; animalId: EntityId; defId: string; x: number; y: number }
  | { type: 'weatherChanged'; weather: WeatherType; intensity: number; temperature: number }
  | { type: 'dayPassed'; day: number; season: string; year: number }
  | { type: 'lightning'; x: number; y: number }

  // --- progression / session --------------------------------------------
  | { type: 'skillXp'; playerId: PlayerId; skill: SkillId; amount: number }
  | { type: 'levelUp'; playerId: PlayerId; skill: SkillId; level: number }
  | { type: 'playerJoined'; playerId: PlayerId; name: string }
  | { type: 'playerLeft'; playerId: PlayerId; name: string }
  | { type: 'playerRespawned'; playerId: PlayerId; x: number; y: number }
  | { type: 'chat'; playerId?: PlayerId; name: string; text: string; channel: string }
  | {
      type: 'notification';
      playerId?: PlayerId;
      severity: 'info' | 'warn' | 'error' | 'success';
      message: LocalizedMessage;
    }
  | { type: 'commandRejected'; playerId: PlayerId; command: string; reason: string };

export type SimEventType = SimEvent['type'];

export type SimEventOf<T extends SimEventType> = Extract<SimEvent, { type: T }>;

/**
 * Which entity, if any, an event is "about". Used by area-of-interest filtering to
 * decide whether a given client should receive it.
 */
export function eventPosition(event: SimEvent): { x: number; y: number } | null {
  if ('x' in event && 'y' in event && typeof event.x === 'number' && typeof event.y === 'number') {
    return { x: event.x, y: event.y };
  }
  return null;
}

/** Events addressed to exactly one player (private feedback, never broadcast). */
export function eventTargetPlayer(event: SimEvent): PlayerId | undefined {
  if ('playerId' in event && typeof event.playerId === 'string') {
    switch (event.type) {
      case 'craftQueued':
      case 'craftProgress':
      case 'craftCompleted':
      case 'craftFailed':
      case 'craftCancelled':
      case 'buildRejected':
      case 'commandRejected':
      case 'notification':
      case 'skillXp':
      case 'levelUp':
      case 'toolIneffective':
      case 'itemMoved':
        return event.playerId;
      default:
        return undefined;
    }
  }
  return undefined;
}
