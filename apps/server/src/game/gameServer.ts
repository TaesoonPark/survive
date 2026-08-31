import {
  AUTOSAVE_TICKS,
  FixedStepDriver,
  SAVE_FORMAT_VERSION,
  chunkKey,
  chunkKeysAround,
  createEmptyChunkPayload,
  parseChunkKey,
  type ChunkDynamicPayload,
  type ChunkKey,
  type ChunkPayload,
  type Command,
  type InputFrame,
  type PlayerId,
  type PlayerState,
  type SimEvent,
  type SimulationConfig,
  type WorldInfo,
  type WorldMetaPayload,
} from '@survive/protocol';
import { CHUNK_TILES, TILE_SIZE, WORLD_TILES } from '@survive/protocol';
import type { GameData } from '@survive/game-data';
import type { WorldService } from '@survive/world';
import {
  Simulation,
  bindInputSource,
  createDefaultSystems,
  createPlayerState,
  nullLogger,
  type Logger,
  type System,
} from '@survive/simulation';
import type { WorldRepository } from '@survive/persistence';

/**
 * The headless game server.
 *
 * Owns the simulation, the save file, and the boundary between the two. Deliberately
 * knows nothing about WebSockets: the Colyseus room drives it, and integration tests
 * drive it exactly the same way with no network at all (spec sections 34 and 36).
 *
 * The one subtlety here is chunk streaming. The simulation is synchronous and
 * deterministic, so it can never await a disk read. Instead it *requests* chunks by
 * pushing keys onto `pendingChunkLoads`, and this class fulfils them asynchronously
 * and installs the results between ticks.
 */

export interface GameServerOptions {
  config: SimulationConfig;
  data: GameData;
  world: WorldService;
  repository: WorldRepository;
  logger?: Logger;
  /** Override the system list. Tests use this to isolate one system. */
  systems?: System[];
  /** Wall-clock source, injected so tests can control save timestamps. */
  now?: () => number;
  /**
   * Throw the save away and hand back a fresh, empty repository for the same world.
   *
   * Supplied by `bootstrap`, because deleting a world is the *store's* business and this
   * class only ever sees the one repository it was handed. A server built without it -
   * every test fixture, for one - simply cannot be reset, which is the safe default for
   * an operation whose whole job is to destroy data.
   */
  recreateWorld?: () => Promise<WorldRepository>;
}

export interface JoinResult {
  player: PlayerState;
  /** True when this is a brand-new character rather than a loaded one. */
  created: boolean;
}

/** A snapshot of runtime health, for the launcher's stats panel. */
export interface ServerStats {
  tick: number;
  players: number;
  loadedChunks: number;
  entities: number;
  /** Ticks the driver had to drop because the process fell behind. */
  droppedTicks: number;
  /** Average milliseconds spent inside `step()` over the recent window. */
  averageStepMs: number;
  paused: boolean;
  uptimeMs: number;
}

export class GameServer {
  readonly config: SimulationConfig;
  readonly data: GameData;
  readonly world: WorldService;
  readonly log: Logger;

  /** Swapped out wholesale by {@link resetWorld}, which is why it is not `readonly`. */
  private repositoryRef: WorldRepository;
  private readonly recreateWorld: (() => Promise<WorldRepository>) | undefined;

  private sim!: Simulation;
  private driver: FixedStepDriver | null = null;
  /** Events collected across the steps of one {@link pump}. See the note there. */
  private readonly pumpEvents: SimEvent[] = [];
  private readonly now: () => number;
  private readonly systems: System[] | undefined;

  private startedAtMs = 0;
  private createdAtMs = 0;
  private running = false;
  /** Chunk keys currently being read from disk, so we do not double-load. */
  private readonly loadingChunks = new Set<ChunkKey>();
  private lastAutosaveTick = 0;
  private stepDurations: number[] = [];
  private eventListeners: Array<(events: SimEvent[]) => void> = [];
  /** Pending save promises, awaited on shutdown so nothing is lost. */
  private inFlightSaves = new Set<Promise<unknown>>();

  constructor(options: GameServerOptions) {
    this.config = options.config;
    this.data = options.data;
    this.world = options.world;
    this.repositoryRef = options.repository;
    this.recreateWorld = options.recreateWorld;
    this.log = options.logger ?? nullLogger;
    this.systems = options.systems;
    this.now = options.now ?? (() => Date.now());
  }

  get simulation(): Simulation {
    return this.sim;
  }

  get repository(): WorldRepository {
    return this.repositoryRef;
  }

  /** Whether this server was built with a way to destroy and rebuild its world. */
  get canResetWorld(): boolean {
    return this.recreateWorld !== undefined;
  }

  get isRunning(): boolean {
    return this.running;
  }

  get worldInfo(): WorldInfo {
    return {
      name: this.config.saveName,
      seed: this.sim.state.seed,
      tileSize: TILE_SIZE,
      chunkTiles: CHUNK_TILES,
      worldChunks: WORLD_TILES / CHUNK_TILES,
      createdTick: 0,
    };
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Open the save, build the simulation, and prime the chunks around the spawn point.
   *
   * A fresh world and a loaded one take the same path: the only difference is whether
   * `loadMeta` returns anything.
   */
  async start(): Promise<void> {
    if (this.running) return;
    await this.repository.open();

    const meta = await this.repository.loadMeta();
    const seed = meta?.seed ?? this.config.world.seed;
    // A loaded world keeps its original seed: regenerating terrain with a new one
    // would leave every saved structure floating in the wrong place.
    this.config.world.seed = seed;

    this.sim = new Simulation({
      config: this.config,
      data: this.data,
      world: this.world,
      logger: this.log.child('sim'),
      systems: this.systems ?? createDefaultSystems(),
    });

    // The pending-input buffer is transient network state and lives on the Simulation,
    // not in the world, so the input system has to be pointed at it. Without this, every
    // player coasts: the single most confusing possible failure mode.
    bindInputSource(this.sim);

    if (meta) {
      this.sim.loadMeta(meta);
      this.createdAtMs = meta.createdAtMs;
      this.log.info('world loaded', {
        name: meta.name,
        tick: meta.tick,
        day: this.sim.state.time.day,
      });
    } else {
      this.createdAtMs = this.now();
      this.log.info('new world created', { name: this.config.saveName, seed });
      await this.saveMeta();
    }

    this.lastAutosaveTick = this.sim.state.tick;
    this.startedAtMs = this.now();
    this.running = true;

    // Load the chunks around the default spawn so the first player has ground to
    // stand on before the first tick runs.
    await this.primeChunksAround(this.defaultSpawn().x, this.defaultSpawn().y);
  }

  /**
   * Save everything and close the repository. Safe to call twice.
   *
   * `save: false` is for {@link resetWorld}, which is about to delete the very world a
   * final save would write - and writing it first would race the delete for no purpose.
   */
  async stop(options: { save?: boolean } = {}): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.driver = null;
    try {
      if (options.save !== false) {
        await this.saveAll();
        await Promise.allSettled([...this.inFlightSaves]);
        await this.repository.flush();
      }
    } finally {
      await this.repository.close();
    }
    this.log.info('server stopped', { tick: this.sim?.state.tick ?? 0 });
  }

  /**
   * Throw the world away and start a new one, in this process.
   *
   * Everything goes: terrain, structures, dropped items and every saved character. What
   * survives is the world's *name* and its seed, so the new map is the same ground the
   * old one was generated from - a reset, not a reroll.
   *
   * The caller is responsible for getting the players off first. This does not touch the
   * network, because the simulation does not know it has any: a client left connected
   * across a reset would be holding entity ids that no longer refer to anything.
   */
  async resetWorld(): Promise<void> {
    const recreate = this.recreateWorld;
    if (!recreate) throw new Error('this server was not built with world reset');

    // Not `saveAll`: the save is about to be deleted, and the in-flight writes would
    // otherwise be racing the delete for a file nobody will read.
    await this.stop({ save: false });
    this.inFlightSaves.clear();
    this.loadingChunks.clear();
    this.stepDurations = [];
    this.repositoryRef = await recreate();
    await this.start();
    this.log.warn('world reset', { name: this.config.saveName });
  }

  // -------------------------------------------------------------------------
  // Ticking
  // -------------------------------------------------------------------------

  /**
   * Run one simulation tick plus the surrounding housekeeping.
   *
   * Returns the events emitted, so the caller can fan them out to clients. Chunk I/O
   * is kicked off but never awaited here: the tick must stay synchronous.
   */
  tick(): SimEvent[] {
    if (!this.running) return [];
    if (this.shouldIdle()) return this.sim.drainEvents();

    const startMs = this.now();
    this.sim.step(1);
    this.recordStepDuration(this.now() - startMs);

    this.serviceChunkRequests();
    this.serviceChunkEviction();
    this.maybeAutosave();

    const events = this.sim.drainEvents();
    if (events.length > 0) {
      for (const listener of this.eventListeners) listener(events);
    }
    return events;
  }

  /**
   * Advance by however many fixed steps real time has earned, with the events they emitted.
   *
   * Called from an interval by the room; tests call {@link tick} or {@link advance}
   * directly and never touch real time.
   *
   * The events have to come back out of here. `tick` *drains* the sink, so a `pump` that
   * discarded its return left the caller re-draining an empty sink and every client
   * receiving nothing - no damage numbers, no hit feedback, no notifications, in single
   * player as much as in multiplayer, because both run this same room. Snapshots carried
   * on regardless, which is exactly why it went unnoticed: the world looked right and only
   * the feedback layer was missing.
   */
  pump(): { steps: number; events: SimEvent[] } {
    if (!this.running) return { steps: 0, events: [] };
    if (!this.driver) {
      // The buffer is an instance field rather than a local: the driver is built once and
      // its step closure outlives this call, so a captured local would collect every
      // later pump's events into the first pump's array.
      this.driver = new FixedStepDriver({
        step: () => {
          for (const event of this.tick()) this.pumpEvents.push(event);
        },
        maxCatchUpSteps: 5,
      });
    }
    this.pumpEvents.length = 0;
    const steps = this.driver.pump();
    return { steps, events: this.pumpEvents.slice() };
  }

  /** Run `ticks` steps immediately. The headless test workhorse. */
  advance(ticks: number): SimEvent[] {
    const all: SimEvent[] = [];
    for (let i = 0; i < ticks; i++) all.push(...this.tick());
    return all;
  }

  /**
   * Skip simulating when nobody is watching.
   *
   * `pauseWhenEmpty` keeps an idle dedicated server off the CPU, and a paused
   * single-player world genuinely stops (spec section 12) rather than merely hiding
   * the fact that time keeps passing.
   */
  private shouldIdle(): boolean {
    if (this.sim.paused) return true;
    if (!this.config.mode.pauseWhenEmpty) return false;
    return Object.keys(this.sim.state.players).length === 0;
  }

  private recordStepDuration(ms: number): void {
    this.stepDurations.push(ms);
    if (this.stepDurations.length > 200) this.stepDurations.shift();
  }

  /** Subscribe to each tick's events. Used by logging and the launcher feed. */
  onEvents(listener: (events: SimEvent[]) => void): () => void {
    this.eventListeners.push(listener);
    return () => {
      const index = this.eventListeners.indexOf(listener);
      if (index >= 0) this.eventListeners.splice(index, 1);
    };
  }

  // -------------------------------------------------------------------------
  // Players
  // -------------------------------------------------------------------------

  /** Default spawn: the middle of the world. */
  defaultSpawn(): { x: number; y: number } {
    const centre = (WORLD_TILES * TILE_SIZE) / 2;
    return { x: centre, y: centre };
  }

  /**
   * Bring a player into the world, loading their saved character if there is one.
   *
   * The chunks around their position are loaded first, because a player installed into
   * unloaded terrain would fall through the collision grid on the very next tick.
   */
  async joinPlayer(playerId: PlayerId, name: string): Promise<JoinResult> {
    const existing = this.sim.getPlayer(playerId);
    if (existing) return { player: existing, created: false };

    const saved = await this.repository.loadPlayer(playerId);
    let player: PlayerState;
    let created = false;
    if (saved) {
      player = saved.player;
      // The display name can change between sessions.
      player.name = name;
    } else {
      const spawn = this.defaultSpawn();
      player = createPlayerState(this.data, this.config, {
        id: playerId,
        name,
        x: spawn.x,
        y: spawn.y,
      });
      created = true;
    }

    await this.primeChunksAround(player.x, player.y);
    this.sim.addPlayer(player);
    this.log.info('player joined', { playerId, name, created });
    return { player, created };
  }

  /** Save and remove a player. */
  async leavePlayer(playerId: PlayerId): Promise<void> {
    const player = this.sim.removePlayer(playerId);
    if (!player) return;
    await this.savePlayer(player);
    this.log.info('player left', { playerId });
  }

  pushInput(playerId: PlayerId, frames: readonly InputFrame[]): void {
    this.sim.pushInput(playerId, frames);
  }

  queueCommand(playerId: PlayerId, command: Command): void {
    this.sim.queueCommand(playerId, command);
  }

  /** Honoured only when the config allows it, so one client cannot stop a server. */
  setPaused(paused: boolean): boolean {
    return this.sim.setPaused(paused);
  }

  // -------------------------------------------------------------------------
  // Chunk streaming
  // -------------------------------------------------------------------------

  /** Terrain payload for a chunk, for the wire. */
  chunkPayload(key: ChunkKey): ChunkPayload | null {
    const { cx, cy } = parseChunkKey(key);
    const terrain = this.world.ensureChunk(cx, cy);
    return {
      key,
      cx,
      cy,
      tiles: terrain.tiles,
      biomes: terrain.biomes,
      version: terrain.version,
    };
  }

  /**
   * Load and install every chunk within the load radius of a position, awaiting the
   * I/O. Used at join time and at startup, where blocking is acceptable and correct.
   */
  async primeChunksAround(x: number, y: number): Promise<void> {
    const keys = chunkKeysAround(x, y, this.config.chunkLoadRadius);
    await Promise.all(keys.map((key) => this.loadChunk(key)));
  }

  /** Kick off async loads for whatever the simulation asked for this tick. */
  private serviceChunkRequests(): void {
    const requests = this.sim.takeChunkRequests();
    for (const key of requests) {
      const promise = this.loadChunk(key).catch((error: unknown) => {
        this.log.error('chunk load failed', { key, error: String(error) });
      });
      this.track(promise);
    }
  }

  /**
   * Read one chunk's dynamic layer and install it.
   *
   * A missing chunk on disk is normal, not an error: it means nothing has ever
   * happened there, so an empty payload is exactly right.
   */
  private async loadChunk(key: ChunkKey): Promise<void> {
    if (this.sim.state.chunks[key]) return;
    if (this.loadingChunks.has(key)) return;
    this.loadingChunks.add(key);
    try {
      const { cx, cy } = parseChunkKey(key);
      const stored = await this.repository.loadChunk(cx, cy);
      // Re-check: a competing load may have installed it while we were awaiting.
      if (this.sim.state.chunks[key]) return;
      this.sim.installChunk(stored ?? createEmptyChunkPayload(key, cx, cy));
    } finally {
      this.loadingChunks.delete(key);
    }
  }

  /**
   * Unload chunks no player has been near for a while.
   *
   * Uses a wider radius than loading so a player pacing across a chunk border does not
   * thrash the disk (the classic hysteresis fix).
   */
  private serviceChunkEviction(): void {
    const players = Object.values(this.sim.state.players);
    if (players.length === 0) return;
    const keepRadius = this.config.chunkLoadRadius + 2;

    const keep = new Set<ChunkKey>();
    for (const player of players) {
      for (const key of chunkKeysAround(player.x, player.y, keepRadius)) keep.add(key);
    }

    // Collect first, then unload as a batch: a sprinting player evicts a whole column of
    // chunks in one tick, and unloading them one at a time re-scans every entity in the
    // world for each one.
    const evict: ChunkKey[] = [];
    for (const runtime of Object.values(this.sim.state.chunks)) {
      if (keep.has(runtime.key)) {
        runtime.lastTouchedTick = this.sim.state.tick;
        continue;
      }
      evict.push(runtime.key);
    }
    if (evict.length === 0) return;
    for (const payload of this.sim.unloadChunks(evict)) {
      this.track(this.writeChunk(payload));
    }
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  private maybeAutosave(): void {
    if (this.sim.state.tick - this.lastAutosaveTick < AUTOSAVE_TICKS) return;
    this.lastAutosaveTick = this.sim.state.tick;
    this.track(
      this.saveAll().catch((error: unknown) => {
        this.log.error('autosave failed', { error: String(error) });
      }),
    );
  }

  /** Write world metadata, every dirty chunk, and every connected player. */
  async saveAll(): Promise<void> {
    const dirty = this.sim.collectDirtyChunks();
    const players = Object.values(this.sim.state.players);
    await Promise.all([
      this.saveMeta(),
      dirty.length > 0 ? this.repository.saveChunks(dirty) : Promise.resolve(),
      ...players.map((player) => this.savePlayer(player)),
    ]);
    this.log.debug('saved', { chunks: dirty.length, players: players.length });
  }

  private async saveMeta(): Promise<void> {
    const meta: WorldMetaPayload = this.sim.serializeMeta(
      this.config.saveName,
      this.createdAtMs,
      this.now(),
    );
    await this.repository.saveMeta(meta);
  }

  private async savePlayer(player: PlayerState): Promise<void> {
    await this.repository.savePlayer({
      version: SAVE_FORMAT_VERSION,
      player,
      savedAtMs: this.now(),
    });
  }

  private async writeChunk(payload: ChunkDynamicPayload): Promise<void> {
    try {
      await this.repository.saveChunk(payload);
    } catch (error) {
      this.log.error('chunk save failed', { key: payload.key, error: String(error) });
    }
  }

  /** Keep a handle on background I/O so shutdown can wait for it. */
  private track(promise: Promise<unknown>): void {
    this.inFlightSaves.add(promise);
    void promise.finally(() => this.inFlightSaves.delete(promise));
  }

  /** Await every outstanding background save. Tests use this before asserting. */
  async settle(): Promise<void> {
    while (this.inFlightSaves.size > 0) {
      await Promise.allSettled([...this.inFlightSaves]);
    }
  }

  // -------------------------------------------------------------------------
  // Diagnostics
  // -------------------------------------------------------------------------

  stats(): ServerStats {
    const state = this.sim.state;
    const entities =
      Object.keys(state.zombies).length +
      Object.keys(state.animals).length +
      Object.keys(state.items).length +
      Object.keys(state.structures).length +
      Object.keys(state.nodes).length +
      Object.keys(state.projectiles).length;
    const average =
      this.stepDurations.length > 0
        ? this.stepDurations.reduce((sum, value) => sum + value, 0) / this.stepDurations.length
        : 0;
    return {
      tick: state.tick,
      players: Object.keys(state.players).length,
      loadedChunks: Object.keys(state.chunks).length,
      entities,
      droppedTicks: this.driver?.dropped ?? 0,
      averageStepMs: average,
      paused: state.paused,
      uptimeMs: this.now() - this.startedAtMs,
    };
  }

  /** Chunk keys currently loaded, for tests and the launcher log. */
  loadedChunkKeys(): ChunkKey[] {
    return Object.keys(this.sim.state.chunks);
  }

  /** Chunk key containing a world position. */
  static keyAt(x: number, y: number): ChunkKey {
    return chunkKey(
      Math.floor(x / (CHUNK_TILES * TILE_SIZE)),
      Math.floor(y / (CHUNK_TILES * TILE_SIZE)),
    );
  }
}
