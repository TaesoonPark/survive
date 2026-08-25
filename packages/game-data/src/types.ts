import type {
  BiomeId,
  BodyPartId,
  DamageType,
  EquipSlot,
  ItemDefId,
  ProjectileDefId,
  RecipeDefId,
  ResourceNodeDefId,
  Season,
  SkillId,
  StructureDefId,
  StatusEffectId,
  LootTableId,
  CropDefId,
  ZombieDefId,
  AnimalDefId,
} from '@survive/protocol';

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

/** A quantity of one item, used for costs, yields and loot. */
export interface ItemAmount {
  defId: ItemDefId;
  count: number;
}

/** One possible drop. `chance` of 1 means it always drops. */
export interface LootEntry {
  defId: ItemDefId;
  min: number;
  max: number;
  /** Probability the entry drops at all, 0..1. */
  chance: number;
  /** Relative weight when the entry is picked from a weighted table. */
  weight?: number;
  /** Durability fraction for tools/weapons that spawn used, 0..1. */
  condition?: [number, number];
}

export interface LootTableDef {
  id: LootTableId;
  /** How many weighted picks to roll. */
  rolls: [number, number];
  /** Weighted pool. */
  entries: LootEntry[];
  /** Always dropped, regardless of the weighted rolls. */
  guaranteed?: LootEntry[];
  /** Multiplied into every `chance` in this table. Tuned by `lootAbundance`. */
  abundanceScaling?: boolean;
}

/** A status effect application attached to a consumable or hazard. */
export interface EffectGrant {
  id: StatusEffectId;
  durationTicks: number;
  magnitude: number;
  /** Probability it is applied at all, 0..1. Defaults to 1. */
  chance?: number;
}

/** Tools recognised by recipes, resource nodes and structures. */
export type ToolKind =
  | 'axe'
  | 'pickaxe'
  | 'shovel'
  | 'hoe'
  | 'knife'
  | 'hammer'
  | 'saw'
  | 'wateringCan'
  | 'sickle'
  | 'fishingRod'
  | 'wrench'
  | 'lighter';

/** Crafting stations. A recipe with no station is craftable by hand. */
export type StationKind =
  | 'workbench'
  | 'campfire'
  | 'furnace'
  | 'anvil'
  | 'loom'
  | 'cookingPot'
  | 'chemistry'
  | 'grindstone';

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

export type ItemCategory =
  | 'resource'
  | 'component'
  | 'tool'
  | 'weapon'
  | 'ammo'
  | 'armor'
  | 'food'
  | 'drink'
  | 'medical'
  | 'seed'
  | 'produce'
  | 'placeable'
  | 'fuel'
  | 'container'
  | 'misc';

export type ItemRarity = 'common' | 'uncommon' | 'rare' | 'epic';

export interface ToolProps {
  /** Every tool role this item can fill. A hatchet is an axe; a multitool is several. */
  kinds: ToolKind[];
  /** Tier 1..4. Nodes can require a minimum tier (iron ore needs a metal pick). */
  tier: number;
  /** Multiplier on gathering damage and crafting speed. */
  efficiency: number;
  /** Durability spent per use. */
  durabilityPerUse: number;
}

export interface WeaponProps {
  kind: 'melee' | 'ranged' | 'thrown';
  /** Base damage before body-part, armour, skill and quality modifiers. */
  damage: number;
  damageType: DamageType;
  /** Reach in world pixels. */
  range: number;
  /** Full width of the melee sweep, in degrees. Ignored for ranged. */
  arcDegrees: number;
  /** Ticks between attacks. */
  attackTicks: number;
  /** Ticks of wind-up before the hit resolves. Gives the client an animation window. */
  windupTicks: number;
  staminaCost: number;
  /** Impulse applied to the target, px/second. */
  knockback: number;
  critChance: number;
  critMultiplier: number;
  /** Fraction of armour ignored, 0..1. */
  armorPen: number;
  skill: SkillId;
  durabilityPerHit: number;
  /** Noise radius in pixels. Gunshots pull in the whole neighbourhood. */
  loudness: number;
  twoHanded: boolean;
  /** How many targets one swing can hit. */
  maxTargets: number;
  /** Fraction of incoming damage absorbed while blocking with this weapon, 0..1. */
  blockReduction?: number;

  // --- ranged only -------------------------------------------------------
  ammoDefIds?: ItemDefId[];
  magazineSize?: number;
  reloadTicks?: number;
  projectileDefId?: ProjectileDefId;
  /** Cone of inaccuracy in degrees, before skill modifiers. */
  spreadDegrees?: number;
  /** Projectiles per shot; > 1 for shotguns. */
  pellets?: number;
}

export interface ArmorProps {
  slot: EquipSlot;
  /** How much of each body part this piece covers, 0..1. */
  coverage: Partial<Record<BodyPartId, number>>;
  /** Flat damage reduction per damage type, before penetration. */
  protection: Partial<Record<DamageType, number>>;
  /** Insulation, in degrees Celsius of effective warmth. */
  warmth: number;
  /** Movement speed penalty, 0..1. */
  encumbrance: number;
  durabilityPerHit: number;
  /** Multiplier on the chance a zombie bite reaches skin, 0..1. */
  biteResistance: number;
}

export interface FoodProps {
  /** Hunger removed, in need points. */
  nutrition: number;
  /** Thirst removed. Soups and fruit hydrate too. */
  hydration: number;
  /** Immediate stamina restored. */
  stamina: number;
  /** Immediate health restored. */
  health: number;
  eatTicks: number;
  /** Probability of food poisoning when eaten raw or spoiled, 0..1. */
  sicknessChance: number;
  effects?: EffectGrant[];
}

export interface DrinkProps {
  hydration: number;
  nutrition: number;
  /** Probability of illness from untreated water, 0..1. */
  sicknessChance: number;
  drinkTicks: number;
  effects?: EffectGrant[];
}

export type MedicalKind = 'bandage' | 'splint' | 'suture' | 'disinfect' | 'pill' | 'injection';

export interface MedicalProps {
  kind: MedicalKind;
  /** Fraction of bleeding stopped, 0..1. */
  bleedStop: number;
  /** Body-part health restored. */
  heal: number;
  /** Pain removed. */
  painRelief: number;
  /** Infection removed. */
  infectionCure: number;
  /** Whether it sets a fracture. */
  fixesFracture: boolean;
  /** Bandage cleanliness, 0..1. A dirty rag stops blood but invites infection. */
  cleanliness: number;
  useTicks: number;
  /** Skill required to use without a failure chance. */
  skillLevel: number;
  effects?: EffectGrant[];
}

export interface FuelProps {
  /** Ticks of burn time contributed. */
  burnTicks: number;
  /** Heat output while burning. */
  heat: number;
}

export interface LiquidProps {
  /** Units the container holds. */
  capacity: number;
  /** What it is filled with by default, if anything. */
  contentDefId?: ItemDefId;
  /** Whether it can be filled from a water source. */
  fillable: boolean;
}

export interface PerishableProps {
  /** Ticks from fresh to rotten. */
  spoilTicks: number;
  /** What it turns into when it spoils. Omit to just become inedible. */
  spoiledDefId?: ItemDefId;
  /** Multiplier on spoil rate when stored in a cool place. */
  refrigeratedMultiplier: number;
}

export interface ItemDef {
  id: ItemDefId;
  name: string;
  description: string;
  category: ItemCategory;
  /** Max items in one stack. 1 for anything with per-item state. */
  stackSize: number;
  /** Weight of one unit, in kilograms. */
  weight: number;
  /** Texture key for the client's item atlas. */
  icon: string;
  rarity: ItemRarity;
  /** Full durability. Absent for items that never wear out. */
  maxDurability?: number;
  tool?: ToolProps;
  weapon?: WeaponProps;
  armor?: ArmorProps;
  food?: FoodProps;
  drink?: DrinkProps;
  medical?: MedicalProps;
  fuel?: FuelProps;
  liquid?: LiquidProps;
  perishable?: PerishableProps;
  /** Seeds: which crop this plants. */
  cropDefId?: CropDefId;
  /** Extra inventory slots granted while equipped (backpacks). */
  containerSlots?: number;
  /** Placing this item creates the given structure. */
  placesStructureDefId?: StructureDefId;
  /** Ammunition: which projectile it becomes. */
  projectileDefId?: ProjectileDefId;
  /** Fertilizer strength in ticks of growth boost. */
  fertilizerTicks?: number;
  /** Free-form tags for recipe substitution and quest-style checks. */
  tags: string[];
}

// ---------------------------------------------------------------------------
// Recipes
// ---------------------------------------------------------------------------

export type RecipeCategory =
  | 'basic'
  | 'tools'
  | 'weapons'
  | 'ammo'
  | 'armor'
  | 'building'
  | 'cooking'
  | 'medical'
  | 'farming'
  | 'smelting'
  | 'textiles';

export interface RecipeInput extends ItemAmount {
  /** Consume durability instead of the item itself (e.g. a mould). */
  consumeDurability?: number;
  /** Accept any item carrying this tag instead of an exact id. */
  tag?: string;
}

export interface RecipeOutput extends ItemAmount {
  /** Probability this output is produced, 0..1. Defaults to 1. */
  chance?: number;
}

export interface RecipeDef {
  id: RecipeDefId;
  name: string;
  category: RecipeCategory;
  inputs: RecipeInput[];
  /** Tools that must be held or nearby but are not consumed. */
  tools: ToolKind[];
  outputs: RecipeOutput[];
  /** Station required. Omit for hand-crafting. */
  station?: StationKind;
  craftTicks: number;
  /** Minimum skill to attempt the recipe. */
  requiredSkill?: { id: SkillId; level: number };
  xp: { skill: SkillId; amount: number };
  /** Known from the start, or discovered by finding a schematic. */
  unlockedByDefault: boolean;
  /** Fuel units consumed per craft, for burning stations. */
  fuelCost?: number;
  /** Station must be lit (cooking, smelting). */
  requiresHeat?: boolean;
}

// ---------------------------------------------------------------------------
// Structures
// ---------------------------------------------------------------------------

export type StructureCategory =
  | 'foundation'
  | 'wall'
  | 'door'
  | 'window'
  | 'floor'
  | 'furniture'
  | 'station'
  | 'storage'
  | 'farm'
  | 'light'
  | 'defense'
  | 'bed'
  | 'misc';

export type PlacementSurface = 'ground' | 'floor' | 'any' | 'water';

export interface StructureDef {
  id: StructureDefId;
  name: string;
  description: string;
  category: StructureCategory;
  /** Footprint in tiles, before rotation. */
  width: number;
  height: number;
  maxHealth: number;
  /** Ticks of work to finish the build. */
  buildTicks: number;
  cost: ItemAmount[];
  /** Fraction of cost returned when demolished by the owner, 0..1. */
  refundRatio: number;

  blocksMovement: boolean;
  blocksSight: boolean;
  /** Placeable over an existing structure of these categories (floors under walls). */
  stacksOver: StructureCategory[];

  /** Must touch an existing wall/foundation to be placed. */
  requiresSupport: boolean;
  placeOn: PlacementSurface;
  /** Tool that must be equipped to place or demolish. */
  tool?: ToolKind;

  container?: { slots: number };
  station?: { kind: StationKind; maxFuel: number; heat: number; needsFuel: boolean };
  plot?: { fertility: number; moisture: number };
  light?: { radius: number; fuelPerTick: number };
  bed?: { comfort: number };
  door?: { lockable: boolean };

  requiredSkill?: { id: SkillId; level: number };
  xp: number;
  destructible: boolean;
  /** Multiplier on damage zombies do to this structure. */
  zombieDamageMultiplier: number;
  /** Sprite keys for the client. */
  sprite: string;
  spriteOpen?: string;
  /** Ordering in the build menu. */
  sortOrder: number;
}

// ---------------------------------------------------------------------------
// Resource nodes
// ---------------------------------------------------------------------------

export type NodeCategory =
  'tree' | 'rock' | 'ore' | 'bush' | 'plant' | 'water' | 'scrap' | 'corpse';

export interface ResourceNodeDef {
  id: ResourceNodeDefId;
  name: string;
  category: NodeCategory;
  maxHealth: number;
  /** Tool roles that work on this node. Empty means bare hands are fine. */
  toolKinds: ToolKind[];
  /** Minimum tool tier for full effect. */
  minToolTier: number;
  /** Damage multiplier when using no tool or the wrong one. 0 makes it impossible. */
  wrongToolMultiplier: number;
  /** Dropped when the node is depleted. */
  yields: LootEntry[];
  /** Dropped on every successful hit. */
  yieldPerHit: LootEntry[];
  /** Ticks until it regrows. -1 means never. */
  respawnTicks: number;
  /** Collision radius in pixels. 0 means it does not block. */
  radius: number;
  blocksMovement: boolean;
  blocksSight: boolean;
  skill: SkillId;
  xpPerHit: number;
  xpOnDeplete: number;
  /** Number of sprite variants. */
  variants: number;
  sprite: string;
  /** Noise radius when struck. */
  noise: number;
  /** Which biomes it generates in, and with what weight. */
  spawnBiomes: Partial<Record<BiomeId, number>>;
  /** Nodes per chunk at density 1. */
  densityPerChunk: number;
}

// ---------------------------------------------------------------------------
// Creatures
// ---------------------------------------------------------------------------

export interface ZombieDef {
  id: ZombieDefId;
  name: string;
  /** Rough power tier, used to gate spawns by day count. */
  tier: number;
  maxHealth: number;
  /** Scales body-part max health. */
  bodyScale: number;
  speedWalk: number;
  speedChase: number;
  radius: number;

  damage: number;
  damageType: DamageType;
  attackRange: number;
  attackTicks: number;
  windupTicks: number;
  /** Probability an attack lands as a bite (infection vector), 0..1. */
  biteChance: number;
  infectionChance: number;
  knockback: number;

  sightRange: number;
  /** Half-angle of the vision cone, in radians. */
  sightHalfAngle: number;
  hearingRange: number;
  /** Ticks of not seeing the target before giving up. */
  loseInterestTicks: number;

  armor: Partial<Record<DamageType, number>>;
  /** Resistance to stagger, 0..1. */
  staggerResist: number;

  canOpenDoors: boolean;
  attacksStructures: boolean;
  structureDamage: number;
  /** Speed multiplier once the legs are gone. */
  crawlSpeedMultiplier: number;

  xp: number;
  lootTableId?: LootTableId;

  /** Weight in the spawn pool. */
  spawnWeight: number;
  /** Earliest in-game day this type appears. */
  minDay: number;
  /** Only spawns at night. */
  nightOnly: boolean;
  /** Ambient noise radius, used to alert other zombies to a chase. */
  noise: number;
  sprite: string;
}

export type AnimalBehavior = 'passive' | 'skittish' | 'aggressive' | 'territorial';

export interface AnimalDef {
  id: AnimalDefId;
  name: string;
  maxHealth: number;
  speedWalk: number;
  speedRun: number;
  radius: number;
  behavior: AnimalBehavior;
  /** Distance at which it notices a threat. */
  sightRange: number;
  /** Distance at which it bolts. */
  fleeRange: number;
  damage: number;
  damageType: DamageType;
  attackRange: number;
  attackTicks: number;
  lootTableId: LootTableId;
  xp: number;
  skill: SkillId;
  spawnWeight: number;
  spawnBiomes: Partial<Record<BiomeId, number>>;
  nocturnal: boolean;
  /** Animals per chunk at density 1. */
  densityPerChunk: number;
  sprite: string;
}

export interface ProjectileDef {
  id: ProjectileDefId;
  /** px/second. */
  speed: number;
  maxRange: number;
  /** Hit radius in pixels. */
  radius: number;
  /** How many entities it can pass through. */
  pierce: number;
  /** Damage multiplier at max range, 0..1. */
  damageFalloff: number;
  /** Whether it can be picked back up (arrows, bolts). */
  recoverDefId?: ItemDefId;
  recoverChance?: number;
  sprite: string;
  trail: boolean;
}

// ---------------------------------------------------------------------------
// Crops
// ---------------------------------------------------------------------------

export interface CropDef {
  id: CropDefId;
  name: string;
  seedDefId: ItemDefId;
  produceDefId: ItemDefId;
  /** Number of visible growth stages, including the mature one. */
  stages: number;
  /** Ticks required for each stage transition. Length must equal `stages - 1`. */
  ticksPerStage: number[];
  /** Soil moisture consumed per tick, in moisture points. */
  waterPerTick: number;
  /** Below this soil moisture the crop starts losing health. */
  minMoisture: number;
  /** Comfortable temperature band, degrees Celsius. */
  idealTemperature: [number, number];
  /** Dies if the temperature drops below this. */
  frostTemperature: number;
  /** Seasons the crop will grow in. Outside them it stalls. */
  seasons: Season[];
  yieldMin: number;
  yieldMax: number;
  /** Extra seeds recovered on harvest. */
  seedYield: [number, number];
  /** Whether it regrows after harvest instead of dying. */
  regrows: boolean;
  harvestsPerPlant: number;
  /** Soil fertility consumed per harvest. */
  fertilityCost: number;
  /** Per-tick chance of catching blight, before modifiers. */
  blightChance: number;
  xpPerHarvest: number;
  sprite: string;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/** Read-only lookup table keyed by definition id. */
export interface Registry<T> {
  get(id: string): T | undefined;
  /** Throws a descriptive error when the id is unknown. Use in trusted paths. */
  require(id: string): T;
  has(id: string): boolean;
  all(): readonly T[];
  ids(): readonly string[];
  readonly size: number;
}

/** Everything static about the game's content, resolved and validated once. */
export interface GameData {
  /** Stable hash of every table. Clients refuse to join on a mismatch. */
  readonly version: string;
  readonly items: Registry<ItemDef>;
  readonly recipes: Registry<RecipeDef>;
  readonly structures: Registry<StructureDef>;
  readonly nodes: Registry<ResourceNodeDef>;
  readonly zombies: Registry<ZombieDef>;
  readonly animals: Registry<AnimalDef>;
  readonly crops: Registry<CropDef>;
  readonly projectiles: Registry<ProjectileDef>;
  readonly lootTables: Registry<LootTableDef>;

  /** Recipes available at a station (or by hand when `station` is undefined). */
  recipesForStation(station: StationKind | undefined): readonly RecipeDef[];
  /** Structures placeable from the build menu, sorted for display. */
  buildableStructures(): readonly StructureDef[];
  /** Items carrying a tag, for tag-based recipe inputs. */
  itemsWithTag(tag: string): readonly ItemDef[];
  /** Node definitions that can generate in a biome. */
  nodesForBiome(biome: BiomeId): readonly ResourceNodeDef[];
  /** Zombie definitions eligible on a given day. */
  zombiesForDay(day: number, night: boolean): readonly ZombieDef[];
  /** Animal definitions that can generate in a biome. */
  animalsForBiome(biome: BiomeId): readonly AnimalDef[];
}
