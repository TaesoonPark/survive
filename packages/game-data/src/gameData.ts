import {
  BODY_PART_IDS,
  Biome,
  EQUIP_SLOTS,
  SEASONS,
  SKILL_IDS,
  hashString,
  mixSeeds,
  stableStringify,
} from '@survive/protocol';
import type { BiomeId, DamageType, StatusEffectId } from '@survive/protocol';
import { compareIds, createRegistry } from './registry';
import type {
  AnimalDef,
  CropDef,
  EffectGrant,
  GameData,
  ItemDef,
  LootEntry,
  LootTableDef,
  PlacementSurface,
  ProjectileDef,
  RecipeDef,
  ResourceNodeDef,
  StationKind,
  StructureCategory,
  StructureDef,
  ToolKind,
  ZombieDef,
  AnimalSource,
  CropSource,
  ItemSource,
  RecipeSource,
  ResourceNodeSource,
  StructureSource,
  ZombieSource,
} from './types';
import {
  DEFAULT_LOCALE,
  localize,
  localizeDescribed,
  type DisplayText,
  type Locale,
} from './strings';
import { ITEM_DEFS } from './defs/items';
import { RECIPE_DEFS } from './defs/recipes';
import { STRUCTURE_DEFS } from './defs/structures';
import { RESOURCE_NODE_DEFS } from './defs/nodes';
import { CROP_DEFS } from './defs/crops';
import { ZOMBIE_DEFS } from './defs/zombies';
import { ANIMAL_DEFS } from './defs/animals';
import { PROJECTILE_DEFS } from './defs/projectiles';
import { LOOT_TABLE_DEFS } from './defs/loot';

/**
 * Assembling and validating the content tables.
 *
 * The tables are authored as independent arrays that reference each other by string id,
 * which is the only sane way to keep them readable - and also the only way to get a
 * dangling reference. `validateGameData` is the price of that trade: it walks every
 * cross-reference in the game exactly once, at startup, and throws with *all* the
 * problems rather than the first, because content bugs come in batches (one renamed
 * item breaks nine recipes).
 *
 * The alternative - importing definitions directly instead of by id - would make the
 * tables un-serializable and would put load order in charge of correctness. This is
 * cheaper and it fails loudly.
 */

/** The raw arrays behind a {@link GameData}. Overridable so tests can inject bad data. */
export interface GameDataTables {
  items: readonly ItemSource[];
  recipes: readonly RecipeSource[];
  structures: readonly StructureSource[];
  nodes: readonly ResourceNodeSource[];
  zombies: readonly ZombieSource[];
  animals: readonly AnimalSource[];
  crops: readonly CropSource[];
  projectiles: readonly ProjectileDef[];
  lootTables: readonly LootTableDef[];
}

/** The same tables once the locale has supplied every name and description. */
export interface LocalizedTables extends GameDataTables {
  items: readonly ItemDef[];
  recipes: readonly RecipeDef[];
  structures: readonly StructureDef[];
  nodes: readonly ResourceNodeDef[];
  zombies: readonly ZombieDef[];
  animals: readonly AnimalDef[];
  crops: readonly CropDef[];
}

/**
 * Merge display text into every table.
 *
 * Applied *after* overrides rather than inside {@link defaultTables}, so a caller that
 * swaps in its own content - a test injecting a structure, a mod - gets the same treatment
 * as the shipped tables instead of silently ending up with untranslated entries beside
 * translated ones.
 */
export function localizeTables(
  tables: GameDataTables,
  locale: Locale = DEFAULT_LOCALE,
): LocalizedTables {
  return {
    ...tables,
    items: localizeDescribed('items', tables.items, locale),
    recipes: localize('recipes', tables.recipes, locale),
    structures: localizeDescribed('structures', tables.structures, locale),
    nodes: localize('nodes', tables.nodes, locale),
    zombies: localize('zombies', tables.zombies, locale),
    animals: localize('animals', tables.animals, locale),
    crops: localize('crops', tables.crops, locale),
  };
}

/**
 * The shipped content tables, as authored: numbers, no words.
 *
 * Text is merged in by {@link localizeTables}. Projectiles and loot tables take none -
 * neither is ever named to the player.
 */
export function defaultTables(): GameDataTables {
  return {
    items: ITEM_DEFS,
    recipes: RECIPE_DEFS,
    structures: STRUCTURE_DEFS,
    nodes: RESOURCE_NODE_DEFS,
    zombies: ZOMBIE_DEFS,
    animals: ANIMAL_DEFS,
    crops: CROP_DEFS,
    projectiles: PROJECTILE_DEFS,
    lootTables: LOOT_TABLE_DEFS,
  };
}

/** Thrown by {@link validateGameData}. Carries every problem, not just the first. */
export class GameDataValidationError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(
      `game-data validation failed with ${problems.length} problem(s):\n  - ${problems.join('\n  - ')}`,
    );
    this.name = 'GameDataValidationError';
    this.problems = problems;
  }
}

// ---------------------------------------------------------------------------
// Enumerations that protocol does not export as arrays
// ---------------------------------------------------------------------------

/**
 * Turn an exhaustive key witness into the runtime array of a string union.
 *
 * The validator has to check values that arrive as plain JSON (a save file, a mod, a
 * hand-built test table), so it needs these unions at runtime - but a hand-written
 * `readonly DamageType[]` only fails to compile when a member is *removed*. Adding
 * `'radiation'` to `DamageType` would leave the list quietly incomplete and the
 * validator would start rejecting valid content. `Record<T, true>` makes the omission
 * a compile error instead, which is the only version of this that stays correct.
 */
function unionMembers<T extends string>(witness: Record<T, true>): readonly T[] {
  return Object.keys(witness) as T[];
}

const DAMAGE_TYPES = unionMembers<DamageType>({
  blunt: true,
  slash: true,
  pierce: true,
  bullet: true,
  explosive: true,
  fire: true,
  bleed: true,
  infection: true,
  starvation: true,
  dehydration: true,
  exhaustion: true,
  cold: true,
  heat: true,
  fall: true,
  poison: true,
  zombieBite: true,
  suffocation: true,
});

const STATUS_EFFECTS = unionMembers<StatusEffectId>({
  well_fed: true,
  hydrated: true,
  well_rested: true,
  painkiller: true,
  antibiotic: true,
  antiseptic: true,
  adrenaline: true,
  bandaged: true,
  fever: true,
  poisoned: true,
  food_poisoning: true,
  bleeding: true,
  exhausted: true,
  overencumbered: true,
  cold: true,
  hypothermia: true,
  hot: true,
  heatstroke: true,
  stunned: true,
  wet: true,
  sepsis: true,
  zombification: true,
});

const TOOL_KINDS = unionMembers<ToolKind>({
  axe: true,
  pickaxe: true,
  shovel: true,
  hoe: true,
  knife: true,
  hammer: true,
  saw: true,
  wateringCan: true,
  sickle: true,
  fishingRod: true,
  wrench: true,
  lighter: true,
});

const STATION_KINDS = unionMembers<StationKind>({
  workbench: true,
  campfire: true,
  furnace: true,
  anvil: true,
  loom: true,
  cookingPot: true,
  chemistry: true,
  grindstone: true,
});

const STRUCTURE_CATEGORIES = unionMembers<StructureCategory>({
  foundation: true,
  wall: true,
  door: true,
  window: true,
  floor: true,
  furniture: true,
  station: true,
  storage: true,
  farm: true,
  light: true,
  defense: true,
  bed: true,
  misc: true,
});

const PLACEMENT_SURFACES = unionMembers<PlacementSurface>({
  ground: true,
  floor: true,
  any: true,
  water: true,
});

const BIOME_IDS: readonly number[] = Object.values(Biome);
const DAMAGE_TYPE_SET = new Set<string>(DAMAGE_TYPES);
const STATUS_EFFECT_SET = new Set<string>(STATUS_EFFECTS);
const TOOL_KIND_SET = new Set<string>(TOOL_KINDS);
const STATION_KIND_SET = new Set<string>(STATION_KINDS);
const STRUCTURE_CATEGORY_SET = new Set<string>(STRUCTURE_CATEGORIES);
const PLACEMENT_SURFACE_SET = new Set<string>(PLACEMENT_SURFACES);
const SKILL_SET = new Set<string>(SKILL_IDS);
const BODY_PART_SET = new Set<string>(BODY_PART_IDS);
const SEASON_SET = new Set<string>(SEASONS);
const EQUIP_SLOT_SET = new Set<string>(EQUIP_SLOTS);
const BIOME_SET = new Set<number>(BIOME_IDS);

/** Prefix on an item tag that unlocks a non-default recipe, e.g. `unlocks:craft_crossbow`. */
export const UNLOCK_TAG_PREFIX = 'unlocks:';

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Cross-check every id reference in the tables.
 *
 * Throws {@link GameDataValidationError} listing every problem found. Safe to call on
 * hand-built partial tables, which is how the unit tests prove it actually catches
 * things.
 */
export function validateGameData(tables: GameDataTables): void {
  const problems = collectGameDataProblems(tables);
  if (problems.length > 0) throw new GameDataValidationError(problems);
}

/** The body of {@link validateGameData}, without the throw. Returns every problem. */
export function collectGameDataProblems(tables: GameDataTables): string[] {
  const problems: string[] = [];
  const itemIds = new Set(tables.items.map((def) => def.id));
  const recipeIds = new Set(tables.recipes.map((def) => def.id));
  const structureIds = new Set(tables.structures.map((def) => def.id));
  const cropIds = new Set(tables.crops.map((def) => def.id));
  const projectileIds = new Set(tables.projectiles.map((def) => def.id));
  const lootTableIds = new Set(tables.lootTables.map((def) => def.id));
  const itemsById = new Map(tables.items.map((def) => [def.id, def]));

  const requireItem = (defId: string, where: string): void => {
    if (!itemIds.has(defId)) problems.push(`${where}: unknown item "${defId}"`);
  };
  /**
   * Every field the contract documents as `0..1` gets checked here rather than at each
   * use site. These are the values that silently produce nonsense instead of crashing:
   * a coverage of 1.4 makes a helmet absorb more damage than was dealt, and a negative
   * `bleedStop` makes a bandage open the wound.
   */
  const requireUnit = (value: number, field: string, where: string): void => {
    if (!(value >= 0 && value <= 1)) {
      problems.push(`${where}: ${field} is ${value}, outside 0..1`);
    }
  };
  const requireNonNegative = (value: number, field: string, where: string): void => {
    if (!(value >= 0)) problems.push(`${where}: ${field} is ${value}, must be >= 0`);
  };
  const checkEffects = (grants: readonly EffectGrant[], where: string): void => {
    for (const grant of grants) {
      if (!STATUS_EFFECT_SET.has(grant.id)) {
        problems.push(`${where}: unknown status effect "${grant.id}"`);
      }
      if (grant.durationTicks <= 0) {
        problems.push(`${where}: effect "${grant.id}" needs durationTicks > 0`);
      }
      if (grant.chance !== undefined && !(grant.chance > 0 && grant.chance <= 1)) {
        problems.push(`${where}: effect "${grant.id}" chance is ${grant.chance}, outside (0, 1]`);
      }
    }
  };
  const requireSkill = (skill: string, where: string): void => {
    if (!SKILL_SET.has(skill)) problems.push(`${where}: unknown skill "${skill}"`);
  };
  const requireDamageType = (type: string, where: string): void => {
    if (!DAMAGE_TYPE_SET.has(type)) problems.push(`${where}: unknown damage type "${type}"`);
  };
  const requireBiomes = (biomes: Partial<Record<number, number>>, where: string): void => {
    const keys = Object.keys(biomes);
    if (keys.length === 0) problems.push(`${where}: spawnBiomes is empty, it will never generate`);
    for (const key of keys) {
      const biome = Number(key);
      if (!BIOME_SET.has(biome)) problems.push(`${where}: unknown biome id ${key}`);
      const weight = biomes[biome];
      if (weight === undefined || !(weight > 0)) {
        problems.push(`${where}: biome ${key} weight must be > 0`);
      }
    }
  };
  const checkLootEntry = (entry: LootEntry, where: string): void => {
    requireItem(entry.defId, where);
    if (entry.min < 0 || entry.max < entry.min) {
      problems.push(`${where}: bad range ${entry.min}..${entry.max} for "${entry.defId}"`);
    }
    if (entry.chance < 0 || entry.chance > 1) {
      problems.push(`${where}: chance ${entry.chance} for "${entry.defId}" is outside 0..1`);
    }
    if (entry.weight !== undefined && !(entry.weight > 0)) {
      problems.push(`${where}: weight for "${entry.defId}" must be > 0`);
    }
    if (entry.condition) {
      const [low, high] = entry.condition;
      if (low < 0 || high > 1 || low > high) {
        problems.push(`${where}: condition ${low}..${high} for "${entry.defId}" is outside 0..1`);
      }
      const def = itemsById.get(entry.defId);
      if (def && def.maxDurability === undefined) {
        problems.push(
          `${where}: "${entry.defId}" has a condition range but no maxDurability to apply it to`,
        );
      }
    }
  };

  // --- items ------------------------------------------------------------
  for (const def of tables.items) {
    const where = `item "${def.id}"`;
    if (def.stackSize < 1) problems.push(`${where}: stackSize must be >= 1`);
    if (def.weight < 0) problems.push(`${where}: weight must be >= 0`);
    if (def.maxDurability !== undefined && def.maxDurability <= 0) {
      problems.push(`${where}: maxDurability must be > 0 when present`);
    }
    if (def.icon.length === 0) problems.push(`${where}: empty icon key`);

    if (def.tool) {
      if (def.tool.kinds.length === 0) problems.push(`${where}: tool has no kinds`);
      for (const kind of def.tool.kinds) {
        if (!TOOL_KIND_SET.has(kind)) problems.push(`${where}: unknown tool kind "${kind}"`);
      }
      if (def.tool.tier < 1 || def.tool.tier > 4) {
        problems.push(`${where}: tool tier ${def.tool.tier} outside 1..4`);
      }
      if (!(def.tool.efficiency > 0)) problems.push(`${where}: tool efficiency must be > 0`);
      if (def.maxDurability === undefined) {
        problems.push(`${where}: tools need a maxDurability`);
      }
    }

    if (def.weapon) {
      const weapon = def.weapon;
      requireDamageType(weapon.damageType, where);
      requireSkill(weapon.skill, where);
      if (!(weapon.damage > 0)) problems.push(`${where}: weapon damage must be > 0`);
      if (!(weapon.range > 0)) problems.push(`${where}: weapon range must be > 0`);
      if (!(weapon.attackTicks > 0)) problems.push(`${where}: weapon attackTicks must be > 0`);
      if (weapon.critChance < 0 || weapon.critChance > 1) {
        problems.push(`${where}: critChance outside 0..1`);
      }
      if (weapon.armorPen < 0 || weapon.armorPen > 1) {
        problems.push(`${where}: armorPen outside 0..1`);
      }
      if (weapon.maxTargets < 1) problems.push(`${where}: maxTargets must be >= 1`);
      if (weapon.critMultiplier < 1) {
        problems.push(`${where}: critMultiplier ${weapon.critMultiplier} would make crits weaker`);
      }
      if (weapon.blockReduction !== undefined) {
        requireUnit(weapon.blockReduction, 'weapon.blockReduction', where);
      }
      requireNonNegative(weapon.staminaCost, 'weapon.staminaCost', where);
      requireNonNegative(weapon.loudness, 'weapon.loudness', where);
      // The wind-up is carved out of the swing, so a wind-up longer than the whole
      // attack cycle means the hit never resolves before the next one is allowed.
      if (weapon.windupTicks < 0 || weapon.windupTicks > weapon.attackTicks) {
        problems.push(
          `${where}: windupTicks ${weapon.windupTicks} must be within 0..attackTicks (${weapon.attackTicks})`,
        );
      }
      if (weapon.kind === 'melee' && !(weapon.arcDegrees > 0)) {
        problems.push(`${where}: melee weapon needs arcDegrees > 0 or it can never connect`);
      }
      if (weapon.durabilityPerHit > 0 && def.maxDurability === undefined) {
        problems.push(`${where}: durabilityPerHit > 0 but the item has no maxDurability`);
      }
      if (weapon.projectileDefId && !projectileIds.has(weapon.projectileDefId)) {
        problems.push(`${where}: unknown projectile "${weapon.projectileDefId}"`);
      }
      if (weapon.kind === 'ranged') {
        if (!weapon.ammoDefIds || weapon.ammoDefIds.length === 0) {
          problems.push(`${where}: ranged weapon has no ammoDefIds`);
        }
        for (const ammoId of weapon.ammoDefIds ?? []) {
          requireItem(ammoId, `${where} ammo`);
          const ammo = itemsById.get(ammoId);
          if (ammo && !ammo.projectileDefId) {
            problems.push(`${where}: ammo "${ammoId}" has no projectileDefId`);
          }
        }
        if (weapon.magazineSize === undefined || weapon.magazineSize < 1) {
          problems.push(`${where}: ranged weapon needs magazineSize >= 1`);
        }
        if (weapon.reloadTicks === undefined || weapon.reloadTicks < 0) {
          problems.push(`${where}: ranged weapon needs reloadTicks >= 0`);
        }
        if (weapon.pellets !== undefined && weapon.pellets < 1) {
          problems.push(`${where}: pellets must be >= 1`);
        }
      }
      if (weapon.kind === 'thrown' && !weapon.projectileDefId) {
        problems.push(`${where}: thrown weapon needs a projectileDefId`);
      }
    }

    if (def.armor) {
      if (!EQUIP_SLOT_SET.has(def.armor.slot)) {
        problems.push(`${where}: unknown equip slot "${def.armor.slot}"`);
      }
      for (const [part, fraction] of Object.entries(def.armor.coverage)) {
        if (!BODY_PART_SET.has(part)) problems.push(`${where}: unknown body part "${part}"`);
        if (fraction !== undefined) requireUnit(fraction, `coverage.${part}`, where);
      }
      for (const [type, amount] of Object.entries(def.armor.protection)) {
        requireDamageType(type, `${where} protection`);
        if (amount !== undefined) requireNonNegative(amount, `protection.${type}`, where);
      }
      if (def.armor.biteResistance < 0 || def.armor.biteResistance > 1) {
        problems.push(`${where}: biteResistance outside 0..1`);
      }
      if (def.armor.encumbrance < 0 || def.armor.encumbrance > 1) {
        problems.push(`${where}: encumbrance outside 0..1`);
      }
      if (def.maxDurability === undefined) problems.push(`${where}: armour needs a maxDurability`);
    }

    checkEffects(
      [
        ...(def.food?.effects ?? []),
        ...(def.drink?.effects ?? []),
        ...(def.medical?.effects ?? []),
      ],
      where,
    );

    if (def.food) {
      requireUnit(def.food.sicknessChance, 'food.sicknessChance', where);
      requireNonNegative(def.food.nutrition, 'food.nutrition', where);
      requireNonNegative(def.food.hydration, 'food.hydration', where);
      if (!(def.food.eatTicks > 0)) problems.push(`${where}: food eatTicks must be > 0`);
    }
    if (def.drink) {
      requireUnit(def.drink.sicknessChance, 'drink.sicknessChance', where);
      if (!(def.drink.drinkTicks > 0)) problems.push(`${where}: drink drinkTicks must be > 0`);
    }
    if (def.medical) {
      requireUnit(def.medical.bleedStop, 'medical.bleedStop', where);
      requireUnit(def.medical.cleanliness, 'medical.cleanliness', where);
      requireNonNegative(def.medical.heal, 'medical.heal', where);
      requireNonNegative(def.medical.painRelief, 'medical.painRelief', where);
      requireNonNegative(def.medical.infectionCure, 'medical.infectionCure', where);
      if (!(def.medical.useTicks > 0)) problems.push(`${where}: medical useTicks must be > 0`);
    }
    if (def.fuel) {
      if (!(def.fuel.burnTicks > 0)) problems.push(`${where}: fuel burnTicks must be > 0`);
      requireNonNegative(def.fuel.heat, 'fuel.heat', where);
    }
    if (def.liquid) {
      if (!(def.liquid.capacity > 0)) problems.push(`${where}: liquid capacity must be > 0`);
      if (def.liquid.contentDefId) requireItem(def.liquid.contentDefId, `${where} liquid content`);
    }
    if (def.perishable) {
      if (!(def.perishable.spoilTicks > 0)) problems.push(`${where}: spoilTicks must be > 0`);
      if (def.perishable.spoiledDefId) {
        requireItem(def.perishable.spoiledDefId, `${where} spoiled form`);
      }
      // A multiplier above 1 would make a cool room spoil food *faster*, which is the
      // opposite of what every call site assumes.
      if (!(
        def.perishable.refrigeratedMultiplier > 0 && def.perishable.refrigeratedMultiplier <= 1
      )) {
        problems.push(
          `${where}: refrigeratedMultiplier is ${def.perishable.refrigeratedMultiplier}, outside (0, 1]`,
        );
      }
    }
    if (def.fertilizerTicks !== undefined && !(def.fertilizerTicks > 0)) {
      problems.push(`${where}: fertilizerTicks must be > 0 when present`);
    }
    if (def.cropDefId && !cropIds.has(def.cropDefId)) {
      problems.push(`${where}: unknown crop "${def.cropDefId}"`);
    }
    if (def.projectileDefId && !projectileIds.has(def.projectileDefId)) {
      problems.push(`${where}: unknown projectile "${def.projectileDefId}"`);
    }
    if (def.placesStructureDefId && !structureIds.has(def.placesStructureDefId)) {
      problems.push(`${where}: unknown structure "${def.placesStructureDefId}"`);
    }
    if (def.containerSlots !== undefined && def.containerSlots < 1) {
      problems.push(`${where}: containerSlots must be >= 1`);
    }
    for (const tag of def.tags) {
      if (!tag.startsWith(UNLOCK_TAG_PREFIX)) continue;
      const recipeId = tag.slice(UNLOCK_TAG_PREFIX.length);
      if (!recipeIds.has(recipeId)) {
        problems.push(`${where}: unlock tag points at unknown recipe "${recipeId}"`);
      }
    }
  }

  // --- recipes ----------------------------------------------------------
  const unlockedByTag = new Set<string>();
  for (const def of tables.items) {
    for (const tag of def.tags) {
      if (tag.startsWith(UNLOCK_TAG_PREFIX)) unlockedByTag.add(tag.slice(UNLOCK_TAG_PREFIX.length));
    }
  }
  const stationsProvided = new Set<string>();
  for (const def of tables.structures) {
    if (def.station) stationsProvided.add(def.station.kind);
  }

  for (const def of tables.recipes) {
    const where = `recipe "${def.id}"`;
    if (def.inputs.length === 0) problems.push(`${where}: no inputs`);
    if (def.outputs.length === 0) problems.push(`${where}: no outputs`);
    if (!(def.craftTicks > 0)) problems.push(`${where}: craftTicks must be > 0`);
    for (const input of def.inputs) {
      if (input.tag !== undefined) {
        const tag = input.tag;
        const matches = tables.items.filter((item) => item.tags.includes(tag));
        if (matches.length === 0) {
          problems.push(`${where}: input tag "${tag}" matches no item`);
        }
        // A tagged input still carries a `defId`, which the UI shows as the preferred
        // item. It is allowed to be empty, but a non-empty typo has to be caught -
        // otherwise the recipe works and the tooltip shows nothing.
        if (input.defId.length > 0) requireItem(input.defId, `${where} tagged input`);
      } else {
        requireItem(input.defId, `${where} input`);
      }
      if (input.count < 1) problems.push(`${where}: input "${input.defId}" count must be >= 1`);
    }
    for (const output of def.outputs) {
      requireItem(output.defId, `${where} output`);
      if (output.count < 1) problems.push(`${where}: output "${output.defId}" count must be >= 1`);
      if (output.chance !== undefined && (output.chance <= 0 || output.chance > 1)) {
        problems.push(`${where}: output "${output.defId}" chance outside 0..1`);
      }
    }
    for (const tool of def.tools) {
      if (!TOOL_KIND_SET.has(tool)) problems.push(`${where}: unknown tool kind "${tool}"`);
    }
    if (def.station !== undefined) {
      if (!STATION_KIND_SET.has(def.station)) {
        problems.push(`${where}: unknown station "${def.station}"`);
      } else if (!stationsProvided.has(def.station)) {
        problems.push(`${where}: station "${def.station}" is not provided by any structure`);
      }
    }
    if (def.requiredSkill) requireSkill(def.requiredSkill.id, `${where} requiredSkill`);
    requireSkill(def.xp.skill, `${where} xp`);
    if (def.fuelCost !== undefined && def.fuelCost < 0) {
      problems.push(`${where}: fuelCost must be >= 0`);
    }
    if (def.requiresHeat && def.station === undefined) {
      problems.push(`${where}: requiresHeat with no station to be lit`);
    }
    if (!def.unlockedByDefault && !unlockedByTag.has(def.id)) {
      problems.push(`${where}: locked recipe has no schematic item unlocking it`);
    }
  }

  // --- structures -------------------------------------------------------
  for (const def of tables.structures) {
    const where = `structure "${def.id}"`;
    if (def.width < 1 || def.height < 1) problems.push(`${where}: footprint must be >= 1x1`);
    if (!(def.maxHealth > 0)) problems.push(`${where}: maxHealth must be > 0`);
    if (!(def.buildTicks > 0)) problems.push(`${where}: buildTicks must be > 0`);
    if (def.cost.length === 0) problems.push(`${where}: no build cost`);
    if (def.refundRatio < 0 || def.refundRatio > 1) {
      problems.push(`${where}: refundRatio outside 0..1`);
    }
    for (const amount of def.cost) {
      requireItem(amount.defId, `${where} cost`);
      if (amount.count < 1) problems.push(`${where}: cost "${amount.defId}" count must be >= 1`);
    }
    if (def.tool !== undefined && !TOOL_KIND_SET.has(def.tool)) {
      problems.push(`${where}: unknown tool kind "${def.tool}"`);
    }
    if (!STRUCTURE_CATEGORY_SET.has(def.category)) {
      problems.push(`${where}: unknown category "${def.category}"`);
    }
    if (!PLACEMENT_SURFACE_SET.has(def.placeOn)) {
      problems.push(`${where}: unknown placeOn surface "${def.placeOn}"`);
    }
    for (const category of def.stacksOver) {
      if (!STRUCTURE_CATEGORY_SET.has(category)) {
        problems.push(`${where}: unknown stacksOver category "${category}"`);
      }
    }
    if (def.station && !STATION_KIND_SET.has(def.station.kind)) {
      problems.push(`${where}: unknown station kind "${def.station.kind}"`);
    }
    if (def.station?.needsFuel && !(def.station.maxFuel > 0)) {
      problems.push(`${where}: station needs fuel but maxFuel is 0`);
    }
    if (def.container && def.container.slots < 1) {
      problems.push(`${where}: container slots must be >= 1`);
    }
    if (def.light && !(def.light.radius > 0)) problems.push(`${where}: light radius must be > 0`);
    if (def.requiredSkill) requireSkill(def.requiredSkill.id, `${where} requiredSkill`);
    if (!(def.zombieDamageMultiplier >= 0)) {
      problems.push(`${where}: zombieDamageMultiplier must be >= 0`);
    }
    if (def.sprite.length === 0) problems.push(`${where}: empty sprite key`);
  }

  // --- resource nodes ---------------------------------------------------
  for (const def of tables.nodes) {
    const where = `node "${def.id}"`;
    if (!(def.maxHealth > 0)) problems.push(`${where}: maxHealth must be > 0`);
    if (def.wrongToolMultiplier < 0 || def.wrongToolMultiplier > 1) {
      problems.push(`${where}: wrongToolMultiplier outside 0..1`);
    }
    if (def.minToolTier < 1 || def.minToolTier > 4) {
      problems.push(`${where}: minToolTier ${def.minToolTier} outside 1..4`);
    }
    for (const tool of def.toolKinds) {
      if (!TOOL_KIND_SET.has(tool)) problems.push(`${where}: unknown tool kind "${tool}"`);
    }
    if (def.toolKinds.length === 0 && def.wrongToolMultiplier === 0) {
      problems.push(`${where}: no tool works on it and bare hands do nothing - it is inert`);
    }
    if (def.yields.length === 0 && def.yieldPerHit.length === 0) {
      problems.push(`${where}: yields nothing at all`);
    }
    for (const entry of def.yields) checkLootEntry(entry, `${where} yield`);
    for (const entry of def.yieldPerHit) checkLootEntry(entry, `${where} yieldPerHit`);
    requireSkill(def.skill, where);
    if (def.variants < 1) problems.push(`${where}: variants must be >= 1`);
    if (def.densityPerChunk < 0) problems.push(`${where}: densityPerChunk must be >= 0`);
    if (def.respawnTicks !== -1 && def.respawnTicks <= 0) {
      problems.push(`${where}: respawnTicks must be -1 (never) or > 0`);
    }
    requireBiomes(def.spawnBiomes, where);
  }

  // --- crops ------------------------------------------------------------
  for (const def of tables.crops) {
    const where = `crop "${def.id}"`;
    requireItem(def.seedDefId, `${where} seed`);
    requireItem(def.produceDefId, `${where} produce`);
    const seed = itemsById.get(def.seedDefId);
    if (seed && seed.cropDefId !== def.id) {
      problems.push(
        `${where}: seed "${def.seedDefId}" plants "${seed.cropDefId ?? 'nothing'}", not this crop`,
      );
    }
    if (def.stages < 2) problems.push(`${where}: needs at least 2 stages`);
    if (def.ticksPerStage.length !== def.stages - 1) {
      problems.push(
        `${where}: ticksPerStage has ${def.ticksPerStage.length} entries, expected ${def.stages - 1} (stages - 1)`,
      );
    }
    for (const ticks of def.ticksPerStage) {
      if (!(ticks > 0)) problems.push(`${where}: every ticksPerStage entry must be > 0`);
    }
    if (def.seasons.length === 0) problems.push(`${where}: grows in no season`);
    for (const season of def.seasons) {
      if (!SEASON_SET.has(season)) problems.push(`${where}: unknown season "${season}"`);
    }
    const [low, high] = def.idealTemperature;
    if (low >= high) problems.push(`${where}: idealTemperature ${low}..${high} is not a range`);
    if (def.frostTemperature > low) {
      problems.push(`${where}: frostTemperature is inside the ideal band`);
    }
    if (def.yieldMin < 1 || def.yieldMax < def.yieldMin) {
      problems.push(`${where}: yield range ${def.yieldMin}..${def.yieldMax} is invalid`);
    }
    if (def.seedYield[0] < 0 || def.seedYield[1] < def.seedYield[0]) {
      problems.push(`${where}: seedYield range is invalid`);
    }
    if (def.harvestsPerPlant < 1) problems.push(`${where}: harvestsPerPlant must be >= 1`);
    if (def.regrows && def.harvestsPerPlant < 2) {
      problems.push(`${where}: regrows but only allows one harvest`);
    }
    if (!def.regrows && def.harvestsPerPlant !== 1) {
      problems.push(`${where}: does not regrow but allows ${def.harvestsPerPlant} harvests`);
    }
    if (def.blightChance < 0 || def.blightChance > 1) {
      problems.push(`${where}: blightChance outside 0..1`);
    }
    if (def.waterPerTick < 0) problems.push(`${where}: waterPerTick must be >= 0`);
  }

  // --- creatures --------------------------------------------------------
  for (const def of tables.zombies) {
    const where = `zombie "${def.id}"`;
    if (def.tier < 1) problems.push(`${where}: tier must be >= 1`);
    if (!(def.maxHealth > 0)) problems.push(`${where}: maxHealth must be > 0`);
    if (!(def.bodyScale > 0)) problems.push(`${where}: bodyScale must be > 0`);
    if (def.speedChase < def.speedWalk) {
      problems.push(`${where}: speedChase is slower than speedWalk`);
    }
    requireDamageType(def.damageType, where);
    for (const type of Object.keys(def.armor)) requireDamageType(type, `${where} armor`);
    if (def.biteChance < 0 || def.biteChance > 1)
      problems.push(`${where}: biteChance outside 0..1`);
    if (def.infectionChance < 0 || def.infectionChance > 1) {
      problems.push(`${where}: infectionChance outside 0..1`);
    }
    if (def.staggerResist < 0 || def.staggerResist > 1) {
      problems.push(`${where}: staggerResist outside 0..1`);
    }
    if (def.crawlSpeedMultiplier <= 0 || def.crawlSpeedMultiplier > 1) {
      problems.push(`${where}: crawlSpeedMultiplier outside 0..1`);
    }
    if (def.attacksStructures && !(def.structureDamage > 0)) {
      problems.push(`${where}: attacks structures but does no structure damage`);
    }
    if (def.minDay < 1) problems.push(`${where}: minDay must be >= 1`);
    if (def.spawnWeight < 0) problems.push(`${where}: spawnWeight must be >= 0`);
    if (def.sightHalfAngle <= 0 || def.sightHalfAngle > Math.PI) {
      problems.push(`${where}: sightHalfAngle must be within (0, PI]`);
    }
    if (def.lootTableId !== undefined && !lootTableIds.has(def.lootTableId)) {
      problems.push(`${where}: unknown loot table "${def.lootTableId}"`);
    }
  }

  for (const def of tables.animals) {
    const where = `animal "${def.id}"`;
    if (!(def.maxHealth > 0)) problems.push(`${where}: maxHealth must be > 0`);
    if (def.speedRun < def.speedWalk) problems.push(`${where}: speedRun is slower than speedWalk`);
    requireDamageType(def.damageType, where);
    requireSkill(def.skill, where);
    if (!lootTableIds.has(def.lootTableId)) {
      problems.push(`${where}: unknown loot table "${def.lootTableId}"`);
    }
    if (def.damage > 0 && !(def.attackRange > 0)) {
      problems.push(`${where}: deals damage but has no attack range`);
    }
    if (def.densityPerChunk < 0) problems.push(`${where}: densityPerChunk must be >= 0`);
    requireBiomes(def.spawnBiomes, where);
  }

  // --- projectiles ------------------------------------------------------
  for (const def of tables.projectiles) {
    const where = `projectile "${def.id}"`;
    if (!(def.speed > 0)) problems.push(`${where}: speed must be > 0`);
    if (!(def.maxRange > 0)) problems.push(`${where}: maxRange must be > 0`);
    if (!(def.radius > 0)) problems.push(`${where}: radius must be > 0`);
    if (def.pierce < 0) problems.push(`${where}: pierce must be >= 0`);
    if (def.damageFalloff < 0 || def.damageFalloff > 1) {
      problems.push(`${where}: damageFalloff outside 0..1`);
    }
    if (def.recoverDefId) {
      requireItem(def.recoverDefId, `${where} recover`);
      if (def.recoverChance === undefined || def.recoverChance <= 0 || def.recoverChance > 1) {
        problems.push(`${where}: recoverDefId set but recoverChance is not in (0, 1]`);
      }
    } else if (def.recoverChance !== undefined) {
      problems.push(`${where}: recoverChance set with no recoverDefId`);
    }
  }

  // --- loot tables ------------------------------------------------------
  for (const def of tables.lootTables) {
    const where = `loot table "${def.id}"`;
    const [minRolls, maxRolls] = def.rolls;
    if (minRolls < 0 || maxRolls < minRolls) {
      problems.push(`${where}: rolls ${minRolls}..${maxRolls} is invalid`);
    }
    if (def.entries.length === 0 && (def.guaranteed?.length ?? 0) === 0) {
      problems.push(`${where}: has no entries at all`);
    }
    if (maxRolls > 0 && def.entries.length === 0) {
      problems.push(`${where}: rolls from an empty weighted pool`);
    }
    for (const entry of def.entries) checkLootEntry(entry, `${where} entry`);
    for (const entry of def.guaranteed ?? []) checkLootEntry(entry, `${where} guaranteed`);
  }

  // --- reverse checks ---------------------------------------------------
  for (const kind of STATION_KINDS) {
    if (!stationsProvided.has(kind)) {
      problems.push(`station kind "${kind}" has no structure providing it`);
    }
  }
  for (const crop of tables.crops) {
    const producers = tables.items.filter((item) => item.cropDefId === crop.id);
    if (producers.length === 0) problems.push(`crop "${crop.id}" has no seed item that plants it`);
  }

  return problems;
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/**
 * Stable content hash.
 *
 * Deliberately *not* a timestamp: the client refuses to join on a version mismatch, so
 * the version has to be a pure function of the tables. Two servers built from the same
 * source always agree, and any edit to any field changes it. `stableStringify` sorts
 * object keys, so re-ordering a field in an object literal does not.
 */
export function computeDataVersion(tables: GameDataTables): string {
  // Deliberately hashes the definitions *without* their display text.
  //
  // The version is a content identity, and it is compared across the wire: the client
  // refuses to play against a server whose content differs. A translation is not a content
  // difference - a Korean client and an English server run the same world - so folding the
  // locale into this hash would report every translated client as incompatible, and would
  // change the version of every existing save the day a second language shipped.
  const stripText = <T extends object>(defs: readonly T[]): unknown[] =>
    defs.map((def) => {
      const { name: _name, description: _description, ...rest } = def as T & DisplayText;
      return rest;
    });
  const json = stableStringify([
    stripText(tables.items),
    stripText(tables.recipes),
    stripText(tables.structures),
    stripText(tables.nodes),
    stripText(tables.zombies),
    stripText(tables.animals),
    stripText(tables.crops),
    tables.projectiles,
    tables.lootTables,
  ]);
  const hash = mixSeeds(hashString(json), json.length);
  return `gd1-${hash.toString(16).padStart(8, '0')}-${json.length.toString(36)}`;
}

/**
 * Freeze an index bucket before it leaves the module.
 *
 * The lookup helpers hand out the *same* array on every call rather than a copy, which
 * is what makes them allocation-free in the spawn and chunk-generation loops. That only
 * stays safe if the array cannot be mutated: `readonly T[]` stops TypeScript callers,
 * and this stops the compiled JavaScript ones (the client is bundled, the server is not,
 * and a stray `.sort()` on a shared table would desynchronise them).
 */
function freeze<T>(items: T[]): readonly T[] {
  return Object.freeze(items) as readonly T[];
}

/** Build a {@link GameData} with no validation. Use {@link createGameData} normally. */
export function buildGameData(tables: LocalizedTables): GameData {
  const items = createRegistry(tables.items, 'items');
  const recipes = createRegistry(tables.recipes, 'recipes');
  const structures = createRegistry(tables.structures, 'structures');
  const nodes = createRegistry(tables.nodes, 'nodes');
  const zombies = createRegistry(tables.zombies, 'zombies');
  const animals = createRegistry(tables.animals, 'animals');
  const crops = createRegistry(tables.crops, 'crops');
  const projectiles = createRegistry(tables.projectiles, 'projectiles');
  const lootTables = createRegistry(tables.lootTables, 'lootTables');

  // Every lookup below is hot enough to be worth indexing once: the crafting UI asks
  // for a station's recipes on every open, and chunk generation asks for a biome's
  // nodes for every chunk it makes.
  const HAND_CRAFT_KEY = '';
  const byStation = new Map<string, RecipeDef[]>();
  for (const recipe of tables.recipes) {
    const key = recipe.station ?? HAND_CRAFT_KEY;
    const list = byStation.get(key);
    if (list) list.push(recipe);
    else byStation.set(key, [recipe]);
  }

  const byTag = new Map<string, ItemDef[]>();
  for (const item of tables.items) {
    for (const tag of item.tags) {
      const list = byTag.get(tag);
      if (list) list.push(item);
      else byTag.set(tag, [item]);
    }
  }

  const nodesByBiome = new Map<number, ResourceNodeDef[]>();
  for (const node of tables.nodes) {
    for (const key of Object.keys(node.spawnBiomes)) {
      const biome = Number(key);
      const list = nodesByBiome.get(biome);
      if (list) list.push(node);
      else nodesByBiome.set(biome, [node]);
    }
  }

  const animalsByBiome = new Map<number, AnimalDef[]>();
  for (const animal of tables.animals) {
    for (const key of Object.keys(animal.spawnBiomes)) {
      const biome = Number(key);
      const list = animalsByBiome.get(biome);
      if (list) list.push(animal);
      else animalsByBiome.set(biome, [animal]);
    }
  }

  for (const list of byStation.values()) Object.freeze(list);
  for (const list of byTag.values()) Object.freeze(list);
  for (const list of nodesByBiome.values()) Object.freeze(list);
  for (const list of animalsByBiome.values()) Object.freeze(list);

  // `compareIds`, not `localeCompare`: the build-menu order has to be identical on
  // every host, and `localeCompare` answers according to the ICU data Node shipped
  // with. `sortOrder` is unique in the shipped table, so this only breaks ties a mod
  // introduces - which is exactly the case that must not vary by machine.
  const buildable = freeze(
    [...tables.structures].sort((a, b) => a.sortOrder - b.sortOrder || compareIds(a.id, b.id)),
  );

  /**
   * Zombie eligibility only changes at a `minDay` boundary, so the answer for every
   * possible day is one of a handful of lists. Precomputing them keeps the spawn
   * system - which asks once per spawn tick - from allocating a fresh array each time,
   * and makes the returned arrays safe to hand out frozen.
   */
  const spawnable = tables.zombies.filter((def) => def.spawnWeight > 0);
  const thresholds = [...new Set(spawnable.map((def) => def.minDay))].sort((a, b) => a - b);
  const dayLists = new Map<number, readonly ZombieDef[]>();
  const nightLists = new Map<number, readonly ZombieDef[]>();
  for (const threshold of thresholds) {
    const eligible = spawnable.filter((def) => def.minDay <= threshold);
    nightLists.set(threshold, freeze(eligible));
    dayLists.set(threshold, freeze(eligible.filter((def) => !def.nightOnly)));
  }

  const empty: readonly never[] = Object.freeze([]);

  return {
    version: computeDataVersion(tables),
    items,
    recipes,
    structures,
    nodes,
    zombies,
    animals,
    crops,
    projectiles,
    lootTables,

    recipesForStation(station: StationKind | undefined): readonly RecipeDef[] {
      return byStation.get(station ?? HAND_CRAFT_KEY) ?? empty;
    },
    buildableStructures(): readonly StructureDef[] {
      return buildable;
    },
    itemsWithTag(tag: string): readonly ItemDef[] {
      return byTag.get(tag) ?? empty;
    },
    nodesForBiome(biome: BiomeId): readonly ResourceNodeDef[] {
      return nodesByBiome.get(biome) ?? empty;
    },
    zombiesForDay(day: number, night: boolean): readonly ZombieDef[] {
      // Largest `minDay` threshold this day has reached. Below the first one nothing
      // has unlocked yet, which is a real answer, not a missing index entry.
      let reached = -1;
      for (const threshold of thresholds) {
        if (threshold > day) break;
        reached = threshold;
      }
      if (reached < 0) return empty;
      return (night ? nightLists : dayLists).get(reached) ?? empty;
    },
    animalsForBiome(biome: BiomeId): readonly AnimalDef[] {
      return animalsByBiome.get(biome) ?? empty;
    },
  };
}

/**
 * Build the game's content, validated.
 *
 * Throws {@link GameDataValidationError} when anything cross-references an id that does
 * not exist. Pass `overrides` to substitute a table - the tests use it to prove the
 * validator bites, and a future mod loader would use the same door.
 */
export function createGameData(
  overrides?: Partial<GameDataTables>,
  options: { locale?: Locale } = {},
): GameData {
  const tables = localizeTables(
    { ...defaultTables(), ...overrides },
    options.locale ?? DEFAULT_LOCALE,
  );
  validateGameData(tables);
  return buildGameData(tables);
}
