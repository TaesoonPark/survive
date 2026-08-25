import type { BodyPartId } from './state/body';
import type { ContainerRef, EquipSlot } from './state/item';
import type { CraftJobId, EntityId, ItemDefId, RecipeDefId, StructureDefId } from './state/ids';

/**
 * Client intents.
 *
 * Rule: a client says what it *tried to do*, never what happened (spec section 6).
 * "I pressed attack, aiming 37 degrees, with the axe equipped" — not "I dealt 50
 * damage to zombie 123". Every command is validated and resolved server-side.
 */

/** Button bits packed into {@link InputFrame.buttons}. */
export const Button = {
  Primary: 1 << 0,
  Secondary: 1 << 1,
  Sprint: 1 << 2,
  Crouch: 1 << 3,
  Interact: 1 << 4,
  Reload: 1 << 5,
  Block: 1 << 6,
} as const;

export type ButtonMask = number;

export function hasButton(mask: ButtonMask, button: number): boolean {
  return (mask & button) !== 0;
}

/**
 * One tick of continuous input. Sent in small batches so a dropped packet does not
 * lose a movement step (the server replays any frames it has not consumed yet).
 */
export interface InputFrame {
  /** Monotonic per-client sequence number. Echoed back for reconciliation. */
  seq: number;
  /** Horizontal intent, -1..1. */
  moveX: number;
  /** Vertical intent, -1..1. */
  moveY: number;
  /** Aim direction in radians. */
  aimAngle: number;
  buttons: ButtonMask;
}

export type FarmAction = 'till' | 'plant' | 'water' | 'fertilize' | 'harvest' | 'clear';

export type ChatChannel = 'global' | 'local' | 'system';

/** Everything a client may ask the server to do, beyond continuous input. */
export type Command =
  | { type: 'selectHotbar'; index: number }
  | { type: 'assignHotbar'; hotbarIndex: number; inventorySlot: number | null }
  | {
      type: 'moveItem';
      from: ContainerRef;
      fromIndex: number;
      to: ContainerRef;
      /** Target slot, or null to auto-place in the first slot that fits. */
      toIndex: number | null;
      /** How many to move, or null for the whole stack. */
      count: number | null;
    }
  | { type: 'splitStack'; ref: ContainerRef; index: number; count: number }
  | { type: 'sortContainer'; ref: ContainerRef }
  | { type: 'dropItem'; ref: ContainerRef; index: number; count: number | null }
  | { type: 'pickUpItem'; itemEntityId: EntityId }
  | { type: 'useItem'; ref: ContainerRef; index: number }
  | { type: 'equipItem'; inventorySlot: number; slot?: EquipSlot }
  | { type: 'unequipItem'; slot: EquipSlot }
  | { type: 'reload'; ammoDefId?: ItemDefId }
  | { type: 'interact'; targetId?: EntityId; tileX?: number; tileY?: number }
  | { type: 'gather'; nodeId: EntityId }
  | { type: 'openContainer'; structureId: EntityId }
  | { type: 'closeContainer' }
  | { type: 'takeAll'; structureId: EntityId }
  | { type: 'toggleDoor'; structureId: EntityId; code?: string }
  | { type: 'setLock'; structureId: EntityId; code: string | null }
  | { type: 'craft'; recipeId: RecipeDefId; count: number; stationId?: EntityId }
  | { type: 'cancelCraft'; jobId: CraftJobId; stationId?: EntityId }
  | { type: 'setBuildSelection'; defId: StructureDefId | null; rotation: number }
  | { type: 'build'; defId: StructureDefId; tileX: number; tileY: number; rotation: number }
  | { type: 'demolish'; structureId: EntityId }
  | { type: 'repair'; structureId: EntityId }
  | { type: 'farm'; action: FarmAction; tileX: number; tileY: number; seedDefId?: ItemDefId }
  | { type: 'refuel'; structureId: EntityId; inventorySlot: number }
  | { type: 'ignite'; structureId: EntityId }
  | { type: 'extinguish'; structureId: EntityId }
  | { type: 'treat'; ref: ContainerRef; index: number; bodyPart: BodyPartId }
  | { type: 'sleep'; structureId: EntityId }
  | { type: 'wake' }
  | { type: 'respawn'; atBed: boolean }
  | { type: 'chat'; text: string; channel: ChatChannel }
  | { type: 'setPaused'; paused: boolean }
  | { type: 'setSpawnPoint'; structureId: EntityId }
  | { type: 'debug'; action: string; args?: Record<string, number | string | boolean> };

export type CommandType = Command['type'];

/** Narrow a {@link Command} to one variant. */
export type CommandOf<T extends CommandType> = Extract<Command, { type: T }>;

/** A command as the simulation sees it: intent plus who sent it and when. */
export interface QueuedCommand {
  playerId: string;
  tick: number;
  command: Command;
}
