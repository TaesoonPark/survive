import type { LootEntry, LootTableDef } from '../types';

/**
 * Loot tables.
 *
 * How the two halves work together: `guaranteed` entries always drop, and then `rolls`
 * weighted picks are taken from `entries`. Corpses use `guaranteed` for the butchery
 * (a deer always gives meat) and the weighted pool for the extras. Containers use only
 * the weighted pool, so an empty cupboard is a real outcome.
 *
 * `condition` is the durability fraction a found tool or weapon spawns at. Nothing
 * scavenged ever arrives pristine: a police shotgun turns up at 45-85%, and a garage
 * hammer at 25-70%. That, plus `weight`, is the whole reason crafting stays relevant
 * after you find your first town.
 *
 * Firearms and their ammunition are deliberately thin and confined to
 * `police_station`, `car_trunk` and `safe_rare`. A gun is an event; ammunition is
 * rarer than the gun; and firing either one is loud enough to be a decision (see
 * `loudness` in the item table).
 *
 * `abundanceScaling` is on for every scavenged container so the `lootAbundance` world
 * setting can dial the whole world's generosity, and off for corpses so butchery yields
 * stay predictable.
 */

function e(
  defId: string,
  min: number,
  max: number,
  chance: number,
  weight: number,
  condition?: [number, number],
): LootEntry {
  return condition
    ? { defId, min, max, chance, weight, condition }
    : { defId, min, max, chance, weight };
}

// ---------------------------------------------------------------------------
// Residential
// ---------------------------------------------------------------------------

const HOUSE_KITCHEN: LootTableDef = {
  id: 'house_kitchen',
  rolls: [2, 4],
  abundanceScaling: true,
  entries: [
    e('canned_beans', 1, 2, 0.9, 14),
    e('canned_soup', 1, 2, 0.9, 12),
    e('water_bottle', 1, 1, 0.8, 10),
    e('kitchen_knife', 1, 1, 0.8, 8, [0.3, 0.9]),
    e('cloth_rag', 1, 3, 1, 16),
    e('flour', 1, 2, 0.6, 7),
    e('soda', 1, 2, 0.7, 9),
    e('chocolate_bar', 1, 1, 0.5, 6),
    e('potato', 1, 3, 0.6, 8),
    e('egg', 1, 3, 0.4, 5),
    e('plastic', 1, 3, 0.9, 12),
    e('glass_shard', 1, 3, 0.8, 10),
    e('lighter', 1, 1, 0.5, 5, [0.2, 0.8]),
    e('cooking_pot_kit', 1, 1, 0.2, 2),
    e('seed_carrot', 1, 2, 0.4, 4),
    e('seed_potato', 1, 2, 0.4, 4),
    e('seed_onion', 1, 2, 0.35, 3),
    e('apple', 1, 2, 0.45, 6),
    e('coffee', 1, 1, 0.4, 5),
  ],
};

const HOUSE_BATHROOM: LootTableDef = {
  id: 'house_bathroom',
  rolls: [1, 3],
  abundanceScaling: true,
  entries: [
    e('bandage_clean', 1, 3, 0.9, 16),
    e('bandage_sterile', 1, 2, 0.5, 8),
    e('antiseptic', 1, 1, 0.6, 9),
    e('painkiller', 1, 2, 0.7, 12),
    e('vitamins', 1, 1, 0.6, 8),
    e('antibiotics', 1, 1, 0.18, 3),
    e('cloth_rag', 1, 3, 1, 14),
    e('first_aid_kit', 1, 1, 0.12, 2, [0.34, 1]),
    e('water_bottle', 1, 1, 0.3, 5),
    e('suture_kit', 1, 1, 0.06, 1, [0.2, 0.8]),
  ],
};

const HOUSE_BEDROOM: LootTableDef = {
  id: 'house_bedroom',
  rolls: [1, 3],
  abundanceScaling: true,
  entries: [
    e('cloth', 1, 2, 0.8, 14),
    e('cloth_rag', 1, 3, 1, 16),
    e('jeans', 1, 1, 0.6, 9, [0.4, 1]),
    e('cloth_shirt', 1, 1, 0.6, 9, [0.4, 1]),
    e('leather_jacket', 1, 1, 0.15, 3, [0.3, 0.8]),
    e('backpack_small', 1, 1, 0.22, 4, [0.4, 0.95]),
    e('flashlight', 1, 1, 0.3, 5, [0.15, 0.7]),
    e('battery', 1, 2, 0.4, 6),
    e('door_key', 1, 1, 0.35, 6),
    e('chocolate_bar', 1, 1, 0.4, 5),
    e('map', 1, 1, 0.12, 2),
  ],
};

const HOUSE_GARAGE: LootTableDef = {
  id: 'house_garage',
  rolls: [2, 4],
  abundanceScaling: true,
  entries: [
    e('nail', 4, 14, 1, 16),
    e('scrap_metal', 2, 5, 1, 15),
    e('wire', 1, 3, 0.8, 11),
    e('duct_tape', 1, 1, 0.5, 8),
    e('rope', 1, 2, 0.6, 8),
    e('hammer', 1, 1, 0.5, 8, [0.25, 0.7]),
    e('saw', 1, 1, 0.4, 6, [0.25, 0.7]),
    e('wrench', 1, 1, 0.4, 6, [0.25, 0.75]),
    e('shovel', 1, 1, 0.35, 5, [0.25, 0.75]),
    e('crowbar', 1, 1, 0.3, 5, [0.35, 0.85]),
    e('work_gloves', 1, 1, 0.4, 6, [0.3, 0.8]),
    e('fuel_canister', 1, 1, 0.18, 3),
    e('rubber', 1, 3, 0.6, 8),
    e('plastic', 1, 4, 0.8, 10),
  ],
};

const SHED: LootTableDef = {
  id: 'shed',
  rolls: [2, 3],
  abundanceScaling: true,
  entries: [
    e('plant_fiber', 3, 8, 1, 16),
    e('rope', 1, 2, 0.7, 10),
    e('hoe', 1, 1, 0.35, 6, [0.3, 0.8]),
    e('sickle', 1, 1, 0.3, 5, [0.3, 0.8]),
    e('watering_can', 1, 1, 0.35, 6, [0.3, 0.85]),
    e('shovel', 1, 1, 0.3, 5, [0.25, 0.8]),
    e('fertilizer', 1, 3, 0.6, 9),
    e('compost', 1, 2, 0.5, 7),
    e('seed_wheat', 1, 3, 0.6, 9),
    e('seed_corn', 1, 3, 0.5, 8),
    e('seed_tomato', 1, 2, 0.5, 8),
    e('seed_cabbage', 1, 2, 0.45, 7),
    e('seed_pumpkin', 1, 2, 0.35, 5),
    e('seed_beans', 1, 3, 0.5, 8),
    e('seed_herb', 1, 2, 0.3, 4),
    e('stick', 2, 6, 0.8, 10),
  ],
};

// ---------------------------------------------------------------------------
// Commercial
// ---------------------------------------------------------------------------

const STORE_GENERAL: LootTableDef = {
  id: 'store_general',
  rolls: [2, 5],
  abundanceScaling: true,
  entries: [
    e('canned_beans', 1, 3, 0.9, 15),
    e('canned_soup', 1, 3, 0.9, 14),
    e('water_bottle', 1, 2, 0.8, 12),
    e('soda', 1, 3, 0.8, 12),
    e('energy_bar', 1, 3, 0.7, 10),
    e('chocolate_bar', 1, 3, 0.7, 10),
    e('cloth', 1, 3, 0.7, 9),
    e('backpack_small', 1, 1, 0.2, 4, [0.6, 1]),
    e('lighter', 1, 2, 0.5, 7, [0.5, 1]),
    e('canteen', 1, 1, 0.25, 4),
    e('map', 1, 1, 0.2, 3),
    e('compass', 1, 1, 0.15, 3),
    e('radio', 1, 1, 0.08, 2),
    e('plastic', 2, 6, 0.9, 12),
    e('apple', 1, 3, 0.5, 8),
    e('coffee', 1, 2, 0.45, 7),
  ],
};

const STORE_HARDWARE: LootTableDef = {
  id: 'store_hardware',
  rolls: [3, 5],
  abundanceScaling: true,
  entries: [
    e('nail', 8, 30, 1, 18),
    e('wire', 2, 6, 0.9, 14),
    e('scrap_metal', 3, 8, 1, 16),
    e('duct_tape', 1, 2, 0.6, 9),
    e('rope', 1, 3, 0.7, 10),
    e('hammer', 1, 1, 0.5, 8, [0.7, 1]),
    e('saw', 1, 1, 0.45, 7, [0.7, 1]),
    e('wrench', 1, 1, 0.45, 7, [0.7, 1]),
    e('shovel', 1, 1, 0.4, 6, [0.7, 1]),
    e('sledgehammer', 1, 1, 0.15, 3, [0.6, 1]),
    e('hard_hat', 1, 1, 0.35, 6, [0.6, 1]),
    e('work_boots', 1, 1, 0.3, 5, [0.6, 1]),
    e('work_gloves', 1, 1, 0.4, 6, [0.6, 1]),
    e('glass', 1, 2, 0.4, 6),
    e('multitool', 1, 1, 0.06, 1, [0.6, 1]),
  ],
};

const STORE_PHARMACY: LootTableDef = {
  id: 'store_pharmacy',
  rolls: [2, 4],
  abundanceScaling: true,
  entries: [
    e('bandage_sterile', 1, 3, 0.9, 16),
    e('bandage_clean', 1, 4, 0.9, 14),
    e('antiseptic', 1, 2, 0.8, 12),
    e('painkiller', 1, 3, 0.8, 13),
    e('vitamins', 1, 2, 0.7, 10),
    e('antibiotics', 1, 2, 0.4, 7),
    e('morphine', 1, 1, 0.15, 3),
    e('suture_kit', 1, 1, 0.2, 4, [0.4, 1]),
    e('first_aid_kit', 1, 1, 0.25, 5, [0.34, 1]),
    e('splint_medical', 1, 1, 0.3, 5),
    e('gas_mask', 1, 1, 0.06, 1, [0.5, 1]),
  ],
};

const POLICE_STATION: LootTableDef = {
  id: 'police_station',
  rolls: [2, 4],
  abundanceScaling: true,
  entries: [
    e('ammo_9mm', 4, 12, 0.7, 14),
    e('ammo_shell', 3, 8, 0.5, 10),
    e('ammo_308', 2, 6, 0.25, 5),
    e('pistol_9mm', 1, 1, 0.22, 5, [0.5, 0.95]),
    e('shotgun', 1, 1, 0.12, 3, [0.45, 0.85]),
    e('rifle_308', 1, 1, 0.05, 1, [0.45, 0.85]),
    e('kevlar_vest', 1, 1, 0.18, 4, [0.4, 0.9]),
    e('plate_carrier', 1, 1, 0.05, 1, [0.4, 0.9]),
    e('motorcycle_helmet', 1, 1, 0.14, 3, [0.4, 0.9]),
    e('baseball_bat', 1, 1, 0.3, 6, [0.5, 1]),
    e('work_boots', 1, 1, 0.4, 7, [0.4, 0.9]),
    e('first_aid_kit', 1, 1, 0.3, 6, [0.34, 1]),
    e('door_key', 1, 2, 0.5, 8),
    e('radio', 1, 1, 0.2, 4),
    e('flashlight', 1, 1, 0.35, 6, [0.3, 0.9]),
  ],
};

const CAR_TRUNK: LootTableDef = {
  id: 'car_trunk',
  rolls: [1, 3],
  abundanceScaling: true,
  entries: [
    e('scrap_metal', 1, 4, 0.9, 15),
    e('rubber', 1, 3, 0.8, 13),
    e('duct_tape', 1, 1, 0.4, 7),
    e('wire', 1, 3, 0.6, 9),
    e('fuel_canister', 1, 1, 0.15, 3),
    e('first_aid_kit', 1, 1, 0.12, 2, [0.34, 1]),
    e('crowbar', 1, 1, 0.2, 4, [0.4, 0.9]),
    e('wrench', 1, 1, 0.25, 5, [0.3, 0.8]),
    e('battery', 1, 1, 0.3, 6),
    e('cloth_rag', 1, 3, 0.8, 11),
    e('water_bottle', 1, 1, 0.3, 6),
    e('ammo_9mm', 2, 6, 0.06, 1),
  ],
};

const SCRAP_PILE_TABLE: LootTableDef = {
  id: 'scrap_pile',
  rolls: [1, 3],
  abundanceScaling: true,
  entries: [
    e('scrap_metal', 1, 4, 1, 18),
    e('nail', 2, 8, 0.7, 12),
    e('wire', 1, 2, 0.5, 8),
    e('plastic', 1, 4, 0.7, 11),
    e('rubber', 1, 2, 0.5, 8),
    e('cloth_rag', 1, 2, 0.5, 8),
    e('glass_shard', 1, 3, 0.5, 7),
    e('battery', 1, 1, 0.08, 2),
  ],
};

const SAFE_RARE: LootTableDef = {
  id: 'safe_rare',
  rolls: [2, 3],
  abundanceScaling: false,
  entries: [
    e('schematic_steel', 1, 1, 0.5, 6),
    e('schematic_crossbow', 1, 1, 0.5, 6),
    e('schematic_ammunition', 1, 1, 0.4, 5),
    e('schematic_medicine', 1, 1, 0.4, 5),
    e('ammo_308', 4, 10, 0.6, 8),
    e('ammo_9mm', 8, 20, 0.6, 8),
    e('rifle_308', 1, 1, 0.15, 2, [0.6, 1]),
    e('pistol_9mm', 1, 1, 0.2, 3, [0.6, 1]),
    e('plate_carrier', 1, 1, 0.12, 2, [0.6, 1]),
    e('multitool', 1, 1, 0.25, 4, [0.7, 1]),
    e('morphine', 1, 2, 0.3, 5),
    e('antibiotics', 1, 3, 0.4, 6),
    e('gas_mask', 1, 1, 0.15, 3, [0.6, 1]),
    e('duct_tape', 1, 2, 0.4, 6),
  ],
};

// ---------------------------------------------------------------------------
// Corpses
// ---------------------------------------------------------------------------

const ZOMBIE_COMMON: LootTableDef = {
  id: 'zombie_common',
  rolls: [0, 2],
  abundanceScaling: false,
  entries: [
    e('cloth_rag', 1, 2, 1, 22),
    e('bone', 1, 2, 0.6, 12),
    e('plastic', 1, 2, 0.5, 9),
    e('door_key', 1, 1, 0.15, 4),
    e('jeans', 1, 1, 0.1, 3, [0.1, 0.4]),
    e('canned_beans', 1, 1, 0.08, 2),
    e('painkiller', 1, 1, 0.06, 2),
    e('ammo_9mm', 1, 3, 0.03, 1),
    e('lighter', 1, 1, 0.05, 2, [0.05, 0.4]),
  ],
};

const ZOMBIE_BRUTE: LootTableDef = {
  id: 'zombie_brute',
  rolls: [2, 3],
  abundanceScaling: false,
  guaranteed: [e('bone', 2, 4, 1, 1)],
  entries: [
    e('scrap_metal', 1, 3, 0.8, 14),
    e('leather', 1, 2, 0.5, 9),
    e('cloth_rag', 1, 3, 1, 16),
    e('sledgehammer', 1, 1, 0.05, 1, [0.15, 0.5]),
    e('duct_tape', 1, 1, 0.1, 3),
    e('iron_ingot', 1, 2, 0.15, 4),
  ],
};

const ZOMBIE_ARMORED: LootTableDef = {
  id: 'zombie_armored',
  rolls: [1, 3],
  abundanceScaling: false,
  guaranteed: [e('scrap_metal', 1, 2, 1, 1)],
  entries: [
    e('kevlar_vest', 1, 1, 0.12, 3, [0.1, 0.45]),
    e('motorcycle_helmet', 1, 1, 0.14, 3, [0.1, 0.45]),
    e('work_boots', 1, 1, 0.3, 6, [0.1, 0.5]),
    e('ammo_9mm', 1, 4, 0.25, 6),
    e('door_key', 1, 1, 0.2, 5),
    e('cloth_rag', 1, 2, 1, 14),
    e('baseball_bat', 1, 1, 0.08, 2, [0.2, 0.6]),
  ],
};

const ZOMBIE_DOG: LootTableDef = {
  id: 'zombie_dog',
  rolls: [1, 2],
  abundanceScaling: false,
  guaranteed: [e('bone', 1, 2, 1, 1)],
  entries: [e('raw_meat', 1, 2, 0.5, 10), e('hide', 1, 1, 0.4, 8), e('sinew', 1, 2, 0.5, 9)],
};

interface ButcherySpec {
  id: string;
  meat: [number, number];
  hide: [number, number];
  bone: [number, number];
  sinew: [number, number];
  extras?: LootEntry[];
}

/**
 * Butchery tables are mechanical on purpose: a carcass is meat, hide, bone and sinew in
 * proportion to the animal's size, so hunting yields are predictable enough to plan a
 * week of food around.
 */
function butchery(spec: ButcherySpec): LootTableDef {
  return {
    id: spec.id,
    rolls: [1, 2],
    abundanceScaling: false,
    guaranteed: [
      e('raw_meat', spec.meat[0], spec.meat[1], 1, 1),
      e('bone', spec.bone[0], spec.bone[1], 1, 1),
    ],
    entries: [
      e('hide', spec.hide[0], spec.hide[1], 0.9, 14),
      e('sinew', spec.sinew[0], spec.sinew[1], 0.8, 12),
      ...(spec.extras ?? []),
    ],
  };
}

const ANIMAL_TABLES: LootTableDef[] = [
  butchery({ id: 'animal_rabbit', meat: [1, 2], hide: [1, 1], bone: [1, 2], sinew: [1, 1] }),
  butchery({
    id: 'animal_chicken',
    meat: [1, 1],
    hide: [0, 1],
    bone: [1, 2],
    sinew: [0, 1],
    extras: [e('feather', 3, 6, 1, 18), e('egg', 1, 2, 0.35, 8)],
  }),
  butchery({ id: 'animal_fox', meat: [1, 2], hide: [1, 2], bone: [1, 2], sinew: [1, 1] }),
  butchery({ id: 'animal_deer', meat: [3, 5], hide: [2, 3], bone: [2, 4], sinew: [2, 3] }),
  butchery({
    id: 'animal_boar',
    meat: [3, 4],
    hide: [2, 2],
    bone: [2, 3],
    sinew: [1, 2],
    extras: [e('bone', 1, 2, 0.4, 6)],
  }),
  butchery({ id: 'animal_wolf', meat: [2, 3], hide: [1, 2], bone: [2, 2], sinew: [2, 2] }),
  butchery({ id: 'animal_bear', meat: [5, 8], hide: [3, 4], bone: [3, 5], sinew: [3, 4] }),
  butchery({ id: 'animal_cow', meat: [5, 8], hide: [3, 4], bone: [3, 4], sinew: [2, 3] }),
];

// ---------------------------------------------------------------------------

/** Every loot table in the game. */
export const LOOT_TABLE_DEFS: readonly LootTableDef[] = [
  HOUSE_KITCHEN,
  HOUSE_BATHROOM,
  HOUSE_BEDROOM,
  HOUSE_GARAGE,
  SHED,
  STORE_GENERAL,
  STORE_HARDWARE,
  STORE_PHARMACY,
  POLICE_STATION,
  CAR_TRUNK,
  SCRAP_PILE_TABLE,
  SAFE_RARE,
  ZOMBIE_COMMON,
  ZOMBIE_BRUTE,
  ZOMBIE_ARMORED,
  ZOMBIE_DOG,
  ...ANIMAL_TABLES,
];
