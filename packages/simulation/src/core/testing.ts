import {
  Rng,
  SIM_DT,
  SimulationClock,
  Tile,
  createRngState,
  pixelToTile,
  singlePlayerConfig,
  tileProps,
  type ItemDefId,
  type SimulationConfig,
} from '@survive/protocol';
import type {
  AnimalDef,
  CropDef,
  GameData,
  ItemDef,
  LootTableDef,
  ProjectileDef,
  RecipeDef,
  ResourceNodeDef,
  Registry,
  StationKind,
  StructureDef,
  ZombieDef,
} from '@survive/game-data';
import {
  CollisionFlag,
  SOLID_MASK,
  type CollisionFlags,
  type FlowField,
  type MoveResult,
  type PathOptions,
  type RaycastHit,
  type TerrainGenerator,
  type WorldService,
} from '@survive/world';
import { TickEventSink } from './events';
import { IdAllocator } from './ids';
import { nullLogger } from './logger';
import { SpatialIndex } from './spatial';
import { createEmptyState, type SimulationState } from './state';
import type { CurrentInputs, SimContext } from './context';

/**
 * Minimal doubles for unit-testing the core services.
 *
 * These are deliberately tiny: a handful of items and a flat, empty world. Testing
 * `applyDamage` against the real content tables would couple a mechanics test to
 * balance numbers that are expected to change. Full-content and full-simulation
 * fixtures live in `@survive/test-utils` instead.
 */

function registry<T extends { id: string }>(items: readonly T[], label: string): Registry<T> {
  const map = new Map<string, T>();
  for (const item of items) map.set(item.id, item);
  return {
    get: (id) => map.get(id),
    require: (id) => {
      const found = map.get(id);
      if (!found) throw new Error(`Unknown ${label}: ${id}`);
      return found;
    },
    has: (id) => map.has(id),
    all: () => [...map.values()],
    ids: () => [...map.keys()],
    get size() {
      return map.size;
    },
  };
}

function item(partial: Partial<ItemDef> & { id: string }): ItemDef {
  return {
    name: partial.id,
    description: '',
    category: 'resource',
    stackSize: 50,
    weight: 0.5,
    icon: partial.id,
    rarity: 'common',
    tags: [],
    ...partial,
  };
}

/** A small item table covering every mechanic the core services touch. */
export const MINI_ITEMS: ItemDef[] = [
  item({ id: 'wood', stackSize: 100, weight: 1 }),
  item({ id: 'stone', stackSize: 100, weight: 2 }),
  item({
    id: 'apple',
    category: 'food',
    stackSize: 10,
    weight: 0.2,
    food: { nutrition: 12, hydration: 4, stamina: 0, health: 0, eatTicks: 20, sicknessChance: 0 },
    perishable: { spoilTicks: 2000, refrigeratedMultiplier: 0.4 },
  }),
  item({
    id: 'axe',
    category: 'tool',
    stackSize: 1,
    weight: 2,
    maxDurability: 100,
    tool: { kinds: ['axe'], tier: 1, efficiency: 1, durabilityPerUse: 1 },
  }),
  item({
    id: 'good_axe',
    category: 'tool',
    stackSize: 1,
    weight: 2,
    maxDurability: 200,
    tool: { kinds: ['axe'], tier: 3, efficiency: 1.6, durabilityPerUse: 1 },
  }),
  item({
    id: 'club',
    category: 'weapon',
    stackSize: 1,
    weight: 2.5,
    maxDurability: 80,
    weapon: {
      kind: 'melee',
      damage: 18,
      damageType: 'blunt',
      range: 42,
      arcDegrees: 80,
      attackTicks: 14,
      windupTicks: 3,
      staminaCost: 6,
      knockback: 90,
      critChance: 0.05,
      critMultiplier: 1.6,
      armorPen: 0,
      skill: 'melee',
      durabilityPerHit: 1,
      loudness: 130,
      twoHanded: false,
      maxTargets: 1,
    },
  }),
  item({
    id: 'vest',
    category: 'armor',
    stackSize: 1,
    weight: 4,
    maxDurability: 150,
    armor: {
      slot: 'chest',
      coverage: { torso: 0.9 },
      protection: { blunt: 6, slash: 8, bullet: 4, pierce: 5, zombieBite: 10 },
      warmth: 2,
      encumbrance: 0.05,
      durabilityPerHit: 1,
      biteResistance: 0.5,
    },
  }),
  item({ id: 'pack', category: 'container', stackSize: 1, weight: 1.5, containerSlots: 8 }),
  item({
    id: 'bottle',
    category: 'drink',
    stackSize: 1,
    weight: 0.5,
    liquid: { capacity: 100, contentDefId: 'water', fillable: true },
  }),
  item({ id: 'water', category: 'drink', stackSize: 1, weight: 1 }),
];

export const MINI_LOOT: LootTableDef[] = [
  {
    id: 'test_common',
    rolls: [2, 3],
    entries: [
      { defId: 'wood', min: 1, max: 3, chance: 1, weight: 5 },
      { defId: 'stone', min: 1, max: 2, chance: 1, weight: 3 },
      { defId: 'axe', min: 1, max: 1, chance: 0.5, weight: 1, condition: [0.2, 0.8] },
    ],
    guaranteed: [{ defId: 'apple', min: 1, max: 1, chance: 1 }],
  },
];

export const MINI_ZOMBIES: ZombieDef[] = [
  {
    id: 'walker',
    name: 'Walker',
    tier: 1,
    maxHealth: 60,
    bodyScale: 0.7,
    speedWalk: 40,
    speedChase: 78,
    radius: 11,
    damage: 9,
    damageType: 'zombieBite',
    attackRange: 26,
    attackTicks: 20,
    windupTicks: 6,
    biteChance: 0.5,
    infectionChance: 0.25,
    knockback: 40,
    sightRange: 320,
    sightHalfAngle: 1.2,
    hearingRange: 420,
    loseInterestTicks: 200,
    armor: {},
    staggerResist: 0,
    canOpenDoors: false,
    attacksStructures: true,
    structureDamage: 6,
    crawlSpeedMultiplier: 0.4,
    xp: 6,
    lootTableId: 'test_common',
    spawnWeight: 10,
    minDay: 1,
    nightOnly: false,
    noise: 120,
    sprite: 'walker',
  },
  {
    id: 'armored',
    name: 'Armored',
    tier: 3,
    maxHealth: 120,
    bodyScale: 1,
    speedWalk: 34,
    speedChase: 62,
    radius: 12,
    damage: 14,
    damageType: 'blunt',
    attackRange: 28,
    attackTicks: 26,
    windupTicks: 8,
    biteChance: 0.2,
    infectionChance: 0.25,
    knockback: 70,
    sightRange: 300,
    sightHalfAngle: 1.1,
    hearingRange: 380,
    loseInterestTicks: 260,
    armor: { blunt: 4, slash: 10, bullet: 8, pierce: 9 },
    staggerResist: 0.7,
    canOpenDoors: true,
    attacksStructures: true,
    structureDamage: 14,
    crawlSpeedMultiplier: 0.4,
    xp: 20,
    spawnWeight: 2,
    minDay: 8,
    nightOnly: false,
    noise: 140,
    sprite: 'armored',
  },
];

export const MINI_ANIMALS: AnimalDef[] = [
  {
    id: 'rabbit',
    name: 'Rabbit',
    maxHealth: 14,
    speedWalk: 50,
    speedRun: 175,
    radius: 6,
    behavior: 'skittish',
    sightRange: 260,
    fleeRange: 190,
    damage: 0,
    damageType: 'blunt',
    attackRange: 0,
    attackTicks: 0,
    lootTableId: 'test_common',
    xp: 4,
    skill: 'foraging',
    spawnWeight: 8,
    spawnBiomes: {},
    nocturnal: false,
    densityPerChunk: 0.4,
    sprite: 'rabbit',
  },
  {
    id: 'wolf',
    name: 'Wolf',
    maxHealth: 45,
    speedWalk: 62,
    speedRun: 190,
    radius: 10,
    behavior: 'aggressive',
    sightRange: 380,
    fleeRange: 0,
    damage: 12,
    damageType: 'slash',
    attackRange: 26,
    attackTicks: 18,
    lootTableId: 'test_common',
    xp: 14,
    skill: 'melee',
    spawnWeight: 3,
    spawnBiomes: {},
    nocturnal: true,
    densityPerChunk: 0.1,
    sprite: 'wolf',
  },
];

export const MINI_STRUCTURES: StructureDef[] = [
  {
    id: 'test_wall',
    name: 'Test Wall',
    description: '',
    category: 'wall',
    width: 1,
    height: 1,
    maxHealth: 200,
    buildTicks: 20,
    cost: [{ defId: 'wood', count: 4 }],
    refundRatio: 0.5,
    blocksMovement: true,
    blocksSight: true,
    stacksOver: ['floor'],
    requiresSupport: false,
    placeOn: 'any',
    requiredSkill: undefined,
    xp: 5,
    destructible: true,
    zombieDamageMultiplier: 1,
    sprite: 'wall',
    sortOrder: 1,
  },
  {
    id: 'test_door',
    name: 'Test Door',
    description: '',
    category: 'door',
    width: 1,
    height: 1,
    maxHealth: 120,
    buildTicks: 30,
    cost: [{ defId: 'wood', count: 6 }],
    refundRatio: 0.5,
    blocksMovement: true,
    blocksSight: true,
    stacksOver: [],
    requiresSupport: false,
    placeOn: 'any',
    door: { lockable: true },
    xp: 8,
    destructible: true,
    zombieDamageMultiplier: 1.5,
    sprite: 'door',
    sortOrder: 2,
  },
  {
    id: 'test_box',
    name: 'Test Box',
    description: '',
    category: 'storage',
    width: 1,
    height: 1,
    maxHealth: 60,
    buildTicks: 20,
    cost: [{ defId: 'wood', count: 8 }],
    refundRatio: 0.6,
    blocksMovement: false,
    blocksSight: false,
    stacksOver: [],
    requiresSupport: false,
    placeOn: 'any',
    container: { slots: 12 },
    xp: 6,
    destructible: true,
    zombieDamageMultiplier: 1,
    sprite: 'box',
    sortOrder: 3,
  },
  {
    id: 'test_plot',
    name: 'Test Plot',
    description: '',
    category: 'farm',
    width: 1,
    height: 1,
    maxHealth: 30,
    buildTicks: 15,
    cost: [{ defId: 'wood', count: 2 }],
    refundRatio: 0.3,
    blocksMovement: false,
    blocksSight: false,
    stacksOver: [],
    requiresSupport: false,
    placeOn: 'ground',
    plot: { fertility: 80, moisture: 50 },
    xp: 4,
    destructible: true,
    zombieDamageMultiplier: 1,
    sprite: 'plot',
    sortOrder: 4,
  },
];

export const MINI_NODES: ResourceNodeDef[] = [
  {
    id: 'test_tree',
    name: 'Test Tree',
    category: 'tree',
    maxHealth: 100,
    toolKinds: ['axe'],
    minToolTier: 1,
    wrongToolMultiplier: 0.15,
    yields: [{ defId: 'wood', min: 3, max: 5, chance: 1 }],
    yieldPerHit: [{ defId: 'wood', min: 1, max: 1, chance: 0.5 }],
    respawnTicks: 5000,
    radius: 12,
    blocksMovement: true,
    blocksSight: true,
    skill: 'woodcutting',
    xpPerHit: 1,
    xpOnDeplete: 8,
    variants: 2,
    sprite: 'tree',
    noise: 260,
    spawnBiomes: {},
    densityPerChunk: 4,
  },
  {
    id: 'test_boulder',
    name: 'Test Boulder',
    category: 'rock',
    maxHealth: 160,
    toolKinds: ['pickaxe'],
    minToolTier: 1,
    wrongToolMultiplier: 0,
    yields: [{ defId: 'stone', min: 4, max: 8, chance: 1 }],
    yieldPerHit: [],
    respawnTicks: -1,
    radius: 14,
    blocksMovement: true,
    blocksSight: false,
    skill: 'mining',
    xpPerHit: 1,
    xpOnDeplete: 12,
    variants: 1,
    sprite: 'boulder',
    noise: 300,
    spawnBiomes: {},
    densityPerChunk: 1,
  },
];

export const MINI_CROPS: CropDef[] = [
  {
    id: 'test_wheat',
    name: 'Test Wheat',
    seedDefId: 'wood',
    produceDefId: 'apple',
    stages: 4,
    ticksPerStage: [400, 400, 400],
    waterPerTick: 0.02,
    minMoisture: 15,
    idealTemperature: [10, 30],
    frostTemperature: 0,
    seasons: ['spring', 'summer', 'autumn'],
    yieldMin: 2,
    yieldMax: 4,
    seedYield: [1, 2],
    regrows: false,
    harvestsPerPlant: 1,
    fertilityCost: 10,
    blightChance: 0.00002,
    xpPerHarvest: 6,
    sprite: 'wheat',
  },
];

export const MINI_RECIPES: RecipeDef[] = [
  {
    id: 'test_axe',
    name: 'Test Axe',
    category: 'tools',
    inputs: [
      { defId: 'wood', count: 2 },
      { defId: 'stone', count: 3 },
    ],
    tools: [],
    outputs: [{ defId: 'axe', count: 1 }],
    craftTicks: 40,
    xp: { skill: 'crafting', amount: 5 },
    unlockedByDefault: true,
  },
];

export const MINI_PROJECTILES: ProjectileDef[] = [
  {
    id: 'test_arrow',
    speed: 620,
    maxRange: 700,
    radius: 4,
    pierce: 0,
    damageFalloff: 0.7,
    recoverDefId: 'wood',
    recoverChance: 0.5,
    sprite: 'arrow',
    trail: false,
  },
];

/** A tiny, fully valid {@link GameData} for mechanics tests. */
export function createMiniGameData(): GameData {
  const items = registry(MINI_ITEMS, 'item');
  const recipes = registry(MINI_RECIPES, 'recipe');
  const structures = registry(MINI_STRUCTURES, 'structure');
  const nodes = registry(MINI_NODES, 'node');
  const zombies = registry(MINI_ZOMBIES, 'zombie');
  const animals = registry(MINI_ANIMALS, 'animal');
  const crops = registry(MINI_CROPS, 'crop');
  const projectiles = registry(MINI_PROJECTILES, 'projectile');
  const lootTables = registry(MINI_LOOT, 'loot table');
  return {
    version: 'mini',
    items,
    recipes,
    structures,
    nodes,
    zombies,
    animals,
    crops,
    projectiles,
    lootTables,
    recipesForStation: (station: StationKind | undefined) =>
      recipes.all().filter((recipe) => recipe.station === station),
    buildableStructures: () => [...structures.all()].sort((a, b) => a.sortOrder - b.sortOrder),
    itemsWithTag: (tag: string) => items.all().filter((def) => def.tags.includes(tag)),
    nodesForBiome: () => nodes.all(),
    zombiesForDay: (day, night) =>
      zombies.all().filter((def) => def.minDay <= day && (!def.nightOnly || night)),
    animalsForBiome: () => animals.all(),
  };
}

/**
 * A flat, empty world with a mutable collision grid.
 *
 * Enough to exercise movement, line of sight and structure attachment without pulling
 * in terrain generation.
 */
export interface StubWorld extends WorldService {
  /** Make a tile solid, as a test would to build a wall. */
  setSolid(tileX: number, tileY: number, solid: boolean, opaque?: boolean): void;
}

export function createStubWorld(defaultTile: number = Tile.Grass): StubWorld {
  const tiles = new Map<string, number>();
  const collision = new Map<string, CollisionFlags>();
  const key = (tileX: number, tileY: number) => `${tileX},${tileY}`;

  const generator: TerrainGenerator = {
    seed: 1,
    version: 1,
    generate: (cx, cy) => ({ cx, cy, tiles: [], biomes: [], version: 1 }),
    biomeAt: () => 0,
    isUrban: () => false,
  };

  const getTile = (tileX: number, tileY: number) => tiles.get(key(tileX, tileY)) ?? defaultTile;
  const getCollision = (tileX: number, tileY: number) => {
    const explicit = collision.get(key(tileX, tileY));
    if (explicit !== undefined) return explicit;
    const props = tileProps(getTile(tileX, tileY));
    let flags: CollisionFlags = CollisionFlag.None;
    if (props.solid) flags |= CollisionFlag.TerrainSolid;
    if (props.opaque) flags |= CollisionFlag.TerrainOpaque;
    return flags;
  };
  const isSolidTile = (tileX: number, tileY: number) =>
    (getCollision(tileX, tileY) & SOLID_MASK) !== 0;
  const circleBlocked = (x: number, y: number, radius: number) => {
    const minX = pixelToTile(x - radius);
    const maxX = pixelToTile(x + radius);
    const minY = pixelToTile(y - radius);
    const maxY = pixelToTile(y + radius);
    for (let tileY = minY; tileY <= maxY; tileY++) {
      for (let tileX = minX; tileX <= maxX; tileX++) {
        if (isSolidTile(tileX, tileY)) return true;
      }
    }
    return false;
  };

  const world: StubWorld = {
    seed: 1,
    generator,
    ensureChunk: (cx, cy) => ({ cx, cy, tiles: [], biomes: [], version: 1 }),
    isChunkLoaded: () => true,
    loadedChunkKeys: () => [],
    unloadChunk: () => {},
    getTile,
    getTileAt: (x, y) => getTile(pixelToTile(x), pixelToTile(y)),
    getBiome: () => 0,
    setTile: (tileX, tileY, tile) => {
      tiles.set(key(tileX, tileY), tile);
      collision.delete(key(tileX, tileY));
    },
    getOverrides: () => [],
    applyOverrides: () => {},
    addCollision: (tileX, tileY, flags) => {
      collision.set(key(tileX, tileY), getCollision(tileX, tileY) | flags);
    },
    removeCollision: (tileX, tileY, flags) => {
      collision.set(key(tileX, tileY), getCollision(tileX, tileY) & ~flags);
    },
    getCollision,
    isSolidTile,
    isSolidAt: (x, y) => isSolidTile(pixelToTile(x), pixelToTile(y)),
    isOpaqueTile: (tileX, tileY) =>
      (getCollision(tileX, tileY) &
        (CollisionFlag.TerrainOpaque | CollisionFlag.StructureOpaque)) !==
      0,
    speedAt: (x, y) => tileProps(getTile(pixelToTile(x), pixelToTile(y))).speed,
    circleBlocked,
    moveCircle: (x, y, dx, dy, radius): MoveResult => {
      // Axis-separated so a diagonal push into a wall still slides.
      let nextX = x;
      let nextY = y;
      let blockedX = false;
      let blockedY = false;
      if (dx !== 0) {
        if (circleBlocked(x + dx, y, radius)) blockedX = true;
        else nextX = x + dx;
      }
      if (dy !== 0) {
        if (circleBlocked(nextX, y + dy, radius)) blockedY = true;
        else nextY = y + dy;
      }
      return { x: nextX, y: nextY, blockedX, blockedY };
    },
    raycast: (x0, y0, x1, y1): RaycastHit | null => {
      const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 4);
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const px = x0 + (x1 - x0) * t;
        const py = y0 + (y1 - y0) * t;
        const tileX = pixelToTile(px);
        const tileY = pixelToTile(py);
        if (isSolidTile(tileX, tileY)) {
          return {
            x: px,
            y: py,
            tileX,
            tileY,
            distance: Math.hypot(px - x0, py - y0),
            flags: getCollision(tileX, tileY),
          };
        }
      }
      return null;
    },
    hasLineOfSight: (x0, y0, x1, y1) => {
      const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 4);
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const tileX = pixelToTile(x0 + (x1 - x0) * t);
        const tileY = pixelToTile(y0 + (y1 - y0) * t);
        if (
          (getCollision(tileX, tileY) &
            (CollisionFlag.TerrainOpaque | CollisionFlag.StructureOpaque)) !==
          0
        ) {
          return false;
        }
      }
      return true;
    },
    findPath: (
      _fromX: number,
      _fromY: number,
      _toX: number,
      _toY: number,
      _options?: PathOptions,
    ) => [],
    getFlowField: (): FlowField | null => null,
    sampleFlow: () => null,
    pruneFlowFields: () => {},
    // This stub never builds a field, so the counter never moves.
    flowFieldBuilds: 0,
    findSpawnPosition: (x, y) => ({ x, y }),
    setSolid: (tileX, tileY, solid, opaque = solid) => {
      let flags: CollisionFlags = CollisionFlag.None;
      if (solid) flags |= CollisionFlag.TerrainSolid;
      if (opaque) flags |= CollisionFlag.TerrainOpaque;
      collision.set(key(tileX, tileY), flags);
    },
  };
  return world;
}

/** Inputs double that records whatever a test sets. */
class TestInputs implements CurrentInputs {
  private current = new Map<string, never>();
  private prior = new Map<string, never>();
  get(playerId: string) {
    return this.current.get(playerId);
  }
  set(playerId: string, frame: never) {
    this.current.set(playerId, frame);
  }
  previous(playerId: string) {
    return this.prior.get(playerId);
  }
  clear() {
    this.current.clear();
    this.prior.clear();
  }
  remove(playerId: string) {
    this.current.delete(playerId);
    this.prior.delete(playerId);
  }
}

export interface TestContext {
  ctx: SimContext;
  state: SimulationState;
  events: TickEventSink;
  world: StubWorld;
  config: SimulationConfig;
  /** Advance the tick counter the way `Simulation.step` would, without running systems. */
  advance(ticks?: number): void;
}

/** Build a {@link SimContext} with no systems, for testing core services in isolation. */
export function createTestContext(options: { seed?: number } = {}): TestContext {
  const seed = options.seed ?? 1234;
  const config = singlePlayerConfig('test');
  config.world.seed = seed;
  const state = createEmptyState(seed, createRngState(seed));
  // Started from the state, not from zero. A new world begins on the morning of day 1
  // (`WORLD_START_TICK`), so a clock that started at 0 would make the first `advance`
  // *rewind* `state.tick` by eight game hours - and any effect or cooldown stamped
  // before it would sit in what the state then thinks is the far future.
  const clock = new SimulationClock(state.tick);
  const events = new TickEventSink();
  const world = createStubWorld();
  const ctx: SimContext = {
    state,
    clock,
    rng: new Rng(state.rng),
    data: createMiniGameData(),
    world,
    config,
    events,
    ids: new IdAllocator(state),
    log: nullLogger,
    spatial: new SpatialIndex(),
    inputs: new TestInputs() as unknown as CurrentInputs,
  };
  return {
    ctx,
    state,
    events,
    world,
    config,
    advance(ticks = 1) {
      clock.advance(ticks);
      state.tick = clock.tick;
      state.time.tick = clock.tick;
    },
  };
}

/** The fixed timestep, re-exported so tests do not import from two places. */
export const TEST_DT = SIM_DT;

/** Convenience for tests that need an item id from the mini table. */
export const MINI_ITEM_IDS: Record<string, ItemDefId> = {
  wood: 'wood',
  stone: 'stone',
  apple: 'apple',
  axe: 'axe',
  goodAxe: 'good_axe',
  club: 'club',
  vest: 'vest',
  pack: 'pack',
  bottle: 'bottle',
};
