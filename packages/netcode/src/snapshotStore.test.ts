import { describe, expect, it } from 'vitest';
import {
  BASE_INVENTORY_SLOTS,
  CHUNK_TILES,
  CHUNK_TILE_COUNT,
  HOTBAR_SLOTS,
  chunkKey,
  createBody,
  createEmptyEquipment,
  createEmptyInventory,
  createPlayerStats,
  createSkills,
} from '@survive/protocol';
import type {
  ChunkPayload,
  EntityId,
  EntitySnapshot,
  OpenContainerView,
  PlayerState,
  WeatherState,
  WorldSnapshot,
  WorldTimeState,
} from '@survive/protocol';
import { SnapshotStore } from './snapshotStore';

describe('SnapshotStore', () => {
  it('applies the first snapshot and reports every entity as added', () => {
    const store = new SnapshotStore();
    const added: EntityId[] = [];
    store.subscribe({ onEntityAdded: (entity) => added.push(entity.id) });

    const accepted = store.applySnapshot(
      snapshot({ tick: 10, ackSeq: 4, entities: [zombie('z1'), zombie('z2'), item('i1')] }),
    );

    expect(accepted).toBe(true);
    expect(store.tick).toBe(10);
    expect(store.ackSeq).toBe(4);
    expect(store.entityCount).toBe(3);
    expect(added).toEqual(['z1', 'z2', 'i1']);
    expect(store.self?.id).toBe('alice');
    expect(store.time?.day).toBe(3);
    expect(store.weather?.type).toBe('rain');
    expect(store.paused).toBe(false);
  });

  it('ignores a snapshot with a tick it has already seen', () => {
    const store = new SnapshotStore();
    store.applySnapshot(snapshot({ tick: 10, entities: [zombie('z1')] }));

    let notified = 0;
    store.subscribe({ onSnapshotApplied: () => notified++ });

    expect(store.applySnapshot(snapshot({ tick: 10, entities: [] }))).toBe(false);
    expect(store.applySnapshot(snapshot({ tick: 9, entities: [], removed: ['z1'] }))).toBe(false);
    expect(notified).toBe(0);
    // The stale snapshot must not have resurrected or removed anything.
    expect(store.entityCount).toBe(1);
    expect(store.tick).toBe(10);
    expect(store.staleSnapshotCount).toBe(2);

    expect(store.applySnapshot(snapshot({ tick: 11, entities: [] }))).toBe(true);
    expect(notified).toBe(1);
    expect(store.appliedSnapshotCount).toBe(2);
  });

  it('never rewinds the acknowledged input sequence', () => {
    const store = new SnapshotStore();
    store.applySnapshot(snapshot({ tick: 1, ackSeq: 30 }));
    store.applySnapshot(snapshot({ tick: 2, ackSeq: 12 }));

    expect(store.ackSeq).toBe(30);
  });

  it('applies removals and notifies with the last known state', () => {
    const store = new SnapshotStore();
    store.applySnapshot(snapshot({ tick: 1, entities: [zombie('z1'), zombie('z2')] }));

    const removed: Array<{ id: EntityId; kind: string }> = [];
    store.subscribe({ onEntityRemoved: (id, previous) => removed.push({ id, kind: previous.k }) });

    store.applySnapshot(snapshot({ tick: 2, removed: ['z1', 'ghost'] }));

    expect(removed).toEqual([{ id: 'z1', kind: 'zombie' }]);
    expect(store.entity('z1')).toBeUndefined();
    expect(store.entityCount).toBe(1);
    expect(store.entitiesOfKind('zombie').map((entity) => entity.id)).toEqual(['z2']);
  });

  it('reports updates rather than adds for entities it already tracks', () => {
    const store = new SnapshotStore();
    store.applySnapshot(snapshot({ tick: 1, entities: [zombie('z1', { x: 0, rev: 1 })] }));

    const events: string[] = [];
    store.subscribe({
      onEntityAdded: () => events.push('added'),
      onEntityUpdated: (entity, previous) => events.push(`${previous.rev}->${entity.rev}`),
    });
    store.applySnapshot(snapshot({ tick: 2, entities: [zombie('z1', { x: 64, rev: 2 })] }));

    expect(events).toEqual(['1->2']);
    const tracked = store.entity('z1');
    expect(tracked?.k).toBe('zombie');
    expect(tracked && 'x' in tracked ? tracked.x : undefined).toBe(64);
  });

  it('indexes entities by kind', () => {
    const store = new SnapshotStore();
    store.applySnapshot(
      snapshot({ tick: 1, entities: [zombie('z1'), zombie('z2'), item('i1'), node('n1')] }),
    );

    expect(store.entitiesOfKind('zombie')).toHaveLength(2);
    expect(store.entitiesOfKind('item')).toHaveLength(1);
    expect(store.entitiesOfKind('node')).toHaveLength(1);
    expect(store.entitiesOfKind('player')).toEqual([]);
  });

  it('tracks the open container, including closing it', () => {
    const store = new SnapshotStore();
    const seen: Array<OpenContainerView | null> = [];
    store.subscribe({ onContainerChanged: (container) => seen.push(container) });

    store.applySnapshot(snapshot({ tick: 1 }));
    expect(seen).toHaveLength(0);
    expect(store.container).toBeNull();

    store.applySnapshot(snapshot({ tick: 2, container: container('s7') }));
    expect(store.container?.structureId).toBe('s7');

    store.applySnapshot(snapshot({ tick: 3 }));
    expect(store.container).toBeNull();
    expect(seen).toEqual([container('s7'), null]);
  });

  it('caches chunk terrain and answers tile lookups', () => {
    const store = new SnapshotStore();
    const loaded: string[] = [];
    const dropped: string[] = [];
    store.subscribe({
      onChunkLoaded: (chunk) => loaded.push(chunk.key),
      onChunkDropped: (key) => dropped.push(key),
    });

    store.applyChunk(chunk(2, 3, 7, 1));
    expect(loaded).toEqual(['2,3']);
    expect(store.chunkCount).toBe(1);
    expect(store.hasChunk(chunkKey(2, 3))).toBe(true);

    // Any tile inside chunk (2,3) resolves through the cache.
    const tileX = 2 * CHUNK_TILES + 5;
    const tileY = 3 * CHUNK_TILES + 9;
    expect(store.tileAt(tileX, tileY)).toBe(7);
    expect(store.biomeAt(tileX, tileY)).toBe(1);
    // A tile in an unloaded chunk is unknown, not zero.
    expect(store.tileAt(0, 0)).toBeUndefined();

    store.dropChunks([chunkKey(2, 3), chunkKey(9, 9)]);
    expect(dropped).toEqual(['2,3']);
    expect(store.chunkCount).toBe(0);
    expect(store.tileAt(tileX, tileY)).toBeUndefined();
  });

  it('reset tears down every sprite and forgets the world', () => {
    const store = new SnapshotStore();
    store.applySnapshot(
      snapshot({ tick: 5, entities: [zombie('z1')], container: container('s1') }),
    );
    store.applyChunk(chunk(0, 0, 1, 0));

    const removed: EntityId[] = [];
    const droppedChunks: string[] = [];
    const containers: Array<OpenContainerView | null> = [];
    store.subscribe({
      onEntityRemoved: (id) => removed.push(id),
      onChunkDropped: (key) => droppedChunks.push(key),
      onContainerChanged: (view) => containers.push(view),
    });

    store.reset();

    expect(removed).toEqual(['z1']);
    expect(droppedChunks).toEqual(['0,0']);
    expect(containers).toEqual([null]);
    expect(store.entityCount).toBe(0);
    expect(store.tick).toBe(-1);
    expect(store.self).toBeNull();
    // A fresh world starting at tick 0 must be accepted after a reset.
    expect(store.applySnapshot(snapshot({ tick: 0 }))).toBe(true);
  });

  it('stops notifying an unsubscribed listener', () => {
    const store = new SnapshotStore();
    let count = 0;
    const unsubscribe = store.subscribe({ onSnapshotApplied: () => count++ });

    store.applySnapshot(snapshot({ tick: 1 }));
    unsubscribe();
    store.applySnapshot(snapshot({ tick: 2 }));

    expect(count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function player(): PlayerState {
  return {
    id: 'alice',
    name: 'Alice',
    x: 100,
    y: 200,
    vx: 0,
    vy: 0,
    facing: 0,
    aimAngle: 0,
    health: 100,
    maxHealth: 100,
    hunger: 0,
    thirst: 0,
    fatigue: 0,
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
    spawnX: 100,
    spawnY: 200,
    stats: createPlayerStats(),
    carryWeight: 0,
    carryCapacity: 30,
    lastInputSeq: 0,
    rev: 1,
  };
}

function time(): WorldTimeState {
  return {
    tick: 100,
    day: 3,
    hour: 12,
    minute: 30,
    season: 'spring',
    year: 1,
    dayProgress: 0.5,
    isNight: false,
    lightLevel: 1,
  };
}

function weather(): WeatherState {
  return {
    type: 'rain',
    intensity: 0.4,
    temperature: 12,
    windAngle: 0,
    windSpeed: 20,
    nextChangeTick: 5000,
    lightning: false,
  };
}

function zombie(id: EntityId, overrides: { x?: number; rev?: number } = {}): EntitySnapshot {
  return {
    k: 'zombie',
    id,
    defId: 'walker',
    x: overrides.x ?? 0,
    y: 0,
    facing: 0,
    health: 100,
    maxHealth: 100,
    ai: 'wander',
    crawling: false,
    attacking: false,
    rev: overrides.rev ?? 1,
  };
}

function item(id: EntityId): EntitySnapshot {
  return { k: 'item', id, x: 0, y: 0, stack: { defId: 'wood_log', count: 3 }, rev: 1 };
}

function node(id: EntityId): EntitySnapshot {
  return {
    k: 'node',
    id,
    defId: 'tree_pine',
    x: 0,
    y: 0,
    tileX: 0,
    tileY: 0,
    health: 100,
    maxHealth: 100,
    harvests: 0,
    depleted: false,
    respawnAtTick: -1,
    variant: 0,
    rev: 1,
  };
}

function container(structureId: EntityId): OpenContainerView {
  return { structureId, defId: 'crate', slots: [null, null], capacity: 2 };
}

function chunk(cx: number, cy: number, tile: number, biome: number): ChunkPayload {
  return {
    key: chunkKey(cx, cy),
    cx,
    cy,
    tiles: new Array<number>(CHUNK_TILE_COUNT).fill(tile),
    biomes: new Array<number>(CHUNK_TILE_COUNT).fill(biome),
    version: 1,
  };
}

function snapshot(overrides: {
  tick: number;
  ackSeq?: number;
  entities?: EntitySnapshot[];
  removed?: EntityId[];
  container?: OpenContainerView;
}): WorldSnapshot {
  const base: WorldSnapshot = {
    tick: overrides.tick,
    serverTimeMs: overrides.tick * 50,
    ackSeq: overrides.ackSeq ?? 0,
    self: player(),
    entities: overrides.entities ?? [],
    removed: overrides.removed ?? [],
    time: time(),
    weather: weather(),
    paused: false,
  };
  if (overrides.container) base.container = overrides.container;
  return base;
}
