import { beforeEach, describe, expect, it } from 'vitest';
import {
  CHUNK_SIZE,
  TILE_SIZE,
  chunkKey,
  createBody,
  singlePlayerConfig,
  type PlayerState,
  type SimEvent,
  type SimulationConfig,
  type ZombieState,
} from '@survive/protocol';
import {
  Simulation,
  createPlayerState,
  ensureChunkRuntime,
  spawnStructure,
} from '@survive/simulation';
import { createMiniGameData, createStubWorld } from '@survive/simulation/core/testing';
import { AoiTracker } from './aoi';

function makeSim(config?: Partial<SimulationConfig>) {
  const base = singlePlayerConfig('aoi-test');
  const sim = new Simulation({
    config: { ...base, ...config },
    data: createMiniGameData(),
    world: createStubWorld(),
    systems: [],
  });
  return sim;
}

function addPlayer(sim: Simulation, id: string, x: number, y: number): PlayerState {
  const player = createPlayerState(sim.data, sim.config, {
    id,
    name: id,
    x,
    y,
    withoutKit: true,
  });
  sim.addPlayer(player);
  return player;
}

function addZombie(sim: Simulation, x: number, y: number): ZombieState {
  const def = sim.data.zombies.require('walker');
  const zombie: ZombieState = {
    id: sim.ids.zombie(),
    defId: def.id,
    x,
    y,
    vx: 0,
    vy: 0,
    facing: 0,
    health: def.maxHealth,
    maxHealth: def.maxHealth,
    ai: 'idle',
    lod: 0,
    nextThinkTick: 0,
    loseInterestTick: 0,
    attackReadyTick: 0,
    staggerUntilTick: 0,
    homeChunk: '0,0',
    homeX: x,
    homeY: y,
    body: createBody(def.bodyScale),
    crawling: false,
    path: [],
    pathIndex: 0,
    pathTick: 0,
    rev: 1,
  };
  sim.state.zombies[zombie.id] = zombie;
  return zombie;
}

describe('AoiTracker snapshots', () => {
  let sim: Simulation;
  let tracker: AoiTracker;

  beforeEach(() => {
    sim = makeSim();
    tracker = new AoiTracker({ radius: 400 });
  });

  it('returns null for a player who is not in the world', () => {
    expect(tracker.build(sim, 'ghost', 0)).toBeNull();
  });

  it('always produces a snapshot for a connected player, even an empty world', () => {
    const player = addPlayer(sim, 'p1', 1000, 1000);
    sim.step();
    const snapshot = tracker.build(sim, 'p1', 12345);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.tick).toBe(sim.state.tick);
    expect(snapshot!.serverTimeMs).toBe(12345);
    expect(snapshot!.self.id).toBe(player.id);
    expect(snapshot!.entities).toEqual([]);
    expect(snapshot!.removed).toEqual([]);
  });

  it('echoes the last consumed input sequence for reconciliation', () => {
    const player = addPlayer(sim, 'p1', 1000, 1000);
    player.lastInputSeq = 183;
    sim.step();
    expect(tracker.build(sim, 'p1', 0)!.ackSeq).toBe(183);
  });

  it('includes nearby entities and excludes distant ones', () => {
    addPlayer(sim, 'p1', 1000, 1000);
    const near = addZombie(sim, 1100, 1000);
    const far = addZombie(sim, 4000, 1000);
    sim.step();
    const snapshot = tracker.build(sim, 'p1', 0)!;
    const ids = snapshot.entities.map((entity) => entity.id);
    expect(ids).toContain(near.id);
    expect(ids).not.toContain(far.id);
  });

  it('never includes the receiving player in the entity list', () => {
    addPlayer(sim, 'p1', 1000, 1000);
    sim.step();
    const snapshot = tracker.build(sim, 'p1', 0)!;
    expect(snapshot.entities.some((entity) => entity.id === 'p1')).toBe(false);
    expect(snapshot.self.id).toBe('p1');
  });

  it('excludes entities that are inside the query cell but outside the exact radius', () => {
    addPlayer(sim, 'p1', 1000, 1000);
    // Just past the 400px radius, but likely inside the same coarse spatial cells.
    const outside = addZombie(sim, 1000 + 420, 1000);
    sim.step();
    const snapshot = tracker.build(sim, 'p1', 0)!;
    expect(snapshot.entities.map((e) => e.id)).not.toContain(outside.id);
  });

  it('sends an entity once and then stays quiet until it changes', () => {
    addPlayer(sim, 'p1', 1000, 1000);
    const zombie = addZombie(sim, 1050, 1000);
    sim.step();
    expect(tracker.build(sim, 'p1', 0)!.entities).toHaveLength(1);

    sim.step();
    expect(tracker.build(sim, 'p1', 0)!.entities).toHaveLength(0);

    zombie.x += 5;
    zombie.rev++;
    sim.step();
    const third = tracker.build(sim, 'p1', 0)!;
    expect(third.entities).toHaveLength(1);
    expect(third.entities[0]).toMatchObject({ id: zombie.id, x: 1055 });
  });

  it('removes an entity that leaves the area of interest', () => {
    addPlayer(sim, 'p1', 1000, 1000);
    const zombie = addZombie(sim, 1050, 1000);
    sim.step();
    tracker.build(sim, 'p1', 0);

    zombie.x = 5000;
    sim.step();
    const snapshot = tracker.build(sim, 'p1', 0)!;
    expect(snapshot.removed).toEqual([zombie.id]);

    // And is not repeatedly announced as removed.
    sim.step();
    expect(tracker.build(sim, 'p1', 0)!.removed).toEqual([]);
  });

  it('removes an entity that was destroyed', () => {
    addPlayer(sim, 'p1', 1000, 1000);
    const zombie = addZombie(sim, 1050, 1000);
    sim.step();
    tracker.build(sim, 'p1', 0);

    delete sim.state.zombies[zombie.id];
    sim.step();
    expect(tracker.build(sim, 'p1', 0)!.removed).toEqual([zombie.id]);
  });

  it('re-sends an entity that comes back into range', () => {
    addPlayer(sim, 'p1', 1000, 1000);
    const zombie = addZombie(sim, 1050, 1000);
    sim.step();
    tracker.build(sim, 'p1', 0);
    zombie.x = 5000;
    sim.step();
    tracker.build(sim, 'p1', 0);

    zombie.x = 1050;
    sim.step();
    const snapshot = tracker.build(sim, 'p1', 0)!;
    expect(snapshot.entities.map((e) => e.id)).toContain(zombie.id);
  });

  it('reduces remote players to what a renderer needs', () => {
    addPlayer(sim, 'p1', 1000, 1000);
    const other = addPlayer(sim, 'p2', 1080, 1000);
    other.inventory.slots[0] = { defId: 'wood', count: 5 };
    sim.step();
    const snapshot = tracker.build(sim, 'p1', 0)!;
    const view = snapshot.entities.find((entity) => entity.id === 'p2');
    expect(view).toBeDefined();
    expect(view).toMatchObject({ k: 'player', name: 'p2', health: other.health });
    // No inventory, no skills, no body detail leaks to other players.
    expect(view).not.toHaveProperty('inventory');
    expect(view).not.toHaveProperty('skills');
    expect(view).not.toHaveProperty('body');
  });

  it('advertises the equipment a remote player is wearing so it can be drawn', () => {
    addPlayer(sim, 'p1', 1000, 1000);
    const other = addPlayer(sim, 'p2', 1080, 1000);
    other.equipment.mainHand = { defId: 'club', count: 1 };
    other.equipment.chest = { defId: 'vest', count: 1 };
    other.rev++;
    sim.step();
    const view = tracker.build(sim, 'p1', 0)!.entities.find((entity) => entity.id === 'p2');
    expect(view).toMatchObject({ heldDefId: 'club', chestDefId: 'vest' });
  });

  it("never ships a door lock code or a chest's contents to a bystander", () => {
    // A lock is only a lock if the code is a secret. `canUnlock` admits anyone who sends a
    // code equal to `door.code`, so a code in the snapshot means a modified client walks
    // up to someone else's door, reads it out of its own state and opens it. Contents have
    // their own gated channel (the container view, asserted in the test below) and must not
    // also ride along in the entity stream.
    addPlayer(sim, 'p1', 1000, 1000);
    const owner = addPlayer(sim, 'p2', 1010, 1000);
    const tileX = Math.floor(1040 / TILE_SIZE);
    const tileY = Math.floor(1000 / TILE_SIZE);

    const door = spawnStructure(sim.context, 'test_door', tileX, tileY, 0, owner.id)!;
    door.door = { open: false, locked: true, code: 'hunter2' };
    const box = spawnStructure(sim.context, 'test_box', tileX, tileY + 1, 0, owner.id)!;
    box.container!.slots[0] = { defId: 'club', count: 3 };
    sim.step();

    const entities = tracker.build(sim, 'p1', 0)!.entities;
    const doorView = entities.find((entity) => entity.id === door.id) as
      { door?: { open: boolean; locked: boolean; code?: string } } | undefined;
    expect(doorView?.door).toBeDefined();
    expect(doorView?.door?.code).toBeUndefined();
    // Still enough to draw it and label the prompt.
    expect(doorView?.door?.open).toBe(false);
    expect(doorView?.door?.locked).toBe(true);

    const boxView = entities.find((entity) => entity.id === box.id) as
      { container?: { slots: unknown[]; capacity: number; viewers: unknown[] } } | undefined;
    expect(boxView?.container).toBeDefined();
    expect(boxView?.container?.slots).toEqual([]);
    expect(boxView?.container?.viewers).toEqual([]);
    // Capacity is not a secret and the client sizes its window with it.
    expect(boxView?.container?.capacity).toBeGreaterThan(0);

    // The server still holds the truth.
    expect(sim.state.structures[door.id]?.door?.code).toBe('hunter2');
    expect(sim.state.structures[box.id]?.container?.slots[0]).toMatchObject({ defId: 'club' });
  });

  it('ships structures whole, including their sub-state', () => {
    addPlayer(sim, 'p1', 1000, 1000);
    const tileX = Math.floor(1040 / TILE_SIZE);
    const tileY = Math.floor(1000 / TILE_SIZE);
    const box = spawnStructure(sim.context, 'test_box', tileX, tileY, 0, 'p1');
    expect(box).not.toBeNull();
    sim.step();
    const snapshot = tracker.build(sim, 'p1', 0)!;
    const view = snapshot.entities.find((entity) => entity.id === box!.id);
    expect(view).toBeDefined();
    expect(view).toMatchObject({ k: 'structure', defId: 'test_box' });
    expect((view as { container?: unknown }).container).toBeDefined();
  });

  it('includes the open container view only while a container is open', () => {
    const player = addPlayer(sim, 'p1', 1000, 1000);
    const box = spawnStructure(sim.context, 'test_box', 32, 31, 0, 'p1')!;
    sim.step();
    expect(tracker.build(sim, 'p1', 0)!.container).toBeUndefined();

    player.openContainerId = box.id;
    sim.step();
    const snapshot = tracker.build(sim, 'p1', 0)!;
    expect(snapshot.container).toMatchObject({ structureId: box.id, capacity: 12 });
  });

  it('carries the world clock, weather and pause flag', () => {
    addPlayer(sim, 'p1', 1000, 1000);
    sim.state.weather.type = 'storm';
    sim.state.time.hour = 3;
    sim.step();
    const snapshot = tracker.build(sim, 'p1', 0)!;
    expect(snapshot.weather.type).toBe('storm');
    expect(snapshot.time.hour).toBe(3);
    expect(snapshot.paused).toBe(false);
  });

  it('gives two players independent views of the same world', () => {
    addPlayer(sim, 'p1', 1000, 1000);
    addPlayer(sim, 'p2', 6000, 6000);
    const nearP1 = addZombie(sim, 1050, 1000);
    const nearP2 = addZombie(sim, 6050, 6000);
    sim.step();

    const a = tracker.build(sim, 'p1', 0)!;
    const b = tracker.build(sim, 'p2', 0)!;
    expect(a.entities.map((e) => e.id)).toContain(nearP1.id);
    expect(a.entities.map((e) => e.id)).not.toContain(nearP2.id);
    expect(b.entities.map((e) => e.id)).toContain(nearP2.id);
    expect(b.entities.map((e) => e.id)).not.toContain(nearP1.id);
  });

  it('reset makes the next snapshot a full resend', () => {
    addPlayer(sim, 'p1', 1000, 1000);
    addZombie(sim, 1050, 1000);
    sim.step();
    expect(tracker.build(sim, 'p1', 0)!.entities).toHaveLength(1);
    sim.step();
    expect(tracker.build(sim, 'p1', 0)!.entities).toHaveLength(0);

    tracker.reset('p1');
    sim.step();
    expect(tracker.build(sim, 'p1', 0)!.entities).toHaveLength(1);
  });

  it('forget drops the client record entirely', () => {
    addPlayer(sim, 'p1', 1000, 1000);
    sim.step();
    tracker.build(sim, 'p1', 0);
    expect(tracker.size).toBe(1);
    tracker.forget('p1');
    expect(tracker.size).toBe(0);
    expect(tracker.stats('p1').knownEntities).toBe(0);
  });
});

describe('AoiTracker chunk streaming', () => {
  let sim: Simulation;
  let tracker: AoiTracker;

  beforeEach(() => {
    sim = makeSim();
    tracker = new AoiTracker({ radius: 400, chunkRadius: 1 });
  });

  it('offers only chunks the simulation has loaded', () => {
    addPlayer(sim, 'p1', CHUNK_SIZE * 3 + 100, CHUNK_SIZE * 3 + 100);
    expect(tracker.chunkDelta(sim, 'p1').send).toEqual([]);

    ensureChunkRuntime(sim.state, 3, 3);
    const delta = tracker.chunkDelta(sim, 'p1');
    expect(delta.send).toEqual([chunkKey(3, 3)]);
  });

  it('stops offering a chunk once it has been sent', () => {
    addPlayer(sim, 'p1', CHUNK_SIZE * 3 + 100, CHUNK_SIZE * 3 + 100);
    ensureChunkRuntime(sim.state, 3, 3);
    const key = chunkKey(3, 3);
    tracker.markChunkSent('p1', key);
    expect(tracker.chunkDelta(sim, 'p1').send).toEqual([]);
    expect(tracker.hasChunk('p1', key)).toBe(true);
  });

  it('asks the client to drop chunks it has walked away from', () => {
    const player = addPlayer(sim, 'p1', CHUNK_SIZE * 3 + 100, CHUNK_SIZE * 3 + 100);
    ensureChunkRuntime(sim.state, 3, 3);
    tracker.markChunkSent('p1', chunkKey(3, 3));

    player.x = CHUNK_SIZE * 20 + 100;
    player.y = CHUNK_SIZE * 20 + 100;
    const delta = tracker.chunkDelta(sim, 'p1');
    expect(delta.drop).toEqual([chunkKey(3, 3)]);

    tracker.markChunkDropped('p1', chunkKey(3, 3));
    expect(tracker.hasChunk('p1', chunkKey(3, 3))).toBe(false);
  });

  it('returns an empty delta for an unknown player', () => {
    expect(tracker.chunkDelta(sim, 'nobody')).toEqual({ send: [], drop: [] });
  });
});

describe('AoiTracker event filtering', () => {
  let sim: Simulation;
  let tracker: AoiTracker;

  beforeEach(() => {
    sim = makeSim();
    tracker = new AoiTracker({ radius: 400 });
  });

  it('passes through events with no position, such as the day rolling over', () => {
    const player = addPlayer(sim, 'p1', 1000, 1000);
    const events: SimEvent[] = [{ type: 'dayPassed', day: 2, season: 'spring', year: 1 }];
    expect(tracker.filterEvents(events, player)).toHaveLength(1);
  });

  it('gates positioned events on distance, with slack for audio', () => {
    const player = addPlayer(sim, 'p1', 1000, 1000);
    const near: SimEvent = {
      type: 'nodeDepleted',
      nodeId: 'n1',
      defId: 'test_tree',
      x: 1100,
      y: 1000,
    };
    const far: SimEvent = {
      type: 'nodeDepleted',
      nodeId: 'n2',
      defId: 'test_tree',
      x: 9000,
      y: 1000,
    };
    const filtered = tracker.filterEvents([near, far], player);
    expect(filtered).toEqual([near]);
  });

  it('lets sound carry further than sight', () => {
    const player = addPlayer(sim, 'p1', 1000, 1000);
    const event: SimEvent = { type: 'lightning', x: 1000 + 500, y: 1000 };
    // Outside the 400px replication radius, inside the audio slack.
    expect(tracker.filterEvents([event], player)).toHaveLength(1);
    expect(tracker.filterEvents([event], player, 1)).toHaveLength(0);
  });

  it('routes private feedback only to the player it concerns', () => {
    const player = addPlayer(sim, 'p1', 1000, 1000);
    const other = addPlayer(sim, 'p2', 1010, 1000);
    const events: SimEvent[] = [
      {
        type: 'craftCompleted',
        playerId: 'p1',
        recipeId: 'test_axe',
        output: { defId: 'axe', count: 1 },
      },
      {
        type: 'notification',
        playerId: 'p2',
        severity: 'info',
        message: { code: 'notify.forP2Only' },
      },
    ];
    expect(tracker.filterEvents(events, player)).toHaveLength(1);
    expect(tracker.filterEvents(events, player)[0]!.type).toBe('craftCompleted');
    expect(tracker.filterEvents(events, other)).toHaveLength(1);
    expect(tracker.filterEvents(events, other)[0]!.type).toBe('notification');
  });

  it('returns an empty list for an empty tick without allocating', () => {
    const player = addPlayer(sim, 'p1', 1000, 1000);
    expect(tracker.filterEvents([], player)).toEqual([]);
  });
});
