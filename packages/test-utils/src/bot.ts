import {
  Button,
  GAME_ROOM_NAME,
  PROTOCOL_VERSION,
  SIM_DT_MS,
  type ChunkPayload,
  type Command,
  type EntitySnapshot,
  type InputFrame,
  type PlayerState,
  type SimEvent,
  type WelcomePayload,
  type WorldSnapshot,
} from '@survive/protocol';
import { SnapshotStore, connectToServer, type ServerConnection } from '@survive/netcode';

/**
 * A headless bot client.
 *
 * Connects over the real network with the real client netcode, which is what makes a
 * multiplayer test meaningful: if a bot sees the wrong thing, so would a player (spec
 * section 35). No Phaser, no DOM.
 */

export interface BotOptions {
  url: string;
  name: string;
  playerId?: string;
  roomName?: string;
  password?: string;
  token?: string;
  /** Collect every snapshot rather than only the latest. Off by default. */
  recordSnapshots?: boolean;
}

export interface Bot {
  readonly name: string;
  readonly playerId: string;
  readonly connection: ServerConnection;
  readonly store: SnapshotStore;
  /** The bot's own authoritative player state, or null before the first snapshot. */
  readonly self: PlayerState | null;
  /** Entities the server has told this bot about. */
  entities(): EntitySnapshot[];
  /** One entity by id, or undefined when this bot has not been told about it. */
  entity(id: string): EntitySnapshot | undefined;
  /** Every event this bot has received. */
  readonly events: SimEvent[];
  /** Chunk terrain payloads received, keyed by chunk key. */
  readonly chunks: Map<string, ChunkPayload>;
  /** Snapshots received, when `recordSnapshots` was set. */
  readonly snapshots: WorldSnapshot[];
  readonly welcome: WelcomePayload | null;

  /** Send one input frame. Sequence numbers are managed internally. */
  input(frame?: Partial<InputFrame>): InputFrame;
  /** Send a movement input every `intervalMs` for `ticks` frames. */
  move(moveX: number, moveY: number, ticks: number): Promise<void>;
  /** Send an attack input aimed at an angle. */
  attack(aimAngle: number, ticks?: number): Promise<void>;
  send(command: Command): void;
  /** Wait until `predicate` holds, or reject after `timeoutMs`. */
  waitFor(
    predicate: (bot: Bot) => boolean,
    description?: string,
    timeoutMs?: number,
  ): Promise<void>;
  /** Wait for the next snapshot to arrive. */
  nextSnapshot(timeoutMs?: number): Promise<WorldSnapshot>;
  /** Wait for an event matching a predicate. */
  waitForEvent<T extends SimEvent>(
    match: (event: SimEvent) => event is T,
    timeoutMs?: number,
  ): Promise<T>;
  leave(): Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export async function createBot(options: BotOptions): Promise<Bot> {
  const store = new SnapshotStore();
  const events: SimEvent[] = [];
  const chunks = new Map<string, ChunkPayload>();
  const snapshots: WorldSnapshot[] = [];
  let welcome: WelcomePayload | null = null;
  let latest: WorldSnapshot | null = null;
  const snapshotWaiters: Array<(snapshot: WorldSnapshot) => void> = [];

  const connection = await connectToServer({
    url: options.url,
    roomName: options.roomName ?? GAME_ROOM_NAME,
    join: {
      protocolVersion: PROTOCOL_VERSION,
      name: options.name,
      ...(options.playerId ? { playerId: options.playerId } : {}),
      ...(options.password ? { password: options.password } : {}),
      ...(options.token ? { token: options.token } : {}),
    },
    onWelcome: (payload) => {
      welcome = payload;
    },
    onSnapshot: (snapshot) => {
      latest = snapshot;
      store.applySnapshot(snapshot);
      if (options.recordSnapshots) snapshots.push(snapshot);
      while (snapshotWaiters.length > 0) snapshotWaiters.shift()?.(snapshot);
    },
    onChunk: (chunk) => {
      chunks.set(chunk.key, chunk);
      store.applyChunk(chunk);
    },
    onChunkDrop: (payload) => {
      for (const key of payload.keys) chunks.delete(key);
      store.dropChunks(payload.keys);
    },
    onEvents: (batch) => {
      events.push(...batch.events);
    },
  });

  let seq = 0;

  const bot: Bot = {
    name: options.name,
    get playerId() {
      return welcome?.playerId ?? '';
    },
    connection,
    store,
    get self() {
      return latest?.self ?? null;
    },
    entities() {
      return [...store.entities()];
    },
    entity(id: string) {
      return store.entity(id);
    },
    events,
    chunks,
    snapshots,
    get welcome() {
      return welcome;
    },

    input(partial = {}) {
      seq += 1;
      const frame: InputFrame = {
        seq,
        moveX: 0,
        moveY: 0,
        aimAngle: 0,
        buttons: 0,
        ...partial,
      };
      connection.sendInputs([frame]);
      return frame;
    },

    async move(moveX, moveY, ticks) {
      for (let i = 0; i < ticks; i++) {
        bot.input({ moveX, moveY, aimAngle: Math.atan2(moveY, moveX) });
        await sleep(SIM_DT_MS);
      }
    },

    async attack(aimAngle, ticks = 3) {
      for (let i = 0; i < ticks; i++) {
        bot.input({ aimAngle, buttons: Button.Primary });
        await sleep(SIM_DT_MS);
      }
      // Release, so the server sees an edge rather than a held button forever.
      bot.input({ aimAngle, buttons: 0 });
    },

    send(command) {
      connection.sendCommand(command);
    },

    async waitFor(predicate, description = 'condition', timeoutMs = DEFAULT_TIMEOUT_MS) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (predicate(bot)) return;
        await sleep(20);
      }
      throw new Error(`bot ${options.name}: timed out waiting for ${description}`);
    },

    async nextSnapshot(timeoutMs = DEFAULT_TIMEOUT_MS) {
      return new Promise<WorldSnapshot>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`bot ${options.name}: no snapshot within ${timeoutMs}ms`)),
          timeoutMs,
        );
        snapshotWaiters.push((snapshot) => {
          clearTimeout(timer);
          resolve(snapshot);
        });
      });
    },

    async waitForEvent<T extends SimEvent>(
      match: (event: SimEvent) => event is T,
      timeoutMs = DEFAULT_TIMEOUT_MS,
    ) {
      const deadline = Date.now() + timeoutMs;
      let index = 0;
      while (Date.now() < deadline) {
        while (index < events.length) {
          const event = events[index++];
          if (event && match(event)) return event;
        }
        await sleep(20);
      }
      throw new Error(`bot ${options.name}: timed out waiting for an event`);
    },

    async leave() {
      await connection.leave();
    },
  };

  // The handshake is not complete until the server has sent the welcome packet.
  await bot.waitFor(() => welcome !== null, 'welcome packet', 15_000);
  await bot.waitFor(() => latest !== null, 'first snapshot', 15_000);
  return bot;
}

/** Connect several bots at once and hand them back in order. */
export async function createBots(
  url: string,
  names: readonly string[],
  extra: Omit<BotOptions, 'url' | 'name'> = {},
): Promise<Bot[]> {
  const bots: Bot[] = [];
  // Sequential on purpose: a simultaneous rush would exercise matchmaking races
  // rather than the gameplay the caller is trying to test.
  for (const name of names) {
    bots.push(await createBot({ ...extra, url, name, playerId: name.toLowerCase() }));
  }
  return bots;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Wait until every bot agrees on a predicate, which is the real multiplayer check. */
export async function waitForAll(
  bots: readonly Bot[],
  predicate: (bot: Bot) => boolean,
  description = 'convergence',
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<void> {
  await Promise.all(bots.map((bot) => bot.waitFor(predicate, description, timeoutMs)));
}
