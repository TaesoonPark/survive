import {
  BASE_INVENTORY_SLOTS,
  HOTBAR_SLOTS,
  SAVE_FORMAT_VERSION,
  chunkKey,
  createBody,
  createEmptyEquipment,
  createEmptyInventory,
  createEmptyChunkPayload,
  createPlayerStats,
  createSkills,
} from '@survive/protocol';
import type {
  AnimalState,
  ChunkDynamicPayload,
  ItemEntityState,
  PlayerSavePayload,
  PlayerState,
  ResourceNodeState,
  StructureState,
  ZombieState,
} from '@survive/protocol';

/**
 * Save-shaped test data.
 *
 * Lives in `src` rather than in a test file because all three backends' tests, the
 * migration tests and the portability test must persist *identical* payloads for the
 * comparisons to mean anything. It is only ever imported by tests; nothing in the
 * runtime save path touches it.
 *
 * The payloads are deliberately full rather than minimal: every optional field that a
 * JSON round-trip could quietly drop (`ownerId`, `droppedBy`, `targetId`, a nested
 * container) is populated somewhere below.
 */

/** A chunk with one of everything in it, deterministic in `cx`/`cy`. */
export function makeChunk(cx: number, cy: number): ChunkDynamicPayload {
  const base = createEmptyChunkPayload(chunkKey(cx, cy), cx, cy);
  const suffix = `${cx}_${cy}`;

  const structure: StructureState = {
    id: `s${suffix}`,
    defId: 'wall_wood',
    tileX: cx * 32 + 4,
    tileY: cy * 32 + 6,
    rotation: 1,
    health: 180,
    maxHealth: 200,
    ownerId: 'alice',
    builtTick: 1200,
    progress: 1,
    container: {
      slots: [{ defId: 'wood_log', count: 7 }, null],
      capacity: 2,
      rolled: true,
      viewers: [],
    },
    rev: 3,
  };

  const node: ResourceNodeState = {
    id: `n${suffix}`,
    defId: 'tree_pine',
    x: cx * 1024 + 128.5,
    y: cy * 1024 + 96.25,
    tileX: cx * 32 + 4,
    tileY: cy * 32 + 3,
    health: 40,
    maxHealth: 60,
    harvests: 2,
    depleted: false,
    respawnAtTick: -1,
    variant: 1,
    rev: 5,
  };

  const item: ItemEntityState = {
    id: `i${suffix}`,
    x: cx * 1024 + 512,
    y: cy * 1024 + 512,
    stack: { defId: 'canned_beans', count: 2, freshness: 0.75 },
    droppedTick: 900,
    despawnTick: 90_000,
    droppedBy: 'alice',
    rev: 1,
  };

  const zombie: ZombieState = {
    id: `z${suffix}`,
    defId: 'walker',
    x: cx * 1024 + 300,
    y: cy * 1024 + 700,
    vx: 12.5,
    vy: -3.25,
    facing: 1.5707963267948966,
    health: 55,
    maxHealth: 80,
    ai: 'pursue',
    lod: 1,
    nextThinkTick: 1310,
    targetId: 'alice',
    lastSeenX: cx * 1024 + 320,
    lastSeenY: cy * 1024 + 690,
    loseInterestTick: 1500,
    attackReadyTick: 1305,
    staggerUntilTick: 0,
    homeChunk: chunkKey(cx, cy),
    homeX: cx * 1024 + 256,
    homeY: cy * 1024 + 640,
    body: createBody(0.8),
    crawling: false,
    path: [cx * 32 + 9, cy * 32 + 21, cx * 32 + 10, cy * 32 + 21],
    pathIndex: 1,
    pathTick: 1300,
    rev: 42,
  };

  const animal: AnimalState = {
    id: `a${suffix}`,
    defId: 'deer',
    x: cx * 1024 + 800,
    y: cy * 1024 + 200,
    vx: 0,
    vy: 0,
    facing: 3.141592653589793,
    health: 30,
    maxHealth: 30,
    ai: 'graze',
    lod: 2,
    nextThinkTick: 1400,
    fleeUntilTick: 0,
    attackReadyTick: 0,
    homeChunk: chunkKey(cx, cy),
    homeX: cx * 1024 + 800,
    homeY: cy * 1024 + 200,
    wanderX: cx * 1024 + 830,
    wanderY: cy * 1024 + 240,
    rev: 7,
  };

  return {
    ...base,
    populated: true,
    overrides: [
      { index: 0, tile: 3 },
      { index: 511, tile: 9 },
    ],
    structures: [structure],
    nodes: [node],
    items: [item],
    zombies: [zombie],
    animals: [animal],
    nextSpawnTick: 2000,
  };
}

/** A player mid-game: hurt, carrying things, with a spawn point set. */
export function makePlayerState(id: string): PlayerState {
  const inventory = createEmptyInventory(BASE_INVENTORY_SLOTS);
  inventory.slots[0] = { defId: 'axe_stone', count: 1, durability: 41, quality: 0.6 };
  inventory.slots[3] = { defId: 'water_bottle', count: 1, fill: 0.5 };

  const equipment = createEmptyEquipment();
  equipment.chest = { defId: 'jacket_leather', count: 1, durability: 88 };

  return {
    id,
    name: `Survivor ${id}`,
    x: 1024.5,
    y: 2048.25,
    vx: 0,
    vy: 0,
    facing: 0,
    aimAngle: 0.5,
    health: 72,
    maxHealth: 100,
    hunger: 31,
    thirst: 18,
    fatigue: 44,
    stamina: 60,
    maxStamina: 100,
    temperature: 36.6,
    blood: 95,
    moveMode: 'walk',
    alive: true,
    deathTick: -1,
    respawnAtTick: 0,
    body: createBody(),
    inventory,
    equipment,
    hotbar: Array.from({ length: HOTBAR_SLOTS }, (_, index) => (index === 0 ? 0 : null)),
    activeHotbar: 0,
    skills: createSkills(),
    effects: [],
    craftQueue: [],
    attackReadyTick: 0,
    useReadyTick: 0,
    actionLockedUntilTick: 0,
    buildRotation: 0,
    spawnX: 1000,
    spawnY: 2000,
    bedStructureId: 's1_1',
    stats: createPlayerStats(),
    carryWeight: 12.5,
    carryCapacity: 40,
    lastInputSeq: 8134,
    rev: 991,
  };
}

/** A player save record wrapping {@link makePlayerState}. */
export function makePlayerSave(id: string, savedAtMs = 1_700_000_000_000): PlayerSavePayload {
  return { version: SAVE_FORMAT_VERSION, player: makePlayerState(id), savedAtMs };
}
