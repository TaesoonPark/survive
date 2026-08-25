import {
  Button,
  SIM_HZ,
  TICKS_PER_GAME_DAY,
  TICKS_PER_GAME_HOUR,
  Tile,
  createBody,
  pixelToTile,
  singlePlayerConfig,
  tileCenter,
  type AnimalState,
  type Command,
  type InputFrame,
  type ItemStack,
  type PlayerState,
  type SimEvent,
  type SimEventType,
  type SimEventOf,
  type SimulationConfig,
  type ZombieState,
} from '@survive/protocol';
import { createGameData, type GameData } from '@survive/game-data';
import type { WorldService } from '@survive/world';
import { createFlatWorld } from './flatWorld';
import {
  Simulation,
  addToInventory,
  bindInputSource,
  createDefaultSystems,
  createPlayerState,
  createStack,
  defaultEquipSlot,
  recomputeCarryWeight,
  spawnNode,
  spawnStructure,
  type SimContext,
  type System,
} from '@survive/simulation';

/**
 * The headless simulation harness.
 *
 * This is the tool most tests should reach for (spec section 34): build a world, step
 * it as many ticks as you like without waiting on real time, and assert on plain state.
 * No Phaser, no sockets, no disk.
 *
 * ```ts
 * const sim = createTestSimulation({ seed: 1234 });
 * const player = sim.addPlayer();
 * sim.advanceGameHours(6);
 * expect(player.thirst).toBeGreaterThan(0);
 * ```
 *
 * ONE LIMITATION WORTH KNOWING: this harness installs chunks and never evicts them,
 * because there is no server here to own the disk side of streaming. A test that walks a
 * player a long way therefore accumulates chunks - and their resource nodes - without
 * bound, and per-tick cost grows with them. That is a property of the harness, not of the
 * game: the real {@link import('@survive/server').GameServer} evicts behind the player and
 * holds a steady ~35 chunks. So do not read performance numbers off this harness; use
 * `tools/profile.ts`, which measures the shipping server.
 */

export interface TestSimulationOptions {
  seed?: number;
  /** Patch the default single-player config. */
  config?: (config: SimulationConfig) => void;
  /** Run a subset of systems. Defaults to the whole game. */
  systems?: System[];
  data?: GameData;
  world?: WorldService;
  /**
   * Flatten the terrain around the spawn to plain grass and clear resource nodes.
   * On by default: most mechanics tests want predictable ground under their feet.
   */
  flattenSpawn?: boolean;
  /** Radius, in tiles, of the flattened area. */
  flattenRadius?: number;
  /** Where players spawn. Defaults to the middle of the world. */
  spawn?: { x: number; y: number };
  /**
   * Wire the input system to the simulation's pending-input buffer. On by default,
   * because a test that calls `input()` or `hold()` almost always wants the frames
   * consumed. Set false to test the *unbound* case, where every player coasts.
   */
  bindInput?: boolean;
}

export interface TestSimulation {
  readonly sim: Simulation;
  readonly ctx: SimContext;
  readonly data: GameData;
  readonly world: WorldService;
  readonly config: SimulationConfig;
  /** Every event emitted since the harness was created. */
  readonly events: SimEvent[];
  /** Default spawn point. */
  readonly spawn: { x: number; y: number };

  /** Step the simulation, collecting events. Returns the events from these ticks. */
  step(ticks?: number): SimEvent[];
  /** Step for a number of in-game hours. */
  advanceGameHours(hours: number): SimEvent[];
  /** Step for a number of in-game days. */
  advanceGameDays(days: number): SimEvent[];
  /** Step for a number of real seconds' worth of ticks. */
  advanceSeconds(seconds: number): SimEvent[];

  addPlayer(options?: {
    id?: string;
    name?: string;
    x?: number;
    y?: number;
    withKit?: boolean;
  }): PlayerState;

  spawnZombie(defId?: string, x?: number, y?: number): ZombieState;
  spawnAnimal(defId?: string, x?: number, y?: number): AnimalState;

  /** Put items straight into a player's inventory. */
  giveItem(player: PlayerState, defId: string, count?: number): ItemStack;
  /** Equip an item, creating it if the player does not have one. */
  equip(player: PlayerState, defId: string): ItemStack;

  placeStructure(
    defId: string,
    tileX: number,
    tileY: number,
    rotation?: number,
    ownerId?: string,
  ): ReturnType<typeof spawnStructure>;
  placeNode(
    defId: string,
    tileX: number,
    tileY: number,
    variant?: number,
  ): ReturnType<typeof spawnNode>;

  /** Queue an input frame for a player. Sequence numbers are managed for you. */
  input(player: PlayerState, frame?: Partial<InputFrame>): InputFrame;
  /** Hold an input for several ticks, stepping as it goes. */
  hold(player: PlayerState, frame: Partial<InputFrame>, ticks: number): SimEvent[];
  /** Queue a command. */
  command(player: PlayerState, command: Command): void;
  /** Queue a command and step one tick so it is applied. */
  run(player: PlayerState, command: Command): SimEvent[];

  /** Every collected event of one type. */
  eventsOf<T extends SimEventType>(type: T): SimEventOf<T>[];
  /** The most recent collected event of one type. */
  lastEvent<T extends SimEventType>(type: T): SimEventOf<T> | undefined;
  /** Forget every collected event. Useful between phases of a test. */
  clearEvents(): void;

  /** Flatten terrain to grass and clear nodes in a radius, in tiles. */
  flatten(centerX: number, centerY: number, radiusTiles: number): void;
  /** Build a solid wall of terrain tiles, for line-of-sight and pathing tests. */
  wall(fromTileX: number, fromTileY: number, toTileX: number, toTileY: number): void;
}

export const DEFAULT_SEED = 20260824;

/** A walkable spawn near the world centre, found deterministically. */
export function findTestSpawn(world: WorldService, seed = DEFAULT_SEED): { x: number; y: number } {
  const centre = tileCenter(4096);
  let counter = seed >>> 0;
  const roll = () => {
    // Small deterministic LCG: the harness must not reach for Math.random either.
    counter = (Math.imul(counter, 1664525) + 1013904223) >>> 0;
    return counter / 0x100000000;
  };
  const found = world.findSpawnPosition(centre, centre, 2048, 12, roll, 512);
  return found ?? { x: centre, y: centre };
}

export function createTestSimulation(options: TestSimulationOptions = {}): TestSimulation {
  const seed = options.seed ?? DEFAULT_SEED;
  const config = singlePlayerConfig('test-world');
  config.world.seed = seed;
  // Tests drive time explicitly; an idle-pause would silently swallow their steps.
  config.mode.pauseWhenEmpty = false;
  options.config?.(config);

  const data = options.data ?? createGameData();
  // A flat plain by default: a mechanics test must not fail because the seed dropped a
  // boulder where it wanted to stand. Use `createGeneratedTestSimulation` to run the
  // same harness against real terrain.
  const world = options.world ?? createFlatWorld({ seed });

  const sim = new Simulation({
    config,
    data,
    world,
    systems: options.systems ?? createDefaultSystems(),
  });
  // Point the input system at the simulation's pending-input buffer, or `hold()` and
  // `input()` would queue frames nothing ever consumes.
  if (options.bindInput !== false) bindInputSource(sim);

  const spawn = options.spawn ?? findTestSpawn(world, seed);
  const events: SimEvent[] = [];
  sim.events.subscribe((event) => events.push(event));

  const inputSeq = new Map<string, number>();

  // Chunks are normally streamed in by the server. A headless simulation has no
  // server, so the harness installs the ones around spawn up front.
  primeChunks(sim, spawn.x, spawn.y, config.chunkLoadRadius + 1);

  const harness: TestSimulation = {
    sim,
    ctx: sim.context,
    data,
    world,
    config,
    events,
    spawn,

    step(ticks = 1) {
      const before = events.length;
      for (let i = 0; i < ticks; i++) {
        sim.step(1);
        // Fulfil chunk requests synchronously: no disk means nothing to await.
        const requested = sim.takeChunkRequests();
        for (const key of requested) installEmptyChunk(sim, key);
      }
      return events.slice(before);
    },

    advanceGameHours(hours) {
      return harness.step(Math.round(hours * TICKS_PER_GAME_HOUR));
    },

    advanceGameDays(days) {
      return harness.step(Math.round(days * TICKS_PER_GAME_DAY));
    },

    advanceSeconds(seconds) {
      return harness.step(Math.round(seconds * SIM_HZ));
    },

    addPlayer(playerOptions = {}) {
      const id = playerOptions.id ?? `p${Object.keys(sim.state.players).length + 1}`;
      const player = createPlayerState(data, config, {
        id,
        name: playerOptions.name ?? id,
        x: playerOptions.x ?? spawn.x,
        y: playerOptions.y ?? spawn.y,
        withoutKit: playerOptions.withKit !== true,
      });
      sim.addPlayer(player);
      inputSeq.set(id, 0);
      return player;
    },

    spawnZombie(defId = 'walker', x = spawn.x + 64, y = spawn.y) {
      const def = data.zombies.require(defId);
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
        nextThinkTick: sim.state.tick,
        loseInterestTick: 0,
        attackReadyTick: 0,
        staggerUntilTick: 0,
        homeChunk: `${Math.floor(x / 1024)},${Math.floor(y / 1024)}`,
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
    },

    spawnAnimal(defId = 'rabbit', x = spawn.x + 96, y = spawn.y) {
      const def = data.animals.require(defId);
      const animal: AnimalState = {
        id: sim.ids.animal(),
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
        nextThinkTick: sim.state.tick,
        fleeUntilTick: 0,
        attackReadyTick: 0,
        homeChunk: `${Math.floor(x / 1024)},${Math.floor(y / 1024)}`,
        homeX: x,
        homeY: y,
        wanderX: x,
        wanderY: y,
        rev: 1,
      };
      sim.state.animals[animal.id] = animal;
      return animal;
    },

    giveItem(player, defId, count = 1) {
      const stack = createStack(data, defId, count);
      const leftover = addToInventory(player.inventory, { ...stack }, data);
      if (leftover > 0) {
        throw new Error(
          `giveItem: only ${count - leftover} of ${count} ${defId} fitted in the inventory`,
        );
      }
      recomputeCarryWeight(player, data);
      player.rev++;
      return stack;
    },

    equip(player, defId) {
      const stack = createStack(data, defId, 1);
      const slot = defaultEquipSlot(data.items.require(defId));
      if (!slot) throw new Error(`equip: ${defId} is not equippable`);
      player.equipment[slot] = stack;
      recomputeCarryWeight(player, data);
      player.rev++;
      return stack;
    },

    placeStructure(defId, tileX, tileY, rotation = 0, ownerId) {
      return spawnStructure(sim.context, defId, tileX, tileY, rotation, ownerId);
    },

    placeNode(defId, tileX, tileY, variant = 0) {
      return spawnNode(sim.context, defId, tileX, tileY, variant);
    },

    input(player, partial = {}) {
      const seq = (inputSeq.get(player.id) ?? 0) + 1;
      inputSeq.set(player.id, seq);
      const frame: InputFrame = {
        seq,
        moveX: 0,
        moveY: 0,
        aimAngle: player.aimAngle,
        buttons: 0,
        ...partial,
      };
      sim.pushInput(player.id, [frame]);
      return frame;
    },

    hold(player, partial, ticks) {
      const before = events.length;
      for (let i = 0; i < ticks; i++) {
        harness.input(player, partial);
        harness.step(1);
      }
      return events.slice(before);
    },

    command(player, command) {
      sim.queueCommand(player.id, command);
    },

    run(player, command) {
      sim.queueCommand(player.id, command);
      return harness.step(1);
    },

    eventsOf<T extends SimEventType>(type: T) {
      return events.filter((event): event is SimEventOf<T> => event.type === type);
    },

    lastEvent<T extends SimEventType>(type: T) {
      for (let i = events.length - 1; i >= 0; i--) {
        const event = events[i];
        if (event?.type === type) return event as SimEventOf<T>;
      }
      return undefined;
    },

    clearEvents() {
      events.length = 0;
    },

    flatten(centerX, centerY, radiusTiles) {
      flattenArea(sim, world, centerX, centerY, radiusTiles);
    },

    wall(fromTileX, fromTileY, toTileX, toTileY) {
      const stepX = Math.sign(toTileX - fromTileX) || 1;
      const stepY = Math.sign(toTileY - fromTileY) || 1;
      for (let tileY = fromTileY; tileY !== toTileY + stepY; tileY += stepY) {
        for (let tileX = fromTileX; tileX !== toTileX + stepX; tileX += stepX) {
          world.setTile(tileX, tileY, Tile.WallConcrete);
        }
      }
    },
  };

  if (options.flattenSpawn !== false) {
    harness.flatten(spawn.x, spawn.y, options.flattenRadius ?? 24);
  }

  return harness;
}

/** Install empty dynamic chunks around a point so the simulation has ground to use. */
function primeChunks(sim: Simulation, x: number, y: number, radius: number): void {
  const cx = Math.floor(x / 1024);
  const cy = Math.floor(y / 1024);
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      installEmptyChunk(sim, `${cx + dx},${cy + dy}`);
    }
  }
}

function installEmptyChunk(sim: Simulation, key: string): void {
  if (sim.state.chunks[key]) return;
  const comma = key.indexOf(',');
  const cx = Number.parseInt(key.slice(0, comma), 10);
  const cy = Number.parseInt(key.slice(comma + 1), 10);
  if (!Number.isFinite(cx) || !Number.isFinite(cy)) return;
  sim.installChunk({
    key,
    cx,
    cy,
    version: 1,
    populated: false,
    overrides: [],
    structures: [],
    nodes: [],
    items: [],
    zombies: [],
    animals: [],
    nextSpawnTick: 0,
  });
}

/**
 * Turn an area into plain walkable grass and remove the resource nodes in it.
 *
 * Real terrain is the right thing to test against for world and AI behaviour, but a
 * combat or movement test should not fail because generation happened to drop a boulder
 * where the test wanted to stand.
 */
export function flattenArea(
  sim: Simulation,
  world: WorldService,
  centerX: number,
  centerY: number,
  radiusTiles: number,
): void {
  const centerTileX = pixelToTile(centerX);
  const centerTileY = pixelToTile(centerY);
  for (let dy = -radiusTiles; dy <= radiusTiles; dy++) {
    for (let dx = -radiusTiles; dx <= radiusTiles; dx++) {
      world.setTile(centerTileX + dx, centerTileY + dy, Tile.Grass);
    }
  }
  const reach = radiusTiles * 32;
  for (const node of Object.values(sim.state.nodes)) {
    if (Math.abs(node.x - centerX) > reach || Math.abs(node.y - centerY) > reach) continue;
    delete sim.state.nodes[node.id];
  }
}

/** Convenience: a fully pressed movement frame. */
export function moveFrame(
  seq: number,
  moveX: number,
  moveY: number,
  extra: Partial<InputFrame> = {},
): InputFrame {
  return { seq, moveX, moveY, aimAngle: Math.atan2(moveY, moveX), buttons: 0, ...extra };
}

/** Convenience: a frame with the primary attack held. */
export function attackFrame(seq: number, aimAngle: number): InputFrame {
  return { seq, moveX: 0, moveY: 0, aimAngle, buttons: Button.Primary };
}
