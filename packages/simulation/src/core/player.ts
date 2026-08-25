import {
  BASE_INVENTORY_SLOTS,
  HOTBAR_SLOTS,
  createBody,
  createEmptyEquipment,
  createEmptyInventory,
  createPlayerStats,
  createSkills,
  type PlayerId,
  type PlayerState,
  type SimulationConfig,
} from '@survive/protocol';
import type { GameData } from '@survive/game-data';
import { addToInventory, createStack, recomputeCarryWeight } from './items';

/**
 * What a fresh character starts with. Deliberately meagre, but not inert.
 *
 * The materials are here because the kit used to be tool-and-food only, which left a new
 * character unable to craft anything at all: every hand recipe needs fibre, sticks, stone
 * or flint, and gathering the first of those needs a tool you have exactly one of. The
 * amounts are sized to afford *one* choice, not a full set - enough for a second tool or a
 * first weapon, and then you are gathering. `startingKitAffords` in the tests holds that
 * line so a recipe cost change cannot quietly make this dead weight again.
 *
 * Sticks and fibre come in a little over the single-recipe minimum so a first attempt can
 * be spent on a torch or a bandage without stranding the player.
 */
export const STARTING_KIT: ReadonlyArray<{ defId: string; count: number }> = [
  { defId: 'stone_hatchet', count: 1 },
  { defId: 'cloth_rag', count: 2 },
  { defId: 'berry', count: 3 },
  { defId: 'water_bottle', count: 1 },
  { defId: 'plant_fiber', count: 8 },
  { defId: 'stick', count: 4 },
  { defId: 'stone', count: 2 },
  { defId: 'flint', count: 1 },
];

export interface CreatePlayerOptions {
  id: PlayerId;
  name: string;
  x: number;
  y: number;
  /** Skip the starting kit, e.g. for test fixtures that set up their own inventory. */
  withoutKit?: boolean;
}

/** Build a brand-new character. */
export function createPlayerState(
  data: GameData,
  _config: SimulationConfig,
  options: CreatePlayerOptions,
): PlayerState {
  const player: PlayerState = {
    id: options.id,
    name: options.name,
    x: options.x,
    y: options.y,
    vx: 0,
    vy: 0,
    facing: 0,
    aimAngle: 0,
    health: 100,
    maxHealth: 100,
    hunger: 15,
    thirst: 15,
    fatigue: 5,
    stamina: 100,
    maxStamina: 100,
    temperature: 37,
    blood: 100,
    moveMode: 'walk',
    alive: true,
    deathTick: -1,
    respawnAtTick: -1,
    body: createBody(),
    inventory: createEmptyInventory(BASE_INVENTORY_SLOTS),
    equipment: createEmptyEquipment(),
    hotbar: new Array<number | null>(HOTBAR_SLOTS).fill(null),
    activeHotbar: 0,
    skills: createSkills(),
    effects: [],
    craftQueue: [],
    attackReadyTick: 0,
    useReadyTick: 0,
    actionLockedUntilTick: 0,
    buildRotation: 0,
    spawnX: options.x,
    spawnY: options.y,
    stats: createPlayerStats(),
    carryWeight: 0,
    carryCapacity: 30,
    lastInputSeq: 0,
    rev: 1,
  };

  if (!options.withoutKit) {
    for (const entry of STARTING_KIT) {
      if (!data.items.has(entry.defId)) continue;
      const stack = createStack(data, entry.defId, entry.count);
      addToInventory(player.inventory, stack, data);
    }
    // Put the hatchet on the first hotbar slot and in hand, so a new player can act.
    const hatchetIndex = player.inventory.slots.findIndex(
      (slot) => slot?.defId === 'stone_hatchet',
    );
    if (hatchetIndex >= 0) {
      player.hotbar[0] = hatchetIndex;
      const stack = player.inventory.slots[hatchetIndex];
      if (stack) {
        player.equipment.mainHand = stack;
        player.inventory.slots[hatchetIndex] = null;
        player.hotbar[0] = null;
      }
    }
  }

  recomputeCarryWeight(player, data);
  return player;
}

/**
 * Reset a dead character for respawn, keeping progression but wiping condition.
 * The inventory is *not* cleared here; the death system decides whether gear drops.
 */
export function resetPlayerForRespawn(
  player: PlayerState,
  x: number,
  y: number,
  tick: number,
): void {
  player.x = x;
  player.y = y;
  player.vx = 0;
  player.vy = 0;
  player.health = player.maxHealth;
  player.hunger = 35;
  player.thirst = 35;
  player.fatigue = 20;
  player.stamina = player.maxStamina;
  player.temperature = 37;
  player.blood = 100;
  player.alive = true;
  player.deathTick = -1;
  player.respawnAtTick = -1;
  delete player.deathCause;
  player.body = createBody();
  player.effects = [];
  player.craftQueue = [];
  player.attackReadyTick = tick;
  player.useReadyTick = tick;
  player.actionLockedUntilTick = tick;
  delete player.openContainerId;
  player.rev++;
}
