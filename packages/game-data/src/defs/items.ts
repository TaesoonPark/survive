import type {
  ArmorProps,
  DrinkProps,
  FoodProps,
  ItemDef,
  ItemSource,
  MedicalProps,
  PerishableProps,
  WeaponProps,
} from '../types';
import { days, gameHours, seconds } from './units';

/**
 * The item table.
 *
 * Conventions used throughout, so the numbers stay comparable:
 *
 * - **Weight is kilograms.** A fresh character carries 30 kg before the
 *   `overencumbered` effect bites, so a stack of twenty logs (2 kg each) is already
 *   more than one trip. Hauling is meant to be a decision.
 * - **Durability is "uses"**, spent through `tool.durabilityPerUse` /
 *   `weapon.durabilityPerHit`. A stone hatchet at 60 lasts an afternoon; a steel one
 *   at 400 lasts a season.
 * - **`loudness` is a radius in world pixels** (one tile = 32 px, one chunk =
 *   1024 px). Melee is a room; a rifle is six chunks. That single number is the whole
 *   reason firing a gun is a strategic act rather than a free win.
 * - **Nutrition and hydration are need points**, on the same 0..100 scale as
 *   `hunger` / `thirst`. A cooked steak at 30 is roughly a third of a day's food.
 * - **`fuel.burnTicks` is the currency of every burning station.** A station's
 *   `maxFuel` and a recipe's `fuelCost` are in the same ticks, so one log (2400) pays
 *   for four smelts (600 each).
 *
 * Anything with per-item state (durability, a liquid fill, loaded ammunition) is
 * declared `stackSize: 1`, matching `maxStackSize()` in the simulation, so the table
 * and the runtime agree instead of quietly disagreeing.
 */

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

type ItemSpec = Pick<ItemSource, 'id' | 'category'> & Omit<Partial<ItemSource>, 'id' | 'category'>;

function item(spec: ItemSpec): ItemSource {
  return {
    stackSize: 20,
    weight: 0.5,
    icon: `item_${spec.id}`,
    rarity: 'common',
    tags: [],
    ...spec,
  };
}

type MeleeSpec = Pick<WeaponProps, 'damage' | 'damageType' | 'range'> & Partial<WeaponProps>;

/** Melee defaults: a one-handed swing, ~0.8 s between hits, audible across a room. */
function melee(spec: MeleeSpec): WeaponProps {
  return {
    kind: 'melee',
    arcDegrees: 70,
    attackTicks: seconds(0.8),
    windupTicks: seconds(0.2),
    staminaCost: 6,
    knockback: 60,
    critChance: 0.05,
    critMultiplier: 1.8,
    armorPen: 0,
    skill: 'melee',
    durabilityPerHit: 1,
    loudness: 140,
    twoHanded: false,
    maxTargets: 1,
    ...spec,
  };
}

type RangedSpec = Pick<WeaponProps, 'damage' | 'damageType' | 'range' | 'ammoDefIds'> &
  Partial<WeaponProps>;

/** Ranged defaults lean firearm-ish; bows override the quiet, slow half. */
function ranged(spec: RangedSpec): WeaponProps {
  return {
    kind: 'ranged',
    arcDegrees: 0,
    attackTicks: seconds(0.7),
    windupTicks: seconds(0.1),
    staminaCost: 1,
    knockback: 40,
    critChance: 0.08,
    critMultiplier: 2.2,
    armorPen: 0.15,
    skill: 'ranged',
    durabilityPerHit: 1,
    loudness: 4000,
    twoHanded: true,
    maxTargets: 1,
    magazineSize: 1,
    reloadTicks: seconds(2),
    spreadDegrees: 3,
    pellets: 1,
    ...spec,
  };
}

type ThrownSpec = Pick<WeaponProps, 'damage' | 'damageType' | 'range' | 'projectileDefId'> &
  Partial<WeaponProps>;

function thrown(spec: ThrownSpec): WeaponProps {
  return {
    kind: 'thrown',
    arcDegrees: 0,
    attackTicks: seconds(1.2),
    windupTicks: seconds(0.35),
    staminaCost: 5,
    knockback: 40,
    critChance: 0.05,
    critMultiplier: 1.6,
    armorPen: 0,
    skill: 'ranged',
    durabilityPerHit: 0,
    loudness: 260,
    twoHanded: false,
    maxTargets: 1,
    ...spec,
  };
}

type ArmorSpec = Pick<ArmorProps, 'slot' | 'coverage' | 'protection'> & Partial<ArmorProps>;

function armor(spec: ArmorSpec): ArmorProps {
  return {
    warmth: 0,
    encumbrance: 0,
    durabilityPerHit: 1,
    biteResistance: 1,
    ...spec,
  };
}

type FoodSpec = Pick<FoodProps, 'nutrition'> & Partial<FoodProps>;

function food(spec: FoodSpec): FoodProps {
  return {
    hydration: 0,
    stamina: 0,
    health: 0,
    eatTicks: seconds(1.5),
    sicknessChance: 0,
    ...spec,
  };
}

type DrinkSpec = Pick<DrinkProps, 'hydration'> & Partial<DrinkProps>;

function drink(spec: DrinkSpec): DrinkProps {
  return {
    nutrition: 0,
    sicknessChance: 0,
    drinkTicks: seconds(1.2),
    ...spec,
  };
}

type MedicalSpec = Pick<MedicalProps, 'kind'> & Partial<MedicalProps>;

function medical(spec: MedicalSpec): MedicalProps {
  return {
    bleedStop: 0,
    heal: 0,
    painRelief: 0,
    infectionCure: 0,
    fixesFracture: false,
    cleanliness: 0.5,
    useTicks: seconds(2),
    skillLevel: 0,
    ...spec,
  };
}

/** Perishable shorthand. Cool storage roughly triples shelf life. */
function spoils(dayCount: number, spoiledDefId?: string): PerishableProps {
  return spoiledDefId
    ? { spoilTicks: days(dayCount), spoiledDefId, refrigeratedMultiplier: 0.35 }
    : { spoilTicks: days(dayCount), refrigeratedMultiplier: 0.35 };
}

// ---------------------------------------------------------------------------
// Raw resources and components
// ---------------------------------------------------------------------------

const RESOURCES: ItemSource[] = [
  item({
    id: 'wood_log',
    category: 'resource',
    weight: 2,
    stackSize: 20,
    fuel: { burnTicks: 2400, heat: 12 },
    tags: ['wood', 'fuel', 'gatherable'],
  }),
  item({
    id: 'wood_plank',
    category: 'component',
    weight: 1,
    fuel: { burnTicks: 1400, heat: 10 },
    tags: ['wood', 'fuel'],
  }),
  item({
    id: 'stick',
    category: 'resource',
    weight: 0.25,
    stackSize: 40,
    fuel: { burnTicks: 400, heat: 5 },
    tags: ['wood', 'fuel', 'gatherable'],
  }),
  item({
    id: 'bark',
    category: 'resource',
    weight: 0.15,
    stackSize: 40,
    fuel: { burnTicks: 260, heat: 4 },
    tags: ['wood', 'fuel', 'gatherable'],
  }),
  item({
    id: 'plant_fiber',
    category: 'resource',
    weight: 0.05,
    stackSize: 60,
    tags: ['fiber', 'gatherable'],
  }),
  item({
    id: 'stone',
    category: 'resource',
    weight: 1.2,
    stackSize: 30,
    tags: ['stone', 'gatherable'],
  }),
  item({
    id: 'flint',
    category: 'resource',
    weight: 0.3,
    stackSize: 30,
    tags: ['stone', 'gatherable'],
  }),
  item({
    id: 'stone_block',
    category: 'component',
    weight: 4.5,
    stackSize: 10,
    tags: ['stone'],
  }),
  item({
    id: 'sand',
    category: 'resource',
    weight: 1.4,
    stackSize: 30,
    tags: ['gatherable'],
  }),
  item({
    id: 'clay',
    category: 'resource',
    weight: 1.3,
    stackSize: 30,
    tags: ['gatherable'],
  }),
  item({
    id: 'clay_brick',
    category: 'component',
    weight: 2,
    stackSize: 20,
    tags: ['stone'],
  }),
  item({
    id: 'coal',
    category: 'fuel',
    weight: 1,
    stackSize: 30,
    fuel: { burnTicks: 6000, heat: 26 },
    tags: ['fuel', 'gatherable'],
  }),
  item({
    id: 'charcoal',
    category: 'fuel',
    weight: 0.6,
    stackSize: 30,
    fuel: { burnTicks: 4000, heat: 22 },
    tags: ['fuel'],
  }),
  item({
    id: 'iron_ore',
    category: 'resource',
    weight: 2,
    stackSize: 20,
    tags: ['ore'],
  }),
  item({
    id: 'iron_ingot',
    category: 'component',
    weight: 1.8,
    stackSize: 20,
    tags: ['metal'],
  }),
  item({
    id: 'copper_ore',
    category: 'resource',
    weight: 2,
    stackSize: 20,
    tags: ['ore'],
  }),
  item({
    id: 'copper_ingot',
    category: 'component',
    weight: 1.7,
    stackSize: 20,
    tags: ['metal'],
  }),
  item({
    id: 'steel_ingot',
    category: 'component',
    weight: 1.9,
    stackSize: 20,
    rarity: 'uncommon',
    tags: ['metal'],
  }),
  item({
    id: 'scrap_metal',
    category: 'resource',
    weight: 1,
    stackSize: 30,
    tags: ['metal', 'gatherable'],
  }),
  item({
    id: 'nail',
    category: 'component',
    weight: 0.02,
    stackSize: 200,
    tags: ['metal'],
  }),
  item({
    id: 'rope',
    category: 'component',
    weight: 0.4,
    stackSize: 20,
    tags: ['fiber'],
  }),
  item({
    id: 'cloth_rag',
    category: 'component',
    weight: 0.15,
    stackSize: 40,
    fuel: { burnTicks: 300, heat: 4 },
    tags: ['cloth', 'fuel'],
  }),
  item({
    id: 'cloth',
    category: 'component',
    weight: 0.3,
    stackSize: 30,
    tags: ['cloth'],
  }),
  item({
    id: 'leather',
    category: 'component',
    weight: 0.5,
    stackSize: 20,
    tags: ['leather'],
  }),
  item({
    id: 'hide',
    category: 'resource',
    weight: 1.2,
    stackSize: 10,
    tags: ['leather'],
  }),
  item({
    id: 'bone',
    category: 'resource',
    weight: 0.4,
    stackSize: 20,
    tags: ['bone'],
  }),
  item({
    id: 'sinew',
    category: 'resource',
    weight: 0.05,
    stackSize: 30,
    tags: ['fiber'],
  }),
  item({
    id: 'feather',
    category: 'resource',
    weight: 0.02,
    stackSize: 60,
    tags: [],
  }),
  item({
    id: 'resin',
    category: 'resource',
    weight: 0.2,
    stackSize: 30,
    fuel: { burnTicks: 900, heat: 14 },
    tags: ['fuel'],
  }),
  item({
    id: 'gunpowder',
    category: 'component',
    weight: 0.1,
    stackSize: 40,
    rarity: 'uncommon',
    tags: ['explosive'],
  }),
  item({
    id: 'glass_shard',
    category: 'resource',
    weight: 0.1,
    stackSize: 40,
    tags: ['glass', 'gatherable'],
  }),
  item({
    id: 'glass',
    category: 'component',
    weight: 0.8,
    stackSize: 20,
    tags: ['glass'],
  }),
  item({
    id: 'wire',
    category: 'component',
    weight: 0.1,
    stackSize: 40,
    tags: ['metal'],
  }),
  item({
    id: 'duct_tape',
    category: 'component',
    weight: 0.2,
    stackSize: 10,
    rarity: 'uncommon',
    tags: [],
  }),
  item({
    id: 'plastic',
    category: 'resource',
    weight: 0.3,
    stackSize: 30,
    tags: ['gatherable'],
  }),
  item({
    id: 'rubber',
    category: 'resource',
    weight: 0.4,
    stackSize: 20,
    tags: ['gatherable'],
  }),
  item({
    id: 'battery',
    category: 'component',
    weight: 0.3,
    stackSize: 10,
    rarity: 'uncommon',
    tags: [],
  }),
  item({
    id: 'fuel_canister',
    category: 'fuel',
    weight: 5,
    stackSize: 4,
    rarity: 'uncommon',
    fuel: { burnTicks: 12000, heat: 40 },
    tags: ['fuel', 'flammable'],
  }),
  item({
    id: 'ammo_casing',
    category: 'component',
    weight: 0.02,
    stackSize: 100,
    tags: ['metal'],
  }),
  item({
    id: 'fertilizer',
    category: 'misc',
    weight: 0.6,
    stackSize: 20,
    fertilizerTicks: days(0.5),
    tags: ['farming'],
  }),
  item({
    id: 'compost',
    category: 'misc',
    weight: 0.8,
    stackSize: 20,
    fertilizerTicks: days(0.2),
    tags: ['farming'],
  }),
];

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const TOOLS: ItemSource[] = [
  item({
    id: 'stone_hatchet',
    category: 'tool',
    stackSize: 1,
    weight: 1.4,
    maxDurability: 60,
    tool: { kinds: ['axe'], tier: 1, efficiency: 1, durabilityPerUse: 1 },
    weapon: melee({
      damage: 9,
      damageType: 'slash',
      range: 44,
      durabilityPerHit: 2,
      staminaCost: 7,
    }),
    tags: ['tier1'],
  }),
  item({
    id: 'iron_axe',
    category: 'tool',
    stackSize: 1,
    weight: 2.4,
    maxDurability: 220,
    tool: { kinds: ['axe'], tier: 2, efficiency: 1.8, durabilityPerUse: 1 },
    weapon: melee({
      damage: 18,
      damageType: 'slash',
      range: 48,
      attackTicks: seconds(1),
      staminaCost: 9,
      knockback: 90,
      durabilityPerHit: 2,
    }),
    tags: [],
  }),
  item({
    id: 'steel_axe',
    category: 'tool',
    stackSize: 1,
    weight: 2.5,
    maxDurability: 420,
    rarity: 'uncommon',
    tool: { kinds: ['axe'], tier: 3, efficiency: 2.5, durabilityPerUse: 1 },
    weapon: melee({
      damage: 24,
      damageType: 'slash',
      range: 48,
      attackTicks: seconds(0.95),
      staminaCost: 9,
      knockback: 95,
      armorPen: 0.1,
      durabilityPerHit: 2,
    }),
    tags: [],
  }),
  item({
    id: 'stone_pickaxe',
    category: 'tool',
    stackSize: 1,
    weight: 1.8,
    maxDurability: 60,
    tool: { kinds: ['pickaxe'], tier: 1, efficiency: 1, durabilityPerUse: 1 },
    weapon: melee({
      damage: 10,
      damageType: 'pierce',
      range: 46,
      staminaCost: 8,
      durabilityPerHit: 2,
    }),
    tags: ['tier1'],
  }),
  item({
    id: 'iron_pickaxe',
    category: 'tool',
    stackSize: 1,
    weight: 3,
    maxDurability: 220,
    tool: { kinds: ['pickaxe'], tier: 2, efficiency: 1.8, durabilityPerUse: 1 },
    weapon: melee({
      damage: 17,
      damageType: 'pierce',
      range: 48,
      attackTicks: seconds(1.05),
      staminaCost: 10,
      armorPen: 0.15,
      durabilityPerHit: 2,
    }),
    tags: [],
  }),
  item({
    id: 'steel_pickaxe',
    category: 'tool',
    stackSize: 1,
    weight: 3.1,
    maxDurability: 440,
    rarity: 'uncommon',
    tool: { kinds: ['pickaxe'], tier: 3, efficiency: 2.5, durabilityPerUse: 1 },
    weapon: melee({
      damage: 22,
      damageType: 'pierce',
      range: 48,
      attackTicks: seconds(1),
      staminaCost: 10,
      armorPen: 0.25,
      durabilityPerHit: 2,
    }),
    tags: [],
  }),
  item({
    id: 'shovel',
    category: 'tool',
    stackSize: 1,
    weight: 2.2,
    maxDurability: 200,
    tool: { kinds: ['shovel'], tier: 2, efficiency: 1.6, durabilityPerUse: 1 },
    weapon: melee({ damage: 12, damageType: 'blunt', range: 50, staminaCost: 8, knockback: 80 }),
    tags: [],
  }),
  item({
    id: 'hoe',
    category: 'tool',
    stackSize: 1,
    weight: 1.9,
    maxDurability: 180,
    tool: { kinds: ['hoe'], tier: 2, efficiency: 1.5, durabilityPerUse: 1 },
    weapon: melee({ damage: 9, damageType: 'blunt', range: 50, staminaCost: 7 }),
    tags: [],
  }),
  item({
    id: 'stone_knife',
    category: 'tool',
    stackSize: 1,
    weight: 0.4,
    maxDurability: 45,
    tool: { kinds: ['knife'], tier: 1, efficiency: 1, durabilityPerUse: 1 },
    weapon: melee({
      damage: 7,
      damageType: 'slash',
      range: 34,
      attackTicks: seconds(0.55),
      staminaCost: 4,
      critChance: 0.14,
      critMultiplier: 2.4,
      knockback: 20,
    }),
    tags: ['tier1'],
  }),
  item({
    id: 'iron_knife',
    category: 'tool',
    stackSize: 1,
    weight: 0.5,
    maxDurability: 160,
    tool: { kinds: ['knife'], tier: 2, efficiency: 1.7, durabilityPerUse: 1 },
    weapon: melee({
      damage: 13,
      damageType: 'slash',
      range: 36,
      attackTicks: seconds(0.5),
      staminaCost: 4,
      critChance: 0.18,
      critMultiplier: 2.6,
      armorPen: 0.1,
      knockback: 20,
    }),
    tags: [],
  }),
  item({
    id: 'hammer',
    category: 'tool',
    stackSize: 1,
    weight: 1.2,
    maxDurability: 260,
    tool: { kinds: ['hammer'], tier: 2, efficiency: 1.5, durabilityPerUse: 1 },
    weapon: melee({ damage: 12, damageType: 'blunt', range: 38, staminaCost: 6, knockback: 100 }),
    tags: [],
  }),
  item({
    id: 'saw',
    category: 'tool',
    stackSize: 1,
    weight: 1.1,
    maxDurability: 220,
    tool: { kinds: ['saw'], tier: 2, efficiency: 1.6, durabilityPerUse: 1 },
    weapon: melee({ damage: 8, damageType: 'slash', range: 40, staminaCost: 6 }),
    tags: [],
  }),
  item({
    id: 'watering_can',
    category: 'tool',
    stackSize: 1,
    weight: 1,
    maxDurability: 150,
    tool: { kinds: ['wateringCan'], tier: 1, efficiency: 1, durabilityPerUse: 1 },
    liquid: { capacity: 20, fillable: true },
    tags: ['farming'],
  }),
  item({
    id: 'sickle',
    category: 'tool',
    stackSize: 1,
    weight: 0.8,
    maxDurability: 180,
    tool: { kinds: ['sickle'], tier: 2, efficiency: 1.6, durabilityPerUse: 1 },
    weapon: melee({
      damage: 11,
      damageType: 'slash',
      range: 40,
      attackTicks: seconds(0.6),
      critChance: 0.12,
      staminaCost: 5,
    }),
    tags: ['farming'],
  }),
  item({
    id: 'wrench',
    category: 'tool',
    stackSize: 1,
    weight: 1.3,
    maxDurability: 240,
    tool: { kinds: ['wrench'], tier: 2, efficiency: 1.6, durabilityPerUse: 1 },
    weapon: melee({ damage: 13, damageType: 'blunt', range: 36, staminaCost: 6, knockback: 90 }),
    tags: [],
  }),
  item({
    id: 'lighter',
    category: 'tool',
    stackSize: 1,
    weight: 0.05,
    maxDurability: 40,
    rarity: 'uncommon',
    tool: { kinds: ['lighter'], tier: 1, efficiency: 1, durabilityPerUse: 1 },
    tags: ['ignition'],
  }),
  item({
    id: 'fishing_rod',
    category: 'tool',
    stackSize: 1,
    weight: 0.9,
    maxDurability: 120,
    tool: { kinds: ['fishingRod'], tier: 1, efficiency: 1, durabilityPerUse: 1 },
    tags: [],
  }),
  item({
    id: 'multitool',
    category: 'tool',
    stackSize: 1,
    weight: 0.3,
    maxDurability: 300,
    rarity: 'rare',
    tool: {
      kinds: ['knife', 'saw', 'wrench', 'hammer'],
      tier: 4,
      efficiency: 2.2,
      durabilityPerUse: 1,
    },
    weapon: melee({
      damage: 9,
      damageType: 'slash',
      range: 30,
      attackTicks: seconds(0.5),
      staminaCost: 3,
      critChance: 0.14,
    }),
    tags: [],
  }),
];

// ---------------------------------------------------------------------------
// Melee weapons
//
// `fists` is deliberately absent: unarmed damage belongs to the combat system, not
// to a phantom item that would have to be in every inventory. Axes, knives, the
// hammer and the sledge double as weapons rather than shipping a second "combat"
// copy of each, which is why there is no separate `hatchet_weapon`.
// ---------------------------------------------------------------------------

const MELEE_WEAPONS: ItemSource[] = [
  item({
    id: 'wooden_club',
    category: 'weapon',
    stackSize: 1,
    weight: 1.6,
    maxDurability: 90,
    weapon: melee({
      damage: 12,
      damageType: 'blunt',
      range: 42,
      attackTicks: seconds(0.85),
      knockback: 110,
      staminaCost: 7,
    }),
    tags: ['tier1'],
  }),
  item({
    id: 'baseball_bat',
    category: 'weapon',
    stackSize: 1,
    weight: 1.1,
    maxDurability: 150,
    weapon: melee({
      damage: 17,
      damageType: 'blunt',
      range: 52,
      attackTicks: seconds(0.85),
      arcDegrees: 90,
      knockback: 150,
      staminaCost: 8,
      maxTargets: 2,
      blockReduction: 0.2,
    }),
    tags: [],
  }),
  item({
    id: 'nail_bat',
    category: 'weapon',
    stackSize: 1,
    weight: 1.4,
    maxDurability: 120,
    weapon: melee({
      damage: 22,
      damageType: 'blunt',
      range: 52,
      attackTicks: seconds(0.9),
      arcDegrees: 85,
      knockback: 140,
      staminaCost: 9,
      critChance: 0.14,
      critMultiplier: 2.1,
      armorPen: 0.18,
      maxTargets: 2,
      durabilityPerHit: 2,
    }),
    tags: [],
  }),
  item({
    id: 'machete',
    category: 'weapon',
    stackSize: 1,
    weight: 1,
    maxDurability: 220,
    rarity: 'uncommon',
    weapon: melee({
      damage: 25,
      damageType: 'slash',
      range: 50,
      attackTicks: seconds(0.7),
      arcDegrees: 80,
      staminaCost: 7,
      critChance: 0.12,
      critMultiplier: 2.2,
      armorPen: 0.15,
      maxTargets: 2,
      blockReduction: 0.15,
    }),
    tags: [],
  }),
  item({
    id: 'spear',
    category: 'weapon',
    stackSize: 1,
    weight: 1.7,
    maxDurability: 110,
    weapon: melee({
      damage: 20,
      damageType: 'pierce',
      range: 74,
      attackTicks: seconds(1),
      arcDegrees: 30,
      knockback: 100,
      staminaCost: 8,
      critChance: 0.1,
      critMultiplier: 2.4,
      armorPen: 0.2,
      twoHanded: true,
      durabilityPerHit: 2,
    }),
    tags: ['tier1'],
  }),
  item({
    id: 'iron_sword',
    category: 'weapon',
    stackSize: 1,
    weight: 1.9,
    maxDurability: 320,
    rarity: 'uncommon',
    weapon: melee({
      damage: 31,
      damageType: 'slash',
      range: 54,
      attackTicks: seconds(0.8),
      arcDegrees: 95,
      knockback: 110,
      staminaCost: 9,
      critChance: 0.13,
      critMultiplier: 2.3,
      armorPen: 0.2,
      maxTargets: 3,
      blockReduction: 0.35,
    }),
    tags: [],
  }),
  item({
    id: 'sledgehammer',
    category: 'weapon',
    stackSize: 1,
    weight: 5.5,
    maxDurability: 280,
    weapon: melee({
      damage: 38,
      damageType: 'blunt',
      range: 56,
      attackTicks: seconds(1.7),
      windupTicks: seconds(0.5),
      arcDegrees: 110,
      knockback: 260,
      staminaCost: 18,
      critChance: 0.08,
      critMultiplier: 2,
      armorPen: 0.3,
      maxTargets: 3,
      loudness: 320,
      twoHanded: true,
    }),
    tags: ['demolition'],
  }),
  item({
    id: 'crowbar',
    category: 'weapon',
    stackSize: 1,
    weight: 2.3,
    maxDurability: 340,
    weapon: melee({
      damage: 18,
      damageType: 'blunt',
      range: 44,
      attackTicks: seconds(0.85),
      knockback: 120,
      staminaCost: 8,
      armorPen: 0.12,
      blockReduction: 0.25,
    }),
    tags: ['pry'],
  }),
  item({
    id: 'kitchen_knife',
    category: 'weapon',
    stackSize: 1,
    weight: 0.3,
    maxDurability: 80,
    tool: { kinds: ['knife'], tier: 1, efficiency: 1.1, durabilityPerUse: 1 },
    weapon: melee({
      damage: 11,
      damageType: 'slash',
      range: 32,
      attackTicks: seconds(0.5),
      staminaCost: 4,
      critChance: 0.16,
      critMultiplier: 2.5,
      knockback: 15,
    }),
    tags: [],
  }),
  item({
    id: 'pitchfork',
    category: 'weapon',
    stackSize: 1,
    weight: 2.6,
    maxDurability: 150,
    weapon: melee({
      damage: 19,
      damageType: 'pierce',
      range: 70,
      attackTicks: seconds(1.05),
      arcDegrees: 40,
      knockback: 130,
      staminaCost: 9,
      armorPen: 0.12,
      maxTargets: 2,
      twoHanded: true,
    }),
    tags: [],
  }),
];

// ---------------------------------------------------------------------------
// Ranged weapons and ammunition
//
// A firearm's `loudness` is the whole balance lever for late game: 4 000-6 400 px is
// four to six chunks of zombies turning towards the noise. `weapon.projectileDefId`
// is only the fallback for the default ammunition - the loaded round's own
// `projectileDefId` wins, which is how iron arrows out-perform wooden ones from the
// same bow.
// ---------------------------------------------------------------------------

const RANGED_WEAPONS: ItemSource[] = [
  item({
    id: 'hunting_bow',
    category: 'weapon',
    stackSize: 1,
    weight: 1.2,
    maxDurability: 220,
    weapon: ranged({
      damage: 22,
      damageType: 'pierce',
      range: 640,
      ammoDefIds: ['arrow_wooden', 'arrow_iron'],
      projectileDefId: 'arrow_wooden',
      attackTicks: seconds(1.5),
      windupTicks: seconds(0.6),
      staminaCost: 6,
      magazineSize: 1,
      reloadTicks: seconds(1.3),
      spreadDegrees: 4,
      loudness: 260,
      critChance: 0.12,
      critMultiplier: 2.5,
      armorPen: 0.1,
    }),
    tags: ['tier1', 'quiet'],
  }),
  item({
    id: 'crossbow',
    category: 'weapon',
    stackSize: 1,
    weight: 3,
    maxDurability: 260,
    rarity: 'uncommon',
    weapon: ranged({
      damage: 34,
      damageType: 'pierce',
      range: 760,
      ammoDefIds: ['bolt'],
      projectileDefId: 'bolt',
      attackTicks: seconds(1.1),
      windupTicks: seconds(0.25),
      staminaCost: 4,
      magazineSize: 1,
      reloadTicks: seconds(3),
      spreadDegrees: 2,
      loudness: 240,
      critChance: 0.15,
      critMultiplier: 2.6,
      armorPen: 0.3,
    }),
    tags: ['quiet'],
  }),
  item({
    id: 'pistol_9mm',
    category: 'weapon',
    stackSize: 1,
    weight: 1,
    maxDurability: 420,
    rarity: 'rare',
    weapon: ranged({
      damage: 26,
      damageType: 'bullet',
      range: 900,
      ammoDefIds: ['ammo_9mm'],
      projectileDefId: 'bullet_9mm',
      attackTicks: seconds(0.35),
      magazineSize: 15,
      reloadTicks: seconds(2.5),
      spreadDegrees: 3.5,
      loudness: 4200,
      twoHanded: false,
      armorPen: 0.25,
    }),
    tags: ['firearm', 'loud'],
  }),
  item({
    id: 'rifle_308',
    category: 'weapon',
    stackSize: 1,
    weight: 3.8,
    maxDurability: 420,
    rarity: 'rare',
    weapon: ranged({
      damage: 58,
      damageType: 'bullet',
      range: 1600,
      ammoDefIds: ['ammo_308'],
      projectileDefId: 'bullet_308',
      attackTicks: seconds(1.2),
      windupTicks: seconds(0.3),
      magazineSize: 5,
      reloadTicks: seconds(3.5),
      spreadDegrees: 1.2,
      loudness: 6400,
      critChance: 0.14,
      critMultiplier: 2.8,
      armorPen: 0.45,
    }),
    tags: ['firearm', 'loud'],
  }),
  item({
    id: 'shotgun',
    category: 'weapon',
    stackSize: 1,
    weight: 3.4,
    maxDurability: 380,
    rarity: 'rare',
    weapon: ranged({
      damage: 15,
      damageType: 'bullet',
      range: 420,
      ammoDefIds: ['ammo_shell'],
      projectileDefId: 'pellet',
      attackTicks: seconds(0.9),
      magazineSize: 6,
      reloadTicks: seconds(4.5),
      spreadDegrees: 12,
      pellets: 8,
      loudness: 5600,
      knockback: 130,
      armorPen: 0.15,
    }),
    tags: ['firearm', 'loud'],
  }),
  item({
    id: 'molotov',
    category: 'weapon',
    stackSize: 1,
    weight: 0.9,
    weapon: thrown({
      damage: 42,
      damageType: 'fire',
      range: 420,
      projectileDefId: 'molotov_flask',
      attackTicks: seconds(1.4),
      loudness: 900,
      knockback: 0,
      maxTargets: 6,
    }),
    tags: ['flammable', 'explosive'],
  }),
  item({
    id: 'throwing_rock',
    category: 'weapon',
    stackSize: 1,
    weight: 0.5,
    weapon: thrown({
      damage: 7,
      damageType: 'blunt',
      range: 300,
      projectileDefId: 'thrown_rock',
      attackTicks: seconds(0.9),
      loudness: 420,
      staminaCost: 4,
    }),
    tags: ['tier1', 'distraction'],
  }),
];

const AMMO: ItemSource[] = [
  item({
    id: 'arrow_wooden',
    category: 'ammo',
    weight: 0.05,
    stackSize: 40,
    projectileDefId: 'arrow_wooden',
    tags: ['arrow'],
  }),
  item({
    id: 'arrow_iron',
    category: 'ammo',
    weight: 0.08,
    stackSize: 40,
    projectileDefId: 'arrow_iron',
    tags: ['arrow'],
  }),
  item({
    id: 'bolt',
    category: 'ammo',
    weight: 0.07,
    stackSize: 40,
    projectileDefId: 'bolt',
    tags: ['bolt'],
  }),
  item({
    id: 'ammo_9mm',
    category: 'ammo',
    weight: 0.012,
    stackSize: 120,
    rarity: 'uncommon',
    projectileDefId: 'bullet_9mm',
    tags: ['bullet'],
  }),
  item({
    id: 'ammo_308',
    category: 'ammo',
    weight: 0.024,
    stackSize: 80,
    rarity: 'rare',
    projectileDefId: 'bullet_308',
    tags: ['bullet'],
  }),
  item({
    id: 'ammo_shell',
    category: 'ammo',
    weight: 0.045,
    stackSize: 60,
    rarity: 'uncommon',
    projectileDefId: 'pellet',
    tags: ['bullet'],
  }),
];

// ---------------------------------------------------------------------------
// Armour and carry gear
//
// `coverage` is per body part, `protection` is flat reduction per damage type
// *before* penetration. `biteResistance` multiplies a zombie bite's chance of
// reaching skin, so 1 = no help at all and 0.1 = almost bite-proof.
// ---------------------------------------------------------------------------

const ARMOR: ItemSource[] = [
  item({
    id: 'leather_cap',
    category: 'armor',
    stackSize: 1,
    weight: 0.3,
    maxDurability: 120,
    armor: armor({
      slot: 'head',
      coverage: { head: 0.6 },
      protection: { blunt: 2, slash: 1 },
      warmth: 2,
      biteResistance: 0.8,
    }),
    tags: [],
  }),
  item({
    id: 'hard_hat',
    category: 'armor',
    stackSize: 1,
    weight: 0.5,
    maxDurability: 220,
    armor: armor({
      slot: 'head',
      coverage: { head: 0.75 },
      protection: { blunt: 6, slash: 2, fall: 4 },
      warmth: 1,
      biteResistance: 0.6,
    }),
    tags: [],
  }),
  item({
    id: 'motorcycle_helmet',
    category: 'armor',
    stackSize: 1,
    weight: 1.4,
    maxDurability: 300,
    rarity: 'uncommon',
    armor: armor({
      slot: 'head',
      coverage: { head: 0.95 },
      protection: { blunt: 9, slash: 6, pierce: 4, zombieBite: 8, fall: 6 },
      warmth: 4,
      encumbrance: 0.03,
      biteResistance: 0.15,
    }),
    tags: [],
  }),
  item({
    id: 'gas_mask',
    category: 'armor',
    stackSize: 1,
    weight: 0.8,
    maxDurability: 160,
    rarity: 'rare',
    armor: armor({
      slot: 'face',
      coverage: { head: 0.25 },
      protection: { poison: 24, suffocation: 20, infection: 4 },
      warmth: 1,
      encumbrance: 0.02,
      biteResistance: 0.7,
    }),
    tags: [],
  }),
  item({
    id: 'cloth_shirt',
    category: 'armor',
    stackSize: 1,
    weight: 0.4,
    maxDurability: 110,
    armor: armor({
      slot: 'chest',
      coverage: { torso: 0.9, leftArm: 0.6, rightArm: 0.6 },
      protection: { blunt: 1, cold: 1 },
      warmth: 4,
    }),
    tags: ['tier1'],
  }),
  item({
    id: 'leather_jacket',
    category: 'armor',
    stackSize: 1,
    weight: 2.2,
    maxDurability: 260,
    armor: armor({
      slot: 'chest',
      coverage: { torso: 0.95, leftArm: 0.85, rightArm: 0.85 },
      protection: { slash: 5, blunt: 3, pierce: 3, zombieBite: 6, cold: 3 },
      warmth: 9,
      encumbrance: 0.02,
      biteResistance: 0.45,
      durabilityPerHit: 1,
    }),
    tags: [],
  }),
  item({
    id: 'kevlar_vest',
    category: 'armor',
    stackSize: 1,
    weight: 3.6,
    maxDurability: 400,
    rarity: 'rare',
    armor: armor({
      slot: 'chest',
      coverage: { torso: 0.95 },
      protection: { bullet: 14, slash: 8, pierce: 9, blunt: 5, zombieBite: 12 },
      warmth: 5,
      encumbrance: 0.06,
      biteResistance: 0.2,
    }),
    tags: [],
  }),
  item({
    id: 'plate_carrier',
    category: 'armor',
    stackSize: 1,
    weight: 8,
    maxDurability: 520,
    rarity: 'epic',
    armor: armor({
      slot: 'chest',
      coverage: { torso: 1, leftArm: 0.3, rightArm: 0.3 },
      protection: { bullet: 20, slash: 12, pierce: 14, blunt: 9, explosive: 8, zombieBite: 16 },
      warmth: 6,
      encumbrance: 0.12,
      biteResistance: 0.1,
    }),
    tags: [],
  }),
  item({
    id: 'cloth_pants',
    category: 'armor',
    stackSize: 1,
    weight: 0.4,
    maxDurability: 110,
    armor: armor({
      slot: 'legs',
      coverage: { leftLeg: 0.85, rightLeg: 0.85 },
      protection: { blunt: 1, cold: 1 },
      warmth: 4,
    }),
    tags: ['tier1'],
  }),
  item({
    id: 'jeans',
    category: 'armor',
    stackSize: 1,
    weight: 0.7,
    maxDurability: 170,
    armor: armor({
      slot: 'legs',
      coverage: { leftLeg: 0.9, rightLeg: 0.9 },
      protection: { blunt: 2, slash: 2, zombieBite: 2 },
      warmth: 5,
      biteResistance: 0.7,
    }),
    tags: [],
  }),
  item({
    id: 'leather_pants',
    category: 'armor',
    stackSize: 1,
    weight: 1.8,
    maxDurability: 250,
    armor: armor({
      slot: 'legs',
      coverage: { leftLeg: 0.9, rightLeg: 0.9 },
      protection: { slash: 4, pierce: 3, blunt: 3, zombieBite: 5, cold: 2 },
      warmth: 7,
      encumbrance: 0.02,
      biteResistance: 0.5,
    }),
    tags: [],
  }),
  item({
    id: 'work_boots',
    category: 'armor',
    stackSize: 1,
    weight: 1.5,
    maxDurability: 280,
    armor: armor({
      slot: 'feet',
      coverage: { leftLeg: 0.25, rightLeg: 0.25 },
      protection: { blunt: 3, pierce: 3, fall: 3, cold: 2 },
      warmth: 4,
      biteResistance: 0.5,
    }),
    tags: [],
  }),
  item({
    id: 'leather_gloves',
    category: 'armor',
    stackSize: 1,
    weight: 0.2,
    maxDurability: 150,
    armor: armor({
      slot: 'hands',
      coverage: { leftArm: 0.3, rightArm: 0.3 },
      protection: { slash: 2, blunt: 1, zombieBite: 2 },
      warmth: 2,
      biteResistance: 0.65,
    }),
    tags: [],
  }),
  item({
    id: 'work_gloves',
    category: 'armor',
    stackSize: 1,
    weight: 0.25,
    maxDurability: 210,
    armor: armor({
      slot: 'hands',
      coverage: { leftArm: 0.35, rightArm: 0.35 },
      protection: { slash: 3, blunt: 2, pierce: 1, zombieBite: 3 },
      warmth: 2,
      biteResistance: 0.55,
    }),
    tags: [],
  }),
  item({
    id: 'backpack_small',
    category: 'container',
    stackSize: 1,
    weight: 0.8,
    maxDurability: 220,
    containerSlots: 8,
    armor: armor({
      slot: 'back',
      coverage: { torso: 0.2 },
      protection: { blunt: 1 },
      warmth: 1,
      encumbrance: 0.02,
    }),
    tags: ['carry'],
  }),
  item({
    id: 'backpack_large',
    category: 'container',
    stackSize: 1,
    weight: 1.8,
    maxDurability: 280,
    rarity: 'uncommon',
    containerSlots: 16,
    armor: armor({
      slot: 'back',
      coverage: { torso: 0.3 },
      protection: { blunt: 2 },
      warmth: 2,
      encumbrance: 0.05,
    }),
    tags: ['carry'],
  }),
  item({
    id: 'tool_belt',
    category: 'container',
    stackSize: 1,
    weight: 0.6,
    maxDurability: 240,
    containerSlots: 4,
    armor: armor({
      slot: 'back',
      coverage: {},
      protection: {},
      warmth: 0,
      encumbrance: 0,
    }),
    tags: ['carry', 'tier1'],
  }),
];

// ---------------------------------------------------------------------------
// Food
//
// Raw meat, raw fish and wild mushrooms carry a real `sicknessChance`: eating them
// is a gamble you take when the alternative is starving, not a shortcut around
// cooking.
// ---------------------------------------------------------------------------

const FOOD: ItemSource[] = [
  item({
    id: 'berry',
    category: 'food',
    weight: 0.1,
    stackSize: 30,
    food: food({ nutrition: 6, hydration: 3, eatTicks: seconds(1) }),
    perishable: spoils(3),
    tags: ['forage', 'fruit'],
  }),
  item({
    id: 'apple',
    category: 'food',
    weight: 0.2,
    stackSize: 20,
    food: food({ nutrition: 9, hydration: 6, eatTicks: seconds(1.5) }),
    perishable: spoils(6),
    tags: ['forage', 'fruit'],
  }),
  item({
    id: 'mushroom',
    category: 'food',
    weight: 0.1,
    stackSize: 20,
    food: food({ nutrition: 5, hydration: 1, sicknessChance: 0.28, eatTicks: seconds(1.2) }),
    perishable: spoils(2.5),
    tags: ['forage', 'raw_food'],
  }),
  item({
    id: 'raw_meat',
    category: 'food',
    weight: 0.5,
    stackSize: 10,
    food: food({ nutrition: 15, sicknessChance: 0.45, eatTicks: seconds(2.5) }),
    perishable: spoils(1.5),
    tags: ['meat', 'raw_food'],
  }),
  item({
    id: 'cooked_meat',
    category: 'food',
    weight: 0.4,
    stackSize: 10,
    food: food({
      nutrition: 32,
      stamina: 6,
      health: 2,
      sicknessChance: 0.01,
      eatTicks: seconds(2.5),
    }),
    perishable: spoils(4),
    tags: ['meat', 'cooked'],
  }),
  item({
    id: 'raw_fish',
    category: 'food',
    weight: 0.4,
    stackSize: 10,
    food: food({ nutrition: 12, hydration: 2, sicknessChance: 0.4, eatTicks: seconds(2.5) }),
    perishable: spoils(1),
    tags: ['meat', 'raw_food', 'fish'],
  }),
  item({
    id: 'cooked_fish',
    category: 'food',
    weight: 0.35,
    stackSize: 10,
    food: food({
      nutrition: 25,
      hydration: 3,
      stamina: 4,
      sicknessChance: 0.01,
      eatTicks: seconds(2.5),
    }),
    perishable: spoils(3),
    tags: ['meat', 'cooked', 'fish'],
  }),
  item({
    id: 'egg',
    category: 'food',
    weight: 0.06,
    stackSize: 20,
    food: food({ nutrition: 9, sicknessChance: 0.14, eatTicks: seconds(1.5) }),
    perishable: spoils(5),
    tags: ['ingredient'],
  }),
  item({
    id: 'flour',
    category: 'food',
    weight: 0.4,
    stackSize: 20,
    food: food({ nutrition: 3, sicknessChance: 0.15, eatTicks: seconds(2) }),
    tags: ['ingredient'],
  }),
  item({
    id: 'dough',
    category: 'food',
    weight: 0.5,
    stackSize: 10,
    food: food({ nutrition: 7, sicknessChance: 0.1, eatTicks: seconds(2) }),
    perishable: spoils(1.5),
    tags: ['ingredient'],
  }),
  item({
    id: 'bread',
    category: 'food',
    weight: 0.4,
    stackSize: 10,
    food: food({ nutrition: 28, stamina: 5, eatTicks: seconds(2.5) }),
    perishable: spoils(7),
    tags: ['cooked'],
  }),
  item({
    id: 'baked_potato',
    category: 'food',
    weight: 0.3,
    stackSize: 10,
    food: food({ nutrition: 23, hydration: 3, stamina: 4, eatTicks: seconds(2) }),
    perishable: spoils(4),
    tags: ['cooked', 'vegetable'],
  }),
  item({
    id: 'soup_vegetable',
    category: 'food',
    weight: 0.6,
    stackSize: 10,
    food: food({ nutrition: 22, hydration: 26, health: 2, eatTicks: seconds(3) }),
    perishable: spoils(2),
    tags: ['cooked', 'vegetable'],
  }),
  item({
    id: 'stew_meat',
    category: 'food',
    weight: 0.8,
    stackSize: 10,
    food: food({ nutrition: 42, hydration: 18, stamina: 12, health: 5, eatTicks: seconds(3.5) }),
    perishable: spoils(2.5),
    tags: ['cooked', 'meat'],
  }),
  item({
    id: 'jerky',
    category: 'food',
    weight: 0.12,
    stackSize: 30,
    food: food({ nutrition: 19, stamina: 5, eatTicks: seconds(2.5) }),
    tags: ['cooked', 'meat', 'preserved'],
  }),
  item({
    id: 'canned_beans',
    category: 'food',
    weight: 0.45,
    stackSize: 10,
    rarity: 'uncommon',
    food: food({ nutrition: 30, hydration: 8, eatTicks: seconds(3) }),
    tags: ['canned', 'preserved'],
  }),
  item({
    id: 'canned_soup',
    category: 'food',
    weight: 0.45,
    stackSize: 10,
    rarity: 'uncommon',
    food: food({ nutrition: 24, hydration: 22, eatTicks: seconds(3) }),
    tags: ['canned', 'preserved'],
  }),
  item({
    id: 'chocolate_bar',
    category: 'food',
    weight: 0.1,
    stackSize: 20,
    rarity: 'uncommon',
    food: food({ nutrition: 17, stamina: 18, eatTicks: seconds(1.2) }),
    tags: ['preserved'],
  }),
  item({
    id: 'energy_bar',
    category: 'food',
    weight: 0.08,
    stackSize: 20,
    rarity: 'uncommon',
    food: food({
      nutrition: 14,
      stamina: 30,
      eatTicks: seconds(0.8),
      effects: [{ id: 'adrenaline', durationTicks: gameHours(0.4), magnitude: 0.12 }],
    }),
    tags: ['preserved'],
  }),
];

// ---------------------------------------------------------------------------
// Produce (crop outputs that are also food)
// ---------------------------------------------------------------------------

const PRODUCE: ItemSource[] = [
  item({
    id: 'wheat',
    category: 'produce',
    weight: 0.2,
    stackSize: 30,
    food: food({ nutrition: 3, eatTicks: seconds(2), sicknessChance: 0.05 }),
    tags: ['crop', 'ingredient'],
  }),
  item({
    id: 'corn',
    category: 'produce',
    weight: 0.35,
    stackSize: 20,
    food: food({ nutrition: 11, hydration: 4, eatTicks: seconds(2) }),
    perishable: spoils(6),
    tags: ['crop', 'vegetable'],
  }),
  item({
    id: 'potato',
    category: 'produce',
    weight: 0.3,
    stackSize: 30,
    food: food({ nutrition: 8, sicknessChance: 0.1, eatTicks: seconds(2) }),
    tags: ['crop', 'vegetable'],
  }),
  item({
    id: 'carrot',
    category: 'produce',
    weight: 0.15,
    stackSize: 30,
    food: food({ nutrition: 7, hydration: 5, eatTicks: seconds(1.5) }),
    perishable: spoils(8),
    tags: ['crop', 'vegetable'],
  }),
  item({
    id: 'tomato',
    category: 'produce',
    weight: 0.15,
    stackSize: 20,
    food: food({ nutrition: 6, hydration: 10, eatTicks: seconds(1.2) }),
    perishable: spoils(3),
    tags: ['crop', 'vegetable'],
  }),
  item({
    id: 'cabbage',
    category: 'produce',
    weight: 0.7,
    stackSize: 10,
    food: food({ nutrition: 10, hydration: 6, eatTicks: seconds(2) }),
    perishable: spoils(9),
    tags: ['crop', 'vegetable'],
  }),
  item({
    id: 'pumpkin',
    category: 'produce',
    weight: 3.5,
    stackSize: 5,
    food: food({ nutrition: 16, hydration: 8, eatTicks: seconds(3) }),
    perishable: spoils(12),
    tags: ['crop', 'vegetable'],
  }),
  item({
    id: 'onion',
    category: 'produce',
    weight: 0.15,
    stackSize: 30,
    food: food({ nutrition: 5, hydration: 3, eatTicks: seconds(1.5) }),
    perishable: spoils(10),
    tags: ['crop', 'vegetable'],
  }),
  item({
    id: 'beans',
    category: 'produce',
    weight: 0.2,
    stackSize: 30,
    food: food({ nutrition: 10, sicknessChance: 0.08, eatTicks: seconds(2) }),
    perishable: spoils(7),
    tags: ['crop', 'vegetable'],
  }),
  item({
    id: 'herb',
    category: 'produce',
    weight: 0.05,
    stackSize: 40,
    food: food({ nutrition: 1, sicknessChance: 0.02, eatTicks: seconds(1) }),
    tags: ['crop', 'forage', 'medicinal'],
  }),
];

// ---------------------------------------------------------------------------
// Drinks
// ---------------------------------------------------------------------------

const DRINKS: ItemSource[] = [
  item({
    id: 'water_dirty',
    category: 'drink',
    weight: 0.5,
    stackSize: 10,
    drink: drink({ hydration: 30, sicknessChance: 0.35 }),
    tags: ['water'],
  }),
  item({
    id: 'water_clean',
    category: 'drink',
    weight: 0.5,
    stackSize: 10,
    drink: drink({ hydration: 34, sicknessChance: 0.01 }),
    tags: ['water', 'ingredient'],
  }),
  item({
    id: 'water_bottle',
    category: 'container',
    stackSize: 1,
    weight: 0.2,
    liquid: { capacity: 4, contentDefId: 'water_clean', fillable: true },
    tags: ['water', 'vessel'],
  }),
  item({
    id: 'canteen',
    category: 'container',
    stackSize: 1,
    weight: 0.5,
    rarity: 'uncommon',
    liquid: { capacity: 6, fillable: true },
    tags: ['water', 'vessel'],
  }),
  item({
    id: 'coffee',
    category: 'drink',
    weight: 0.3,
    stackSize: 10,
    rarity: 'uncommon',
    drink: drink({
      hydration: 20,
      nutrition: 2,
      effects: [
        { id: 'adrenaline', durationTicks: gameHours(1), magnitude: 0.1 },
        { id: 'well_rested', durationTicks: gameHours(1.5), magnitude: 0.35 },
      ],
    }),
    tags: ['brew'],
  }),
  item({
    id: 'tea_herbal',
    category: 'drink',
    weight: 0.3,
    stackSize: 10,
    drink: drink({
      hydration: 26,
      effects: [{ id: 'painkiller', durationTicks: gameHours(1.5), magnitude: 8 }],
    }),
    tags: ['brew', 'medicinal'],
  }),
  item({
    id: 'soda',
    category: 'drink',
    weight: 0.4,
    stackSize: 10,
    rarity: 'uncommon',
    drink: drink({ hydration: 18, nutrition: 9, effects: [] }),
    tags: [],
  }),
  item({
    id: 'alcohol_moonshine',
    category: 'drink',
    weight: 0.5,
    stackSize: 10,
    drink: drink({
      hydration: 4,
      nutrition: 3,
      sicknessChance: 0.05,
      effects: [{ id: 'painkiller', durationTicks: gameHours(2), magnitude: 22 }],
    }),
    medical: medical({
      kind: 'disinfect',
      infectionCure: 14,
      cleanliness: 0.85,
      useTicks: seconds(3),
      effects: [{ id: 'antiseptic', durationTicks: gameHours(3), magnitude: 0.5 }],
    }),
    tags: ['brew', 'flammable', 'medicinal'],
  }),
];

// ---------------------------------------------------------------------------
// Medical
//
// `cleanliness` is the whole infection subsystem in one number: a dirty rag stops the
// bleeding and then quietly starts something worse.
// ---------------------------------------------------------------------------

const MEDICAL: ItemSource[] = [
  item({
    id: 'bandage_dirty',
    category: 'medical',
    weight: 0.05,
    stackSize: 20,
    medical: medical({
      kind: 'bandage',
      bleedStop: 0.7,
      heal: 2,
      cleanliness: 0.15,
      useTicks: seconds(2),
      effects: [{ id: 'bandaged', durationTicks: gameHours(6), magnitude: 0.15 }],
    }),
    tags: ['bandage', 'tier1'],
  }),
  item({
    id: 'bandage_clean',
    category: 'medical',
    weight: 0.05,
    stackSize: 20,
    medical: medical({
      kind: 'bandage',
      bleedStop: 0.85,
      heal: 4,
      cleanliness: 0.6,
      useTicks: seconds(2),
      effects: [{ id: 'bandaged', durationTicks: gameHours(8), magnitude: 0.6 }],
    }),
    tags: ['bandage'],
  }),
  item({
    id: 'bandage_sterile',
    category: 'medical',
    weight: 0.05,
    stackSize: 20,
    rarity: 'uncommon',
    medical: medical({
      kind: 'bandage',
      bleedStop: 0.95,
      heal: 7,
      infectionCure: 8,
      cleanliness: 1,
      useTicks: seconds(2.5),
      effects: [{ id: 'bandaged', durationTicks: gameHours(12), magnitude: 1 }],
    }),
    tags: ['bandage'],
  }),
  item({
    id: 'disinfected_rag',
    category: 'medical',
    weight: 0.05,
    stackSize: 20,
    medical: medical({
      kind: 'bandage',
      bleedStop: 0.8,
      heal: 3,
      infectionCure: 5,
      cleanliness: 0.85,
      useTicks: seconds(2),
      effects: [{ id: 'bandaged', durationTicks: gameHours(8), magnitude: 0.8 }],
    }),
    tags: ['bandage'],
  }),
  item({
    id: 'suture_kit',
    category: 'medical',
    stackSize: 1,
    weight: 0.2,
    maxDurability: 5,
    rarity: 'uncommon',
    medical: medical({
      kind: 'suture',
      bleedStop: 1,
      heal: 12,
      cleanliness: 0.9,
      useTicks: seconds(8),
      skillLevel: 3,
    }),
    tags: [],
  }),
  item({
    id: 'splint_wood',
    category: 'medical',
    weight: 0.4,
    stackSize: 10,
    medical: medical({
      kind: 'splint',
      heal: 2,
      fixesFracture: true,
      cleanliness: 0.3,
      useTicks: seconds(6),
      skillLevel: 1,
    }),
    tags: ['tier1'],
  }),
  item({
    id: 'splint_medical',
    category: 'medical',
    weight: 0.5,
    stackSize: 10,
    rarity: 'uncommon',
    medical: medical({
      kind: 'splint',
      heal: 6,
      painRelief: 8,
      fixesFracture: true,
      cleanliness: 0.8,
      useTicks: seconds(5),
    }),
    tags: [],
  }),
  item({
    id: 'antiseptic',
    category: 'medical',
    weight: 0.2,
    stackSize: 10,
    medical: medical({
      kind: 'disinfect',
      infectionCure: 26,
      cleanliness: 1,
      useTicks: seconds(3),
      effects: [{ id: 'antiseptic', durationTicks: gameHours(8), magnitude: 1 }],
    }),
    tags: [],
  }),
  item({
    id: 'antibiotics',
    category: 'medical',
    weight: 0.05,
    stackSize: 10,
    rarity: 'rare',
    medical: medical({
      kind: 'pill',
      infectionCure: 60,
      useTicks: seconds(1.5),
      effects: [{ id: 'antibiotic', durationTicks: gameHours(12), magnitude: 1 }],
    }),
    tags: [],
  }),
  item({
    id: 'painkiller',
    category: 'medical',
    weight: 0.02,
    stackSize: 20,
    medical: medical({
      kind: 'pill',
      painRelief: 45,
      useTicks: seconds(1.5),
      effects: [{ id: 'painkiller', durationTicks: gameHours(4), magnitude: 45 }],
    }),
    tags: [],
  }),
  item({
    id: 'morphine',
    category: 'medical',
    weight: 0.05,
    stackSize: 5,
    rarity: 'rare',
    medical: medical({
      kind: 'injection',
      painRelief: 95,
      heal: 4,
      useTicks: seconds(2.5),
      effects: [{ id: 'painkiller', durationTicks: gameHours(8), magnitude: 95 }],
    }),
    tags: [],
  }),
  item({
    id: 'vitamins',
    category: 'medical',
    weight: 0.1,
    stackSize: 10,
    medical: medical({
      kind: 'pill',
      heal: 4,
      infectionCure: 4,
      useTicks: seconds(1.5),
      effects: [{ id: 'well_fed', durationTicks: gameHours(8), magnitude: 0.2 }],
    }),
    tags: [],
  }),
  item({
    id: 'first_aid_kit',
    category: 'medical',
    stackSize: 1,
    weight: 1.2,
    maxDurability: 3,
    rarity: 'uncommon',
    medical: medical({
      kind: 'bandage',
      bleedStop: 1,
      heal: 28,
      painRelief: 20,
      infectionCure: 22,
      cleanliness: 1,
      useTicks: seconds(7),
      effects: [{ id: 'bandaged', durationTicks: gameHours(12), magnitude: 1 }],
    }),
    tags: [],
  }),
];

// ---------------------------------------------------------------------------
// Seeds
// ---------------------------------------------------------------------------

interface SeedSpec {
  id: string;
  crop: string;
}

const SEED_SPECS: SeedSpec[] = [
  {
    id: 'seed_wheat',
    crop: 'wheat',
  },
  {
    id: 'seed_corn',
    crop: 'corn',
  },
  {
    id: 'seed_potato',
    crop: 'potato',
  },
  {
    id: 'seed_carrot',
    crop: 'carrot',
  },
  {
    id: 'seed_tomato',
    crop: 'tomato',
  },
  {
    id: 'seed_cabbage',
    crop: 'cabbage',
  },
  {
    id: 'seed_pumpkin',
    crop: 'pumpkin',
  },
  {
    id: 'seed_onion',
    crop: 'onion',
  },
  {
    id: 'seed_beans',
    crop: 'beans',
  },
  {
    id: 'seed_herb',
    crop: 'herb',
  },
];

const SEEDS: ItemSource[] = SEED_SPECS.map((spec) =>
  item({
    id: spec.id,
    category: 'seed',
    weight: 0.02,
    stackSize: 40,
    cropDefId: spec.crop,
    tags: ['seed', 'farming'],
  }),
);

// ---------------------------------------------------------------------------
// Placeables
//
// Walls, floors, doors and every other pure-cost structure are built straight from
// resources through the build menu, so they deliberately have no item form. Only
// things you carry as an object - a station, a box, a bed - get a "kit".
// ---------------------------------------------------------------------------

interface KitSpec {
  id: string;
  structure: string;
  weight: number;
  rarity?: ItemDef['rarity'];
  extraTags?: string[];
}

const KIT_SPECS: KitSpec[] = [
  {
    id: 'campfire_kit',
    structure: 'campfire',
    weight: 3,
    extraTags: ['tier1'],
  },
  {
    id: 'workbench_kit',
    structure: 'workbench',
    weight: 8,
    extraTags: ['tier1'],
  },
  {
    id: 'storage_box_kit',
    structure: 'storage_box',
    weight: 6,
  },
  {
    id: 'bed_kit',
    structure: 'bed_wood',
    weight: 12,
  },
  {
    id: 'farm_plot_kit',
    structure: 'farm_plot',
    weight: 5,
  },
  {
    id: 'water_barrel_kit',
    structure: 'water_barrel',
    weight: 9,
  },
  {
    id: 'furnace_kit',
    structure: 'furnace',
    weight: 22,
  },
  {
    id: 'anvil_kit',
    structure: 'anvil',
    weight: 30,
  },
  {
    id: 'loom_kit',
    structure: 'loom',
    weight: 10,
  },
  {
    id: 'cooking_pot_kit',
    structure: 'cooking_pot',
    weight: 6,
  },
  {
    id: 'grindstone_kit',
    structure: 'grindstone',
    weight: 18,
  },
  {
    id: 'chemistry_bench_kit',
    structure: 'chemistry_bench',
    weight: 14,
    rarity: 'uncommon',
  },
];

const PLACEABLES: ItemSource[] = [
  ...KIT_SPECS.map((spec) =>
    item({
      id: spec.id,
      category: 'placeable',
      stackSize: 5,
      weight: spec.weight,
      ...(spec.rarity ? { rarity: spec.rarity } : {}),
      placesStructureDefId: spec.structure,
      tags: ['kit', ...(spec.extraTags ?? [])],
    }),
  ),
  item({
    id: 'torch',
    category: 'placeable',
    // Deliberately stackable and durability-free: a torch's burn life lives in
    // `fuel.burnTicks`, which is what the wall socket's `light.fuel` is filled from and
    // what a held torch is consumed against. Giving it durability instead would force
    // `stackSize: 1` (see `maxStackSize()` in the simulation) and put five torches in
    // five inventory slots.
    stackSize: 10,
    weight: 0.6,
    placesStructureDefId: 'torch_wall',
    fuel: { burnTicks: 1200, heat: 8 },
    tags: ['light', 'light_source', 'fuel', 'tier1'],
  }),
  item({
    id: 'lantern',
    category: 'placeable',
    stackSize: 1,
    weight: 1.4,
    maxDurability: 900,
    placesStructureDefId: 'lantern_post',
    tags: ['light', 'light_source'],
  }),
];

// ---------------------------------------------------------------------------
// Misc: schematics, tools of the trade, navigation
//
// Schematics carry an `unlocks:<recipeId>` tag rather than a dedicated field, because
// `ItemDef` has no unlock slot. `validateGameData` resolves every one of those tags
// against the recipe table, so a renamed recipe cannot leave a dead schematic behind.
// ---------------------------------------------------------------------------

interface SchematicSpec {
  id: string;
  unlocks: string[];
}

const SCHEMATIC_SPECS: SchematicSpec[] = [
  {
    id: 'schematic_steel',
    unlocks: ['smelt_steel_ingot', 'forge_steel_axe', 'forge_steel_pickaxe'],
  },
  {
    id: 'schematic_crossbow',
    unlocks: ['craft_crossbow'],
  },
  {
    id: 'schematic_ammunition',
    unlocks: ['forge_ammo_9mm', 'forge_ammo_308', 'forge_ammo_shell'],
  },
  {
    id: 'schematic_medicine',
    unlocks: ['make_antibiotics', 'make_first_aid_kit'],
  },
];

const MISC: ItemSource[] = [
  ...SCHEMATIC_SPECS.map((spec) =>
    item({
      id: spec.id,
      category: 'misc',
      stackSize: 1,
      weight: 0.1,
      rarity: 'rare',
      tags: ['schematic', ...spec.unlocks.map((recipe) => `unlocks:${recipe}`)],
    }),
  ),
  item({
    id: 'door_key',
    category: 'misc',
    stackSize: 10,
    weight: 0.02,
    tags: ['key'],
  }),
  item({
    id: 'lockpick',
    category: 'misc',
    stackSize: 1,
    weight: 0.05,
    maxDurability: 12,
    tags: ['key'],
  }),
  item({
    id: 'compass',
    category: 'misc',
    stackSize: 1,
    weight: 0.1,
    rarity: 'uncommon',
    tags: ['navigation'],
  }),
  item({
    id: 'map',
    category: 'misc',
    stackSize: 1,
    weight: 0.1,
    rarity: 'uncommon',
    tags: ['navigation'],
  }),
  item({
    id: 'radio',
    category: 'misc',
    stackSize: 1,
    weight: 0.9,
    rarity: 'rare',
    tags: ['electronic'],
  }),
  item({
    id: 'flashlight',
    category: 'misc',
    stackSize: 1,
    weight: 0.4,
    maxDurability: 500,
    rarity: 'uncommon',
    tags: ['light', 'light_source', 'electronic'],
  }),
];

// ---------------------------------------------------------------------------

/** Every item definition in the game, in build-menu-ish reading order. */
export const ITEM_DEFS: readonly ItemSource[] = [
  ...RESOURCES,
  ...TOOLS,
  ...MELEE_WEAPONS,
  ...RANGED_WEAPONS,
  ...AMMO,
  ...ARMOR,
  ...FOOD,
  ...PRODUCE,
  ...DRINKS,
  ...MEDICAL,
  ...SEEDS,
  ...PLACEABLES,
  ...MISC,
];
