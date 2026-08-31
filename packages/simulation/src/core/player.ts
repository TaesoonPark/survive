import {
  BASE_INVENTORY_SLOTS,
  EQUIP_SLOTS,
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
 * be spent on a torch or a splint without stranding the player: a pickaxe and a spear
 * together cost three sticks, leaving three.
 *
 * The spear and the two cloth pieces are the floor, not the budget. Everything above is
 * *material* - it affords a choice, and the choice takes time the first night does not
 * give you. Meeting the first zombie bare-handed in bare skin is not a difficulty setting,
 * it is a character that cannot survive long enough to reach the crafting the kit was
 * designed around. The clothes are the weakest armour in the game (one point of blunt,
 * one of cold) and the spear is the recipe a player would have crafted first anyway, so
 * this raises the floor without touching the ceiling.
 *
 * Note that this is applied at character *creation* and again on respawn - see
 * {@link outfitPlayer}. `GameServer.joinPlayer` loads an existing character verbatim, so
 * changing this list does nothing for a save that already has one - the world has to be
 * reset, or a new save started.
 */
export const STARTING_KIT: ReadonlyArray<{ defId: string; count: number }> = [
  { defId: 'stone_hatchet', count: 1 },
  { defId: 'spear', count: 1 },
  { defId: 'cloth_shirt', count: 1 },
  { defId: 'cloth_pants', count: 1 },
  { defId: 'cloth_rag', count: 2 },
  { defId: 'berry', count: 3 },
  { defId: 'water_bottle', count: 1 },
  { defId: 'plant_fiber', count: 8 },
  { defId: 'stick', count: 6 },
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

  if (!options.withoutKit) outfitPlayer(data, player);

  recomputeCarryWeight(player, data);
  return player;
}

/** Everything the player is holding, in hand, worn or stowed. */
function carriedCount(player: PlayerState, defId: string): number {
  let total = 0;
  for (const slot of player.inventory.slots) if (slot?.defId === defId) total += slot.count;
  for (const slot of EQUIP_SLOTS) {
    const worn = player.equipment[slot];
    if (worn?.defId === defId) total += worn.count;
  }
  return total;
}

/**
 * Hand a character the starting kit, dressed and ready rather than in a pile.
 *
 * Armour goes on and the hatchet goes in hand, because a kit that has to be equipped
 * before it does anything is not a kit - a player who dies to the first zombie while the
 * inventory panel is open learnt nothing about the game.
 *
 * `onlyMissing` is what makes this safe to run a second time on respawn. Death usually
 * spills the inventory, but not always: a `dropInventory: false` death keeps everything,
 * and re-issuing the kit on top of that would mint free materials for anyone willing to
 * die for them. Skipping any line the player still has something of means the kit refills
 * what was lost and nothing else.
 */
export function outfitPlayer(
  data: GameData,
  player: PlayerState,
  options: { onlyMissing?: boolean } = {},
): void {
  for (const entry of STARTING_KIT) {
    if (!data.items.has(entry.defId)) continue;
    if (options.onlyMissing && carriedCount(player, entry.defId) > 0) continue;
    const stack = createStack(data, entry.defId, entry.count);
    addToInventory(player.inventory, stack, data);
  }

  // Wear what can be worn. Driven off the item's own armour slot rather than a second list
  // of ids, so adding a piece to the kit above is all it takes.
  for (let i = 0; i < player.inventory.slots.length; i++) {
    const stack = player.inventory.slots[i];
    if (!stack) continue;
    const slot = data.items.get(stack.defId)?.armor?.slot;
    if (!slot || player.equipment[slot]) continue;
    player.equipment[slot] = stack;
    player.inventory.slots[i] = null;
  }

  // The hatchet goes in hand, so a new player can act without opening a panel.
  if (!player.equipment.mainHand) {
    const index = player.inventory.slots.findIndex((slot) => slot?.defId === 'stone_hatchet');
    const stack = index >= 0 ? player.inventory.slots[index] : null;
    if (stack) {
      player.equipment.mainHand = stack;
      player.inventory.slots[index] = null;
    }
  }

  // And the spear goes on the first key. A hotbar entry points at an inventory slot, so
  // pressing it draws the spear and stows the hatchet into the slot the spear just left -
  // which leaves that key swapping between the two, rather than being a one-way trip.
  const spearIndex = player.inventory.slots.findIndex((slot) => slot?.defId === 'spear');
  if (spearIndex >= 0 && player.hotbar[0] === null) player.hotbar[0] = spearIndex;
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
