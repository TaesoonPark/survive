import { Room, ServerError, type Client } from 'colyseus';
import {
  ClientMessage,
  PROTOCOL_VERSION,
  SIM_DT_MS,
  ServerMessage,
  chunkKey,
  isChunkInWorld,
  parseChunkKey,
  pixelToChunk,
  toClientVisibleConfig,
  type ChunkDropPayload,
  type CommandPayload,
  type EventsPayload,
  type InputsPayload,
  type JoinOptions,
  type PingPayload,
  type PlayerId,
  type PongPayload,
  type RequestChunksPayload,
  type WelcomePayload,
} from '@survive/protocol';
import type { Logger } from '@survive/simulation';
import type { GameServer } from '../game/gameServer';
import { AoiTracker } from './aoi';
import { joinGate, sanitizeName, sanitizePlayerId } from './joinGate';

/**
 * The Colyseus room.
 *
 * Deliberately thin: it validates the handshake, moves messages between the socket and
 * the {@link GameServer}, and decides *who* gets *which* slice of the world through the
 * {@link AoiTracker}. Not one game rule lives here - the room is transport, and the
 * simulation is the game.
 */

export interface GameRoomContext {
  server: GameServer;
  logger: Logger;
}

interface ClientBinding {
  playerId: string;
  name: string;
}

export class GameRoom extends Room {
  private game!: GameServer;
  private log!: Logger;
  private aoi!: AoiTracker;
  private readonly bindings = new Map<string, ClientBinding>();
  private ticksSinceSnapshot = 0;
  private snapshotEveryTicks = 2;

  override onCreate(options: GameRoomContext): void {
    this.game = options.server;
    this.log = options.logger.child('room');
    this.aoi = new AoiTracker({
      radius: this.game.config.network.aoiRadius,
      chunkRadius: this.game.config.chunkLoadRadius,
    });

    // The world outlives its occupants: an empty room must not dispose the simulation.
    this.autoDispose = false;
    this.maxClients = this.game.config.mode.maxPlayers;
    this.snapshotEveryTicks = Math.max(
      1,
      Math.round(this.game.config.simHz / this.game.config.snapshotHz),
    );

    // The gate was already armed by `listen()`; re-affirm in case a room is created by
    // some other path (a test, or a future second room type).
    joinGate.configure(this.game.config);

    this.registerMessageHandlers();
    this.setSimulationInterval(() => this.pump(), SIM_DT_MS);
    // Reap claims from reservations that were never consumed, or a client that crashed
    // between matchmaking and connecting would lock its character out.
    this.clock.setInterval(() => joinGate.reap(), 5_000);
    this.log.info('room created', {
      maxClients: this.maxClients,
      snapshotEveryTicks: this.snapshotEveryTicks,
    });
  }

  /**
   * Wrap a message handler so a bad payload cannot take the process with it.
   *
   * Colyseus dispatches handlers synchronously from the WebSocket 'message' event with no
   * try/catch of its own, so anything thrown here escapes into the ws callback and becomes
   * an uncaught exception - which `main.ts` treats as fatal and shuts the server down on.
   * One malformed message from any joined client was therefore enough to stop a dedicated
   * server for everybody.
   *
   * The individual handlers still validate their own payloads; this is the backstop that
   * keeps the next unvalidated field from being a remote kill switch rather than a log line.
   */
  private safely<T>(
    channel: string,
    handler: (client: Client, payload: T) => void,
  ): (client: Client, payload: T) => void {
    return (client, payload) => {
      try {
        handler(client, payload);
      } catch (error) {
        this.log.warn('dropped a message that threw', {
          channel,
          sessionId: client.sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };
  }

  private registerMessageHandlers(): void {
    this.onMessage(
      ClientMessage.Inputs,
      this.safely<InputsPayload>('inputs', (client, payload) => {
        const binding = this.bindings.get(client.sessionId);
        // `Array.isArray`, not a length check: a string has a length too, and then
        // `.filter` is not a function.
        if (!binding || !Array.isArray(payload?.frames)) return;
        // Trust nothing: a client could send a thousand frames to fast-forward itself.
        const frames = payload.frames.slice(0, 32).filter((frame) => isSaneFrame(frame));
        if (frames.length > 0) this.game.pushInput(binding.playerId, frames);
      }),
    );

    this.onMessage(
      ClientMessage.Command,
      this.safely<CommandPayload>('command', (client, payload) => {
        const binding = this.bindings.get(client.sessionId);
        if (!binding || typeof payload?.command?.type !== 'string') return;
        if (payload.command.type === 'setPaused' && !this.game.config.mode.pauseWhenClientPaused) {
          // Multiplayer clients cannot stop the world (spec section 12).
          return;
        }
        this.game.queueCommand(binding.playerId, payload.command);
      }),
    );

    this.onMessage(
      ClientMessage.Ping,
      this.safely<PingPayload>('ping', (client, payload) => {
        const pong: PongPayload = {
          clientTimeMs: Number.isFinite(payload?.clientTimeMs) ? payload.clientTimeMs : 0,
          serverTimeMs: Date.now(),
          tick: this.game.simulation.state.tick,
        };
        client.send(ServerMessage.Pong, pong);
      }),
    );

    this.onMessage(
      ClientMessage.RequestChunks,
      this.safely<RequestChunksPayload>('requestChunks', (client, payload) => {
        const binding = this.bindings.get(client.sessionId);
        if (!binding || !Array.isArray(payload?.keys)) return;
        for (const key of payload.keys.slice(0, 64)) {
          // A request is a *hint about ordering*, never an entitlement. Without this the
          // handler served any coordinate on the 256x256-chunk map: a client could read
          // the whole world without exploring it, and every forged key installed a
          // resident chunk plus its collision grid that eviction never reclaimed, because
          // eviction only walks chunks the simulation itself installed.
          if (!this.mayReceiveChunk(binding.playerId, key)) continue;
          const chunk = this.game.chunkPayload(key);
          if (!chunk) continue;
          client.send(ServerMessage.Chunk, chunk);
          this.aoi.markChunkSent(binding.playerId, key);
        }
      }),
    );
  }

  /**
   * Whether a client is allowed the chunk it just asked for.
   *
   * The same three conditions the server's own streaming applies in `chunkDelta`: a real
   * key, inside the world, within the player's load radius, and already resident in the
   * simulation. Anything else is refused rather than generated on demand.
   */
  private mayReceiveChunk(playerId: PlayerId, key: unknown): boolean {
    if (typeof key !== 'string') return false;
    const player = this.game.simulation.state.players[playerId];
    if (!player) return false;

    // parseChunkKey throws on a malformed key, and this is reached straight from the wire.
    let cx: number;
    let cy: number;
    try {
      ({ cx, cy } = parseChunkKey(key));
    } catch {
      return false;
    }
    if (!Number.isInteger(cx) || !Number.isInteger(cy)) return false;
    if (!isChunkInWorld(cx, cy)) return false;

    const radius = this.game.config.chunkLoadRadius;
    const playerCx = pixelToChunk(player.x);
    const playerCy = pixelToChunk(player.y);
    if (Math.abs(cx - playerCx) > radius || Math.abs(cy - playerCy) > radius) return false;

    // Only chunks the simulation has actually loaded, matching `AoiTracker.chunkDelta`.
    return this.game.simulation.state.chunks[chunkKey(cx, cy)] !== undefined;
  }

  /**
   * Validate the handshake, during matchmaking.
   *
   * Colyseus 0.17 only honours the *static* `onAuth`, and calls it while handling the
   * matchmaking HTTP request. Rejecting here means a client with the wrong password, a
   * stale protocol version or a taken character gets a readable HTTP error rather than a
   * socket that opens and immediately closes.
   *
   * A static method has no room instance to consult, so the checks live in the
   * process-wide {@link joinGate}, which `onCreate` populates.
   */
  static override onAuth(_token: string, options: unknown): Promise<boolean> {
    const decision = joinGate.validate(options);
    if (!decision.ok) throw new ServerError(decision.status, decision.reason);
    return Promise.resolve(true);
  }

  override async onJoin(client: Client, rawOptions?: unknown): Promise<void> {
    const options = (rawOptions ?? {}) as Partial<JoinOptions>;
    const name = sanitizeName(options.name);
    const playerId = sanitizePlayerId(options.playerId ?? name);
    joinGate.confirm(playerId);

    try {
      const { player, created } = await this.game.joinPlayer(playerId, name);
      this.bindings.set(client.sessionId, { playerId, name });

      const welcome: WelcomePayload = {
        protocolVersion: PROTOCOL_VERSION,
        playerId: player.id,
        tick: this.game.simulation.state.tick,
        serverTimeMs: Date.now(),
        world: this.game.worldInfo,
        config: toClientVisibleConfig(this.game.config),
        dataVersion: this.game.data.version,
        onlinePlayers: [...this.bindings.values()].map((binding) => binding.name),
      };
      client.send(ServerMessage.Welcome, welcome);

      // Terrain first, then the first snapshot, so the client never receives entities
      // standing on ground it has not been told about.
      this.flushChunks(client, playerId);
      this.sendSnapshot(client, playerId);

      this.log.info('client joined', { sessionId: client.sessionId, playerId, created });
    } catch (error) {
      joinGate.release(playerId);
      throw error;
    }
  }

  override async onLeave(client: Client, code?: number): Promise<void> {
    const binding = this.bindings.get(client.sessionId);
    this.bindings.delete(client.sessionId);
    if (!binding) return;
    joinGate.release(binding.playerId);
    this.aoi.forget(binding.playerId);
    try {
      await this.game.leavePlayer(binding.playerId);
    } catch (error) {
      this.log.error('failed to save leaving player', {
        playerId: binding.playerId,
        error: String(error),
      });
    }
    // A single-player world should not stay paused because the only client vanished
    // mid-menu; the empty-world idle check takes over from here.
    if (this.game.config.mode.singlePlayer && this.bindings.size === 0) {
      this.game.setPaused(false);
    }
    this.log.info('client left', { sessionId: client.sessionId, code: code ?? 0 });
  }

  override onDispose(): void {
    // Deliberately not resetting the gate here: the process may create another room, and
    // the gate's lifetime is the server's, not the room's. `listen().close()` clears it.
    this.log.info('room disposed');
  }

  /**
   * One real-time pump: advance the simulation, then replicate at the snapshot rate.
   *
   * Events are fanned out every pump rather than every snapshot, because a hit sound
   * that arrives 100ms late feels wrong in a way a position update does not.
   */
  private pump(): void {
    // Events come back from `pump` rather than being drained again here: `tick` already
    // emptied the sink, so a second drain always found it empty.
    const { steps: stepped, events } = this.game.pump();
    if (stepped === 0) return;

    if (events.length > 0) this.dispatchEvents(events);

    this.ticksSinceSnapshot += stepped;
    if (this.ticksSinceSnapshot < this.snapshotEveryTicks) return;
    this.ticksSinceSnapshot = 0;

    for (const client of this.clients) {
      const binding = this.bindings.get(client.sessionId);
      if (!binding) continue;
      this.flushChunks(client, binding.playerId);
      this.sendSnapshot(client, binding.playerId);
    }
  }

  private dispatchEvents(events: ReturnType<GameServer['tick']>): void {
    for (const client of this.clients) {
      const binding = this.bindings.get(client.sessionId);
      if (!binding) continue;
      const player = this.game.simulation.getPlayer(binding.playerId);
      if (!player) continue;
      const filtered = this.aoi.filterEvents(events, player);
      if (filtered.length === 0) continue;
      const payload: EventsPayload = { tick: this.game.simulation.state.tick, events: filtered };
      client.send(ServerMessage.Events, payload);
    }
  }

  private sendSnapshot(client: Client, playerId: string): void {
    const snapshot = this.aoi.build(this.game.simulation, playerId, Date.now());
    if (!snapshot) return;
    client.send(ServerMessage.Snapshot, snapshot);
  }

  /** Push any terrain the client is missing, and tell it what it can forget. */
  private flushChunks(client: Client, playerId: string): void {
    const delta = this.aoi.chunkDelta(this.game.simulation, playerId);
    // Rate-limited so walking fast does not blow the send buffer in one tick.
    for (const key of delta.send.slice(0, 6)) {
      const chunk = this.game.chunkPayload(key);
      if (!chunk) continue;
      client.send(ServerMessage.Chunk, chunk);
      this.aoi.markChunkSent(playerId, key);
    }
    if (delta.drop.length > 0) {
      const payload: ChunkDropPayload = { keys: delta.drop };
      client.send(ServerMessage.ChunkDrop, payload);
      for (const key of delta.drop) this.aoi.markChunkDropped(playerId, key);
    }
  }

  /** Disconnect everyone with a reason. Used by the shutdown path. */
  kickAll(reason: string): void {
    for (const client of this.clients) {
      client.send(ServerMessage.Kick, { reason });
    }
  }

  /** Connected player ids, for the status endpoint. */
  connectedPlayerIds(): string[] {
    return [...this.bindings.values()].map((binding) => binding.playerId);
  }
}

/** Reject nonsense input frames before they reach the simulation. */
function isSaneFrame(frame: unknown): boolean {
  if (!frame || typeof frame !== 'object') return false;
  const candidate = frame as Record<string, unknown>;
  const numbers = ['seq', 'moveX', 'moveY', 'aimAngle', 'buttons'];
  for (const key of numbers) {
    const value = candidate[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  }
  return true;
}
