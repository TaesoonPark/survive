import type { ItemDefId } from './ids';

/**
 * One stack of items, wherever it lives: player inventory, equipment slot, container
 * or on the ground. Optional fields are omitted when they do not apply, which keeps
 * snapshots small.
 */
export interface ItemStack {
  defId: ItemDefId;
  /** Always >= 1 for a live stack. A stack that reaches 0 is replaced by `null`. */
  count: number;
  /** Remaining durability points. Omitted for items that never wear out. */
  durability?: number;
  /** Freshness for perishables, 1 = just made, 0 = rotten. Omitted for non-perishables. */
  freshness?: number;
  /** Rounds currently loaded, for firearms. */
  ammo?: number;
  /** Which ammunition is loaded, for firearms. */
  ammoDefId?: ItemDefId;
  /** Crafted quality, 0..1. Scales damage/efficiency for tools and weapons. */
  quality?: number;
  /** Player-authored label (signs, marked containers). */
  label?: string;
  /** Water/fuel units held by a container item such as a bottle or canteen. */
  fill?: number;
  /** For seed packets and similar: which crop this seed grows. */
  contentDefId?: ItemDefId;
}

/** Where a piece of gear can be worn or held. */
export type EquipSlot =
  'head' | 'face' | 'chest' | 'legs' | 'feet' | 'hands' | 'back' | 'mainHand' | 'offHand';

export const EQUIP_SLOTS: readonly EquipSlot[] = [
  'head',
  'face',
  'chest',
  'legs',
  'feet',
  'hands',
  'back',
  'mainHand',
  'offHand',
];

/** Worn and held items. `null` means the slot is empty. */
export type EquipmentState = Record<EquipSlot, ItemStack | null>;

/** A fixed-size grid of slots. `slots.length` always equals `capacity`. */
export interface InventoryState {
  slots: (ItemStack | null)[];
  capacity: number;
}

/** Where an item-moving command is reading from or writing to. */
export type ContainerRef =
  | { kind: 'inventory' }
  | { kind: 'equipment'; slot: EquipSlot }
  | { kind: 'structure'; structureId: string }
  /** A container item held in an inventory slot, e.g. a backpack's own pockets. */
  | { kind: 'itemContainer'; slotIndex: number }
  /** The ground at the player's feet. Only valid as a destination. */
  | { kind: 'ground' };

export function createEmptyEquipment(): EquipmentState {
  return {
    head: null,
    face: null,
    chest: null,
    legs: null,
    feet: null,
    hands: null,
    back: null,
    mainHand: null,
    offHand: null,
  };
}

export function createEmptyInventory(capacity: number): InventoryState {
  return { slots: new Array<ItemStack | null>(capacity).fill(null), capacity };
}
