import {
  CHUNK_SIZE,
  CHUNK_TILES,
  MAX_PENDING_INPUTS,
  TILE_SIZE,
  Rng,
  SimulationClock,
  chunkKey,
  createRngState,
  parseChunkKey,
  tileToChunk,
  type ChunkDynamicPayload,
  type ChunkKey,
  type Command,
  type CommandType,
  type InputFrame,
  type PlayerId,
  type PlayerState,
  type SimEvent,
  type ChunkRuntimeState,
  type SimulationConfig,
  type WorldMetaPayload,
  createEmptyChunkPayload,
  SAVE_FORMAT_VERSION,
} from '@survive/protocol';
import type { GameData } from '@survive/game-data';
import type { WorldService } from '@survive/world';
import {
  SystemOrder,
  type CommandHandler,
  type CommandRouter,
  type CurrentInputs,
  type SimContext,
  type System,
} from './core/context';
import { TickEventSink } from './core/events';
import { IdAllocator } from './core/ids';
import { createConsoleLogger, nullLogger, type Logger } from './core/logger';
import { SpatialIndex } from './core/spatial';
import { createEmptyState, type SimulationState } from './core/state';
import { ensureChunkRuntime } from './core/queries';
import { attachNode, attachStructure, detachNode, detachStructure } from './core/structures';
import { structureTiles } from './core/queries';

export interface SimulationOptions {
  config: SimulationConfig;
  data: GameData;
  world: WorldService;
  logger?: Logger;
  /** Systems to run. Defaults to the full game via `createDefaultSystems()`. */
  systems?: System[];
  /** Resume an existing world instead of starting a fresh one. */
  state?: SimulationState;
}

/** Per-player buffer of unconsumed input frames. */
interface PlayerInputBuffer {
  frames: InputFrame[];
  lastSeq: number;
}

class InputTracker implements CurrentInputs {
  private currentFrames = new Map<PlayerId, InputFrame>();
  private previousFrames = new Map<PlayerId, InputFrame>();

  get(playerId: PlayerId): InputFrame | undefined {
    return this.currentFrames.get(playerId);
  }

  set(playerId: PlayerId, frame: InputFrame): void {
    this.currentFrames.set(playerId, frame);
  }

  previous(playerId: PlayerId): InputFrame | undefined {
    return this.previousFrames.get(playerId);
  }

  /** Roll current into previous at the start of a tick. */
  rotate(): void {
    this.previousFrames = this.currentFrames;
    this.currentFrames = new Map();
  }

  clear(): void {
    this.currentFrames.clear();
    this.previousFrames.clear();
  }

  remove(playerId: PlayerId): void {
    this.currentFrames.delete(playerId);
    this.previousFrames.delete(playerId);
  }
}

/**
 * The authoritative game simulation.
 *
 * One instance owns one world. It is fully headless and deterministic: given the same
 * seed, the same saved state and the same sequence of inputs and commands, it produces
 * identical state (spec sections 27, 28 and 34). The server wraps it with networking
 * and disk I/O; tests drive it directly.
 */
export class Simulation {
  readonly state: SimulationState;
  readonly clock: SimulationClock;
  readonly rng: Rng;
  readonly events = new TickEventSink();
  readonly ids: IdAllocator;
  readonly spatial = new SpatialIndex();
  readonly data: GameData;
  readonly world: WorldService;
  readonly config: SimulationConfig;
  readonly log: Logger;

  private readonly systems: System[];
  private readonly handlers = new Map<CommandType, CommandHandler<CommandType>[]>();
  private readonly commandQueue: Array<{ playerId: PlayerId; command: Command }> = [];
  private readonly inputBuffers = new Map<PlayerId, PlayerInputBuffer>();
  private readonly inputTracker = new InputTracker();
  private readonly ctx: SimContext;
  private initialised = false;

  constructor(options: SimulationOptions) {
    this.config = options.config;
    this.data = options.data;
    this.world = options.world;
    this.log = options.logger ?? nullLogger;

    this.state =
      options.state ??
      createEmptyState(options.config.world.seed, createRngState(options.config.world.seed));
    this.clock = new SimulationClock(this.state.tick);
    this.rng = new Rng(this.state.rng);
    this.ids = new IdAllocator(this.state);

    this.ctx = {
      state: this.state,
      clock: this.clock,
      rng: this.rng,
      data: this.data,
      world: this.world,
      config: this.config,
      events: this.events,
      ids: this.ids,
      log: this.log,
      spatial: this.spatial,
      inputs: this.inputTracker,
    };

    this.systems = [...(options.systems ?? [])].sort((a, b) => a.order - b.order);
    this.init();
  }

  /** Read-only view of the systems that are running, in execution order. */
  get systemIds(): string[] {
    return this.systems.map((system) => system.id);
  }

  private init(): void {
    if (this.initialised) return;
    const router: CommandRouter = {
      on: <T extends CommandType>(type: T, handler: CommandHandler<T>) => {
        let list = this.handlers.get(type);
        if (!list) {
          list = [];
          this.handlers.set(type, list);
        }
        list.push(handler as unknown as CommandHandler<CommandType>);
      },
    };
    for (const system of this.systems) system.init?.(this.ctx, router);
    this.initialised = true;
  }

  // -------------------------------------------------------------------------
  // Stepping
  // -------------------------------------------------------------------------

  /**
   * Advance the simulation by `ticks` fixed steps.
   *
   * A paused simulation still drains commands so that unpausing is not a flood, but
   * runs no systems and does not advance the clock.
   */
  step(ticks = 1): number {
    let stepped = 0;
    for (let i = 0; i < ticks; i++) {
      if (this.state.paused) break;
      this.stepOnce();
      stepped++;
    }
    return stepped;
  }

  private stepOnce(): void {
    // Per-tick transients are cleared *before* the tick so the host can read them
    // after `step()` returns.
    this.state.destroyed.length = 0;
    this.state.weather.lightning = false;
    this.inputTracker.rotate();

    this.clock.advance(1);
    this.state.tick = this.clock.tick;
    this.state.time.tick = this.clock.tick;

    this.rebuildSpatialIndex();
    this.dispatchCommands();

    for (const system of this.systems) system.update?.(this.ctx);

    this.state.steppedTicks++;
    this.state.rng = this.rng.getState();
  }

  private rebuildSpatialIndex(): void {
    const index = this.spatial;
    index.clear();
    for (const player of Object.values(this.state.players)) {
      if (!player.alive) continue;
      index.add(player.id, 'player', player.x, player.y, 12);
    }
    for (const zombie of Object.values(this.state.zombies)) {
      const def = this.data.zombies.get(zombie.defId);
      index.add(zombie.id, 'zombie', zombie.x, zombie.y, def?.radius ?? 12);
    }
    for (const animal of Object.values(this.state.animals)) {
      const def = this.data.animals.get(animal.defId);
      index.add(animal.id, 'animal', animal.x, animal.y, def?.radius ?? 10);
    }
    for (const item of Object.values(this.state.items)) {
      index.add(item.id, 'item', item.x, item.y, 8);
    }
    for (const node of Object.values(this.state.nodes)) {
      if (node.depleted) continue;
      const def = this.data.nodes.get(node.defId);
      index.add(node.id, 'node', node.x, node.y, def?.radius ?? 12);
    }
    for (const structure of Object.values(this.state.structures)) {
      const def = this.data.structures.get(structure.defId);
      // Structures are indexed by the centre of their footprint so a wide building
      // is not missed by a query that clips its edge.
      const swapped = structure.rotation % 2 === 1;
      const w = (swapped ? def?.height : def?.width) ?? 1;
      const h = (swapped ? def?.width : def?.height) ?? 1;
      index.add(
        structure.id,
        'structure',
        structure.tileX * TILE_SIZE + (w * TILE_SIZE) / 2,
        structure.tileY * TILE_SIZE + (h * TILE_SIZE) / 2,
        (Math.max(w, h) * TILE_SIZE) / 2,
      );
    }
    for (const projectile of Object.values(this.state.projectiles)) {
      index.add(projectile.id, 'projectile', projectile.x, projectile.y, 4);
    }
  }

  /**
   * Route queued commands to their handlers.
   *
   * Runs before the systems so that a command issued this tick takes effect this
   * tick, matching what the player saw when they pressed the key.
   */
  private dispatchCommands(): void {
    if (this.commandQueue.length === 0) return;
    const queue = this.commandQueue.splice(0, this.commandQueue.length);
    for (const entry of queue) {
      const player = this.state.players[entry.playerId];
      if (!player) continue;
      const handlers = this.handlers.get(entry.command.type);
      if (!handlers || handlers.length === 0) {
        this.log.debug('unhandled command', { type: entry.command.type });
        continue;
      }
      for (const handler of handlers) {
        try {
          handler(this.ctx, player, entry.command as never);
        } catch (error) {
          this.log.error('command handler threw', {
            type: entry.command.type,
            playerId: entry.playerId,
            error: String(error),
          });
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Input and commands
  // -------------------------------------------------------------------------

  /** Accept input frames from a client. Out-of-order and duplicate frames are dropped. */
  pushInput(playerId: PlayerId, frames: readonly InputFrame[]): void {
    let buffer = this.inputBuffers.get(playerId);
    if (!buffer) {
      buffer = { frames: [], lastSeq: -1 };
      this.inputBuffers.set(playerId, buffer);
    }
    for (const frame of frames) {
      if (frame.seq <= buffer.lastSeq) continue;
      buffer.frames.push(frame);
    }
    buffer.frames.sort((a, b) => a.seq - b.seq);
    if (buffer.frames.length > MAX_PENDING_INPUTS) {
      // A client that floods us loses its oldest frames rather than growing the queue
      // without bound.
      buffer.frames.splice(0, buffer.frames.length - MAX_PENDING_INPUTS);
    }
  }

  /**
   * Take the next input frame for a player. Called once per tick by the input system.
   * Returns undefined when the client has starved us, in which case the player coasts.
   */
  takeInput(playerId: PlayerId): InputFrame | undefined {
    const buffer = this.inputBuffers.get(playerId);
    if (!buffer || buffer.frames.length === 0) return undefined;
    const frame = buffer.frames.shift();
    if (frame) buffer.lastSeq = frame.seq;
    return frame;
  }

  pendingInputCount(playerId: PlayerId): number {
    return this.inputBuffers.get(playerId)?.frames.length ?? 0;
  }

  /** Queue a discrete command. Applied at the start of the next step. */
  queueCommand(playerId: PlayerId, command: Command): void {
    this.commandQueue.push({ playerId, command });
  }

  /** Number of commands waiting to be dispatched. */
  get queuedCommandCount(): number {
    return this.commandQueue.length;
  }

  // -------------------------------------------------------------------------
  // Players
  // -------------------------------------------------------------------------

  /** Install a player (fresh or loaded from disk) into the world. */
  addPlayer(player: PlayerState): PlayerState {
    this.state.players[player.id] = player;
    this.inputBuffers.set(player.id, { frames: [], lastSeq: -1 });
    for (const system of this.systems) system.onPlayerJoin?.(this.ctx, player);
    this.events.emit({ type: 'playerJoined', playerId: player.id, name: player.name });
    return player;
  }

  /** Remove a player from the world and hand their state back for saving. */
  removePlayer(playerId: PlayerId): PlayerState | undefined {
    const player = this.state.players[playerId];
    if (!player) return undefined;
    for (const system of this.systems) system.onPlayerLeave?.(this.ctx, player);
    this.events.emit({ type: 'playerLeft', playerId: player.id, name: player.name });
    delete this.state.players[playerId];
    this.inputBuffers.delete(playerId);
    this.inputTracker.remove(playerId);
    return player;
  }

  getPlayer(playerId: PlayerId): PlayerState | undefined {
    return this.state.players[playerId];
  }

  // -------------------------------------------------------------------------
  // Pausing
  // -------------------------------------------------------------------------

  /**
   * Pause or resume. Only honoured when the server config allows it, which is how a
   * single-player ESC menu stops the world without giving a multiplayer client the
   * same power (spec section 12).
   */
  setPaused(paused: boolean, force = false): boolean {
    if (!force && paused && !this.config.mode.pauseWhenClientPaused) return false;
    this.state.paused = paused;
    return true;
  }

  get paused(): boolean {
    return this.state.paused;
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  /** Take every event emitted since the last drain. */
  drainEvents(): SimEvent[] {
    return this.events.drain();
  }

  // -------------------------------------------------------------------------
  // Chunk streaming
  // -------------------------------------------------------------------------

  /** Chunk keys the simulation wants dynamic data for. Clears the request list. */
  takeChunkRequests(): ChunkKey[] {
    if (this.state.pendingChunkLoads.length === 0) return [];
    return this.state.pendingChunkLoads.splice(0, this.state.pendingChunkLoads.length);
  }

  /**
   * Install a chunk's dynamic layer, loaded from disk or freshly created.
   *
   * Terrain itself is regenerated from the seed by the world service, never loaded.
   */
  installChunk(payload: ChunkDynamicPayload): void {
    const { cx, cy } = payload;
    this.world.ensureChunk(cx, cy);
    this.world.applyOverrides(cx, cy, payload.overrides);

    const runtime = ensureChunkRuntime(this.state, cx, cy);
    runtime.populated = payload.populated;
    runtime.nextSpawnTick = payload.nextSpawnTick;
    runtime.lastTouchedTick = this.state.tick;
    runtime.lastSimulatedTick = this.state.tick;
    runtime.dirty = false;

    for (const structure of payload.structures) {
      this.state.structures[structure.id] = structure;
      attachStructure(this.ctx, structure);
      this.state.nextId = Math.max(this.state.nextId, numericSuffix(structure.id) + 1);
    }
    for (const node of payload.nodes) {
      this.state.nodes[node.id] = node;
      attachNode(this.ctx, node);
      this.state.nextId = Math.max(this.state.nextId, numericSuffix(node.id) + 1);
    }
    for (const item of payload.items) {
      this.state.items[item.id] = item;
      this.state.nextId = Math.max(this.state.nextId, numericSuffix(item.id) + 1);
    }
    for (const zombie of payload.zombies) {
      this.state.zombies[zombie.id] = zombie;
      this.state.nextId = Math.max(this.state.nextId, numericSuffix(zombie.id) + 1);
    }
    for (const animal of payload.animals) {
      this.state.animals[animal.id] = animal;
      this.state.nextId = Math.max(this.state.nextId, numericSuffix(animal.id) + 1);
    }

    this.reattachOverlappingStructures(cx, cy);

    for (const system of this.systems) system.onChunkLoaded?.(this.ctx, runtime.key);
  }

  /**
   * Re-apply collision for structures that reach into this chunk from outside it.
   *
   * A structure belongs to the chunk holding its origin tile, and that is the chunk whose
   * payload carries it. A multi-tile piece straddling a boundary therefore has half its
   * footprint in a chunk that knows nothing about it - and evicting *that* chunk drops the
   * collision for those tiles while the structure record, living elsewhere, survives
   * untouched. Nothing put the bits back on reload, so the far half of any gate, fence or
   * stairway across a boundary became permanently walk-through: a base wall a player opens
   * simply by walking away far enough to evict the neighbour and coming back.
   *
   * Bounded by the number of resident structures, and only on a chunk install.
   */
  private reattachOverlappingStructures(cx: number, cy: number): void {
    for (const structure of Object.values(this.state.structures)) {
      const def = this.data.structures.get(structure.defId);
      if (!def) continue;
      if (def.width <= 1 && def.height <= 1) continue;
      // Its own chunk installed it a moment ago; only the neighbours are at risk.
      if (tileToChunk(structure.tileX) === cx && tileToChunk(structure.tileY) === cy) continue;
      const reaches = structureTiles(
        structure.tileX,
        structure.tileY,
        def.width,
        def.height,
        structure.rotation,
      ).some((tile) => tileToChunk(tile.tileX) === cx && tileToChunk(tile.tileY) === cy);
      if (reaches) attachStructure(this.ctx, structure);
    }
  }

  /** Collect a chunk's dynamic layer for saving, without unloading it. */
  serializeChunk(key: ChunkKey): ChunkDynamicPayload | undefined {
    const runtime = this.state.chunks[key];
    if (!runtime) return undefined;
    const payload = createEmptyChunkPayload(key, runtime.cx, runtime.cy);
    payload.populated = runtime.populated;
    payload.nextSpawnTick = runtime.nextSpawnTick;
    payload.overrides = this.world.getOverrides(runtime.cx, runtime.cy);

    const inChunk = (x: number, y: number) =>
      Math.floor(x / 1024) === runtime.cx && Math.floor(y / 1024) === runtime.cy;

    for (const structure of Object.values(this.state.structures)) {
      if (
        Math.floor(structure.tileX / 32) === runtime.cx &&
        Math.floor(structure.tileY / 32) === runtime.cy
      ) {
        payload.structures.push(structure);
      }
    }
    for (const node of Object.values(this.state.nodes)) {
      if (
        Math.floor(node.tileX / 32) === runtime.cx &&
        Math.floor(node.tileY / 32) === runtime.cy
      ) {
        payload.nodes.push(node);
      }
    }
    for (const item of Object.values(this.state.items)) {
      if (inChunk(item.x, item.y)) payload.items.push(item);
    }
    for (const zombie of Object.values(this.state.zombies)) {
      if (inChunk(zombie.x, zombie.y)) payload.zombies.push(zombie);
    }
    for (const animal of Object.values(this.state.animals)) {
      if (inChunk(animal.x, animal.y)) payload.animals.push(animal);
    }
    return payload;
  }

  /** Every chunk marked dirty, ready to be written. Clears the dirty flags. */
  collectDirtyChunks(): ChunkDynamicPayload[] {
    const dirty: ChunkRuntimeState[] = [];
    for (const runtime of Object.values(this.state.chunks)) {
      if (runtime.dirty) dirty.push(runtime);
    }
    if (dirty.length === 0) return [];

    for (const runtime of dirty) runtime.dirty = false;
    return this.serializeChunks(dirty);
  }

  /**
   * Serialize several chunks in one pass over the entity tables.
   *
   * {@link serializeChunk} scans every structure, node, item, zombie and animal to find
   * the ones inside a single chunk, so calling it once per chunk is O(chunks x entities).
   * Both callers hit that at the worst possible moment: autosave marks nearly every loaded
   * chunk dirty, and a sprinting player evicts a whole column at once. With a few thousand
   * resource nodes loaded that measured as 60ms+ on a single tick, against a 50ms budget.
   * Bucketing entities by their chunk first makes it O(entities + chunks).
   */
  private serializeChunks(runtimes: readonly ChunkRuntimeState[]): ChunkDynamicPayload[] {
    if (runtimes.length === 0) return [];
    const payloads = new Map<ChunkKey, ChunkDynamicPayload>();
    for (const runtime of runtimes) {
      const payload = createEmptyChunkPayload(runtime.key, runtime.cx, runtime.cy);
      payload.populated = runtime.populated;
      payload.nextSpawnTick = runtime.nextSpawnTick;
      payload.overrides = this.world.getOverrides(runtime.cx, runtime.cy);
      payloads.set(runtime.key, payload);
    }

    const bucketAt = (x: number, y: number): ChunkDynamicPayload | undefined =>
      payloads.get(chunkKey(Math.floor(x / CHUNK_SIZE), Math.floor(y / CHUNK_SIZE)));
    const bucketAtTile = (tileX: number, tileY: number): ChunkDynamicPayload | undefined =>
      payloads.get(chunkKey(Math.floor(tileX / CHUNK_TILES), Math.floor(tileY / CHUNK_TILES)));

    for (const structure of Object.values(this.state.structures)) {
      bucketAtTile(structure.tileX, structure.tileY)?.structures.push(structure);
    }
    for (const node of Object.values(this.state.nodes)) {
      bucketAtTile(node.tileX, node.tileY)?.nodes.push(node);
    }
    for (const item of Object.values(this.state.items)) {
      bucketAt(item.x, item.y)?.items.push(item);
    }
    for (const zombie of Object.values(this.state.zombies)) {
      bucketAt(zombie.x, zombie.y)?.zombies.push(zombie);
    }
    for (const animal of Object.values(this.state.animals)) {
      bucketAt(animal.x, animal.y)?.animals.push(animal);
    }

    return [...payloads.values()];
  }

  /**
   * Unload several chunks at once.
   *
   * The batch form exists for the same reason {@link serializeChunks} does: a sprinting
   * player evicts a column of chunks in a single tick, and doing them one at a time
   * re-scanned every entity in the world for each one.
   */
  unloadChunks(keys: readonly ChunkKey[]): ChunkDynamicPayload[] {
    const runtimes: ChunkRuntimeState[] = [];
    for (const key of keys) {
      const runtime = this.state.chunks[key];
      if (runtime) runtimes.push(runtime);
    }
    if (runtimes.length === 0) return [];

    const payloads = this.serializeChunks(runtimes);
    for (const runtime of runtimes) {
      for (const system of this.systems) system.onChunkUnload?.(this.ctx, runtime.key);
    }

    for (const payload of payloads) {
      for (const structure of payload.structures) {
        detachStructure(this.ctx, structure);
        delete this.state.structures[structure.id];
      }
      for (const node of payload.nodes) {
        detachNode(this.ctx, node);
        delete this.state.nodes[node.id];
      }
      for (const item of payload.items) delete this.state.items[item.id];
      for (const zombie of payload.zombies) delete this.state.zombies[zombie.id];
      for (const animal of payload.animals) delete this.state.animals[animal.id];

      this.world.unloadChunk(payload.key);
      delete this.state.chunks[payload.key];
    }
    return payloads;
  }

  /**
   * Unload a chunk: serialize it, detach its entities, and drop its terrain.
   * The returned payload must be persisted by the caller before it is discarded.
   */
  unloadChunk(key: ChunkKey): ChunkDynamicPayload | undefined {
    return this.unloadChunks([key])[0];
  }

  /** Ask for a chunk's dynamic data if it is not already loaded or queued. */
  requestChunk(cx: number, cy: number): void {
    const key = chunkKey(cx, cy);
    if (this.state.chunks[key]) return;
    if (this.state.pendingChunkLoads.includes(key)) return;
    this.state.pendingChunkLoads.push(key);
  }

  // -------------------------------------------------------------------------
  // World metadata
  // -------------------------------------------------------------------------

  serializeMeta(name: string, createdAtMs: number, savedAtMs: number): WorldMetaPayload {
    return {
      version: SAVE_FORMAT_VERSION,
      name,
      seed: this.state.seed,
      tick: this.state.tick,
      weather: this.state.weather,
      rng: this.rng.getState(),
      nextId: this.state.nextId,
      createdAtMs,
      savedAtMs,
      totalTicks: this.state.steppedTicks,
    };
  }

  /** Restore world-level state from a save. Call before adding any players. */
  loadMeta(meta: WorldMetaPayload): void {
    this.state.seed = meta.seed;
    this.state.tick = meta.tick;
    this.state.time.tick = meta.tick;
    this.state.weather = meta.weather;
    this.state.nextId = Math.max(this.state.nextId, meta.nextId);
    this.state.steppedTicks = meta.totalTicks;
    this.state.rng = meta.rng;
    this.rng.setState(meta.rng);
    this.clock.setTick(meta.tick);
  }

  /** Convenience for tests and tools. */
  static withConsoleLog(options: SimulationOptions): Simulation {
    return new Simulation({ ...options, logger: options.logger ?? createConsoleLogger() });
  }

  /** The context handed to systems. Exposed for tests and tools. */
  get context(): SimContext {
    return this.ctx;
  }
}

/** Trailing digits of an entity id, so `nextId` never collides after a load. */
function numericSuffix(id: string): number {
  const match = /(\d+)$/.exec(id);
  return match ? Number.parseInt(match[1] as string, 10) : 0;
}

/** Re-exported so callers can order custom systems relative to the built-ins. */
export { SystemOrder };
export { parseChunkKey };
