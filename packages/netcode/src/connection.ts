import { Client } from 'colyseus.js';
import { ClientMessage, GAME_ROOM_NAME, JoinError, ServerMessage } from '@survive/protocol';
import type {
  ChunkDropPayload,
  ChunkKey,
  ChunkPayload,
  Command,
  CommandPayload,
  ErrorPayload,
  EventsPayload,
  InputFrame,
  InputsPayload,
  JoinErrorCode,
  JoinOptions,
  KickPayload,
  PingPayload,
  PongPayload,
  RequestChunksPayload,
  SnapshotPayload,
  WelcomePayload,
} from '@survive/protocol';
import type { SeatReservation } from 'colyseus.js';
import { ClientClock } from './clientClock';
import type { ClientClockOptions } from './clientClock';

/**
 * The client half of the wire.
 *
 * Matchmaking here is done by hand rather than through `client.joinOrCreate()`, and
 * that is deliberate — see the "Known deviation: Colyseus version pairing" section of
 * AGENTS.md. `colyseus@0.17` (server) and `colyseus.js@0.16` (client) are the newest
 * published pair, but 0.17 answers a matchmaking POST with a *flat* seat reservation:
 *
 * ```json
 * { "name": "survive", "sessionId": "aBc", "roomId": "xYz", "processId": "p1" }
 * ```
 *
 * while the 0.16 client's `consumeSeatReservation` reads `response.room.name`,
 * `response.room.roomId` and `response.room.processId`. Given the flat shape it
 * builds a WebSocket URL full of `undefined` and the join fails with no useful error.
 * So this module performs the POST itself, re-nests the payload, and hands the result
 * to `consumeSeatReservation` — the WebSocket protocol below matchmaking is
 * unchanged between the two versions, so everything after the handshake just works.
 *
 * Nothing in here touches `window` or the DOM: the same code connects a browser
 * client, a headless bot and the multiplayer test suite.
 */

/** Minimal `fetch` response shape. Keeps the module testable and DOM-free. */
export interface FetchLikeResponse {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}

/** Minimal `fetch` shape. `globalThis.fetch` satisfies it in Node and the browser. */
export type FetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<FetchLikeResponse>;

/** A 0.17 server's matchmaking answer: one flat object. */
export interface FlatSeatReservation {
  name: string;
  sessionId: string;
  roomId: string;
  processId: string;
  /** Set when the room lives behind a public address different from the seat host. */
  publicAddress?: string;
  reconnectionToken?: string;
  protocol?: string;
  devMode?: boolean;
}

/** The nested shape `colyseus.js@0.16` expects. */
export interface NestedSeatReservation {
  room: {
    name: string;
    roomId: string;
    processId: string;
    publicAddress?: string;
  };
  sessionId: string;
  reconnectionToken?: string;
  protocol?: string;
  devMode?: boolean;
}

/** The only thing this module needs from a Colyseus client. Faked in tests. */
export interface SeatConsumingClient {
  consumeSeatReservation(reservation: NestedSeatReservation): Promise<RoomLike>;
}

/** The only thing this module needs from a Colyseus room. Faked in tests. */
export interface RoomLike {
  readonly sessionId: string;
  readonly roomId: string;
  onMessage<T>(type: string, callback: (message: T) => void): unknown;
  send(type: string, message?: unknown): void;
  leave(consented?: boolean): Promise<number>;
  onLeave(callback: (code: number, reason?: string) => void): unknown;
  onError(callback: (code: number, message?: string) => void): unknown;
}

/** Matchmaking methods a 0.17 server exposes under `/matchmake/`. */
export type MatchmakeMethod = 'joinOrCreate' | 'join' | 'create';

export interface ConnectOptions {
  /** Server endpoint. `ws://`, `wss://`, `http://` and `https://` are all accepted. */
  url: string;
  /** Room name. Defaults to {@link GAME_ROOM_NAME}. */
  roomName?: string;
  /** Handshake options; the server validates protocol version, password and token. */
  join: JoinOptions;
  /** Matchmaking method. Defaults to `joinOrCreate`. */
  method?: MatchmakeMethod;

  onWelcome?(payload: WelcomePayload): void;
  onSnapshot?(payload: SnapshotPayload): void;
  onChunk?(payload: ChunkPayload): void;
  onChunkDrop?(payload: ChunkDropPayload): void;
  onEvents?(payload: EventsPayload): void;
  onPong?(payload: PongPayload): void;
  onKick?(payload: KickPayload): void;
  /** Protocol errors and transport errors both arrive here. */
  onError?(payload: ErrorPayload): void;
  /** The room closed. `code` is the WebSocket close code. */
  onDisconnect?(code: number, reason?: string): void;

  /** HTTP transport. Defaults to `globalThis.fetch`. Injected by tests. */
  fetch?: FetchLike;
  /** Colyseus client factory. Defaults to a real `colyseus.js` client. */
  createClient?: (endpoint: string) => SeatConsumingClient;
  /** Abort the matchmaking POST after this long. 0 disables the timeout. */
  matchmakeTimeoutMs?: number;
  /** Clock options, or a pre-built clock shared with the rest of the client. */
  clock?: ClientClock;
  clockOptions?: ClientClockOptions;
}

/** A live connection to a game server. */
export interface ServerConnection {
  readonly room: RoomLike;
  readonly sessionId: string;
  /** True until the room closes or {@link leave} is called. */
  readonly isConnected: boolean;
  /** The handshake payload, or null if it has not arrived yet. */
  readonly welcome: WelcomePayload | null;
  /** Smoothed round-trip time in milliseconds. */
  readonly latency: number;
  /** Best estimate of the server's current (fractional) tick. */
  readonly serverTickEstimate: number;
  /** The clock behind the two estimates above; share it with the renderer. */
  readonly clock: ClientClock;

  sendInputs(frames: readonly InputFrame[]): void;
  sendCommand(command: Command): void;
  /** Send a latency probe. The reply feeds {@link latency}. */
  sendPing(): void;
  requestChunks(keys: readonly ChunkKey[]): void;
  leave(consented?: boolean): Promise<void>;
}

/**
 * A join the server refused, or a matchmaking answer that made no sense.
 *
 * `code` is a {@link JoinErrorCode} when the server sent one, so the UI can say
 * "wrong password" instead of "HTTP 401".
 */
export class JoinRejectedError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  /** Colyseus numeric error code, when the body carried one. */
  readonly serverCode: number | undefined;
  /** The raw parsed body, for logging. */
  readonly body: unknown;

  constructor(options: {
    code: string;
    message: string;
    httpStatus: number;
    serverCode?: number;
    body?: unknown;
    /** Underlying transport failure, when the join never reached a server. */
    cause?: unknown;
  }) {
    super(options.message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'JoinRejectedError';
    this.code = options.code;
    this.httpStatus = options.httpStatus;
    this.serverCode = options.serverCode;
    this.body = options.body;
    // Required for `instanceof` to survive the ES2023 down-level class emit.
    Object.setPrototypeOf(this, JoinRejectedError.prototype);
  }

  /** True when {@link code} is one of the protocol's documented join refusals. */
  get isProtocolRefusal(): boolean {
    return isJoinErrorCode(this.code);
  }
}

export function isJoinErrorCode(code: string): code is JoinErrorCode {
  return (Object.values(JoinError) as string[]).includes(code);
}

/**
 * Turn a ws/wss URL into the http/https one matchmaking lives on.
 *
 * Callers naturally write `ws://host:port` for a game server, but matchmaking is a
 * plain HTTP POST on the same origin.
 */
export function toHttpUrl(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol === 'ws:') parsed.protocol = 'http:';
  else if (parsed.protocol === 'wss:') parsed.protocol = 'https:';
  const path = parsed.pathname.endsWith('/') ? parsed.pathname.slice(0, -1) : parsed.pathname;
  return `${parsed.origin}${path}`;
}

/**
 * Re-nest a 0.17 flat seat reservation into the 0.16 client's shape.
 *
 * Optional fields are omitted rather than set to `undefined`, because the reservation
 * is turned into WebSocket query parameters and an explicit `undefined` would be
 * serialized as the string "undefined".
 */
export function nestSeatReservation(flat: FlatSeatReservation): NestedSeatReservation {
  const room: NestedSeatReservation['room'] = {
    name: flat.name,
    roomId: flat.roomId,
    processId: flat.processId,
  };
  if (flat.publicAddress !== undefined) room.publicAddress = flat.publicAddress;

  const nested: NestedSeatReservation = { room, sessionId: flat.sessionId };
  if (flat.reconnectionToken !== undefined) nested.reconnectionToken = flat.reconnectionToken;
  if (flat.protocol !== undefined) nested.protocol = flat.protocol;
  if (flat.devMode !== undefined) nested.devMode = flat.devMode;
  return nested;
}

/**
 * Validate a matchmaking body as a flat seat reservation.
 *
 * `name` falls back to the requested room name: it is the one field the client
 * already knows, and older builds have been known to omit it.
 */
export function parseFlatSeatReservation(body: unknown, fallbackName: string): FlatSeatReservation {
  if (typeof body !== 'object' || body === null) {
    throw new JoinRejectedError({
      code: 'malformed_reservation',
      message: 'Matchmaking returned a body that is not an object.',
      httpStatus: 200,
      body,
    });
  }
  const record = body as Record<string, unknown>;
  const sessionId = record.sessionId;
  const roomId = record.roomId;
  const processId = record.processId;
  const missing: string[] = [];
  if (typeof sessionId !== 'string') missing.push('sessionId');
  if (typeof roomId !== 'string') missing.push('roomId');
  if (typeof processId !== 'string') missing.push('processId');
  if (missing.length > 0) {
    throw new JoinRejectedError({
      code: 'malformed_reservation',
      message: `Matchmaking response is missing ${missing.join(', ')}.`,
      httpStatus: 200,
      body,
    });
  }

  const flat: FlatSeatReservation = {
    name: typeof record.name === 'string' ? record.name : fallbackName,
    sessionId: sessionId as string,
    roomId: roomId as string,
    processId: processId as string,
  };
  if (typeof record.publicAddress === 'string') flat.publicAddress = record.publicAddress;
  if (typeof record.reconnectionToken === 'string') {
    flat.reconnectionToken = record.reconnectionToken;
  }
  if (typeof record.protocol === 'string') flat.protocol = record.protocol;
  if (typeof record.devMode === 'boolean') flat.devMode = record.devMode;
  return flat;
}

export interface SeatReservationRequest {
  httpUrl: string;
  roomName: string;
  join: JoinOptions;
  method?: MatchmakeMethod;
  fetch?: FetchLike;
  timeoutMs?: number;
}

/**
 * POST to `/matchmake/<method>/<roomName>` and return a reservation the 0.16 client
 * can consume.
 *
 * A refusal comes back as a non-2xx body — or, because Colyseus historically answers
 * 200 with `{ error }`, as a 200 that carries an error field. Both are rejected with
 * the server's own {@link JoinError} code so the UI can explain itself.
 *
 * Every failure mode leaves through {@link JoinRejectedError}, including the ones that
 * never reached a server (host down, DNS, timeout): the connect screen has one error
 * type to switch on, and `code` says which of the two happened.
 */
export async function requestSeatReservation(
  request: SeatReservationRequest,
): Promise<NestedSeatReservation> {
  const doFetch = request.fetch ?? getGlobalFetch();
  const method = request.method ?? 'joinOrCreate';
  const url = `${request.httpUrl}/matchmake/${method}/${encodeURIComponent(request.roomName)}`;
  const timeoutMs = request.timeoutMs ?? 10_000;

  const init: Parameters<FetchLike>[1] = {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(request.join),
  };
  const signal = createTimeoutSignal(timeoutMs);
  if (signal) init.signal = signal;

  let response: FetchLikeResponse;
  let text: string;
  try {
    response = await doFetch(url, init);
    text = await response.text();
  } catch (cause) {
    throw transportFailure(url, cause);
  }
  const parsed = parseJson(text);

  if (!response.ok) throw refusal(response.status, parsed, text);
  // Colyseus answers some refusals with 200 + { error, code }; treat them the same.
  if (hasErrorField(parsed)) throw refusal(response.status, parsed, text);

  return nestSeatReservation(parseFlatSeatReservation(parsed, request.roomName));
}

/**
 * Join a game server.
 *
 * Resolves once the room handshake has completed. Message handlers are attached
 * synchronously the moment the room exists, before any `await`, because Colyseus
 * drops messages that arrive with no handler registered and the server sends its
 * welcome the instant the seat is consumed.
 */
export async function connectToServer(options: ConnectOptions): Promise<ServerConnection> {
  const roomName = options.roomName ?? GAME_ROOM_NAME;
  const httpUrl = toHttpUrl(options.url);
  const reservation = await requestSeatReservation({
    httpUrl,
    roomName,
    join: options.join,
    ...(options.method ? { method: options.method } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.matchmakeTimeoutMs !== undefined ? { timeoutMs: options.matchmakeTimeoutMs } : {}),
  });

  const createClient = options.createClient ?? defaultClientFactory;
  const client = createClient(options.url);
  const room = await client.consumeSeatReservation(reservation);
  return new ColyseusServerConnection(room, options);
}

/** Wraps a real `colyseus.js` client in the narrow interface this module uses. */
function defaultClientFactory(endpoint: string): SeatConsumingClient {
  const client = new Client(endpoint);
  return {
    async consumeSeatReservation(reservation: NestedSeatReservation): Promise<RoomLike> {
      // colyseus.js types `reservation.room` as RoomAvailable, which also carries
      // `clients`/`maxClients`. consumeSeatReservation only reads name, roomId,
      // processId and publicAddress, so the narrower shape is safe — and it is all a
      // 0.17 server gives us.
      return await client.consumeSeatReservation(reservation as unknown as SeatReservation);
    },
  };
}

class ColyseusServerConnection implements ServerConnection {
  readonly room: RoomLike;
  readonly clock: ClientClock;

  private connected = true;
  private welcomePayload: WelcomePayload | null = null;

  constructor(room: RoomLike, options: ConnectOptions) {
    this.room = room;
    this.clock = options.clock ?? new ClientClock(options.clockOptions ?? {});

    room.onMessage<WelcomePayload>(ServerMessage.Welcome, (payload) => {
      this.welcomePayload = payload;
      this.clock.onWelcome(payload);
      options.onWelcome?.(payload);
    });

    room.onMessage<SnapshotPayload>(ServerMessage.Snapshot, (payload) => {
      // Snapshots are the densest clock samples available, so they drive the tick
      // estimate; pings only exist to measure the round trip they are aged by.
      this.clock.onServerTick(payload.tick, payload.serverTimeMs);
      options.onSnapshot?.(payload);
    });

    room.onMessage<ChunkPayload>(ServerMessage.Chunk, (payload) => options.onChunk?.(payload));
    room.onMessage<ChunkDropPayload>(ServerMessage.ChunkDrop, (payload) =>
      options.onChunkDrop?.(payload),
    );
    room.onMessage<EventsPayload>(ServerMessage.Events, (payload) => options.onEvents?.(payload));

    room.onMessage<PongPayload>(ServerMessage.Pong, (payload) => {
      this.clock.onPong(payload);
      options.onPong?.(payload);
    });

    room.onMessage<KickPayload>(ServerMessage.Kick, (payload) => options.onKick?.(payload));
    room.onMessage<ErrorPayload>(ServerMessage.Error, (payload) => options.onError?.(payload));

    room.onError((code, message) => {
      // Transport-level failures share the protocol error channel: the UI has one
      // place to show "something went wrong", and the numeric code identifies it.
      options.onError?.({ code: String(code), message: message ?? 'Transport error' });
    });

    room.onLeave((code, reason) => {
      this.connected = false;
      options.onDisconnect?.(code, reason);
    });
  }

  get sessionId(): string {
    return this.room.sessionId;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  get welcome(): WelcomePayload | null {
    return this.welcomePayload;
  }

  get latency(): number {
    return this.clock.latencyMs;
  }

  get serverTickEstimate(): number {
    return this.clock.serverTick;
  }

  sendInputs(frames: readonly InputFrame[]): void {
    if (!this.connected || frames.length === 0) return;
    const payload: InputsPayload = { frames: [...frames] };
    this.room.send(ClientMessage.Inputs, payload);
  }

  sendCommand(command: Command): void {
    if (!this.connected) return;
    const payload: CommandPayload = { command };
    this.room.send(ClientMessage.Command, payload);
  }

  sendPing(): void {
    if (!this.connected) return;
    // The timestamp must come from the clock's own source: the server echoes it back
    // untouched and the clock subtracts it from a later reading of the same source.
    const payload: PingPayload = { clientTimeMs: this.clock.now() };
    this.room.send(ClientMessage.Ping, payload);
  }

  requestChunks(keys: readonly ChunkKey[]): void {
    if (!this.connected || keys.length === 0) return;
    const payload: RequestChunksPayload = { keys: [...keys] };
    this.room.send(ClientMessage.RequestChunks, payload);
  }

  async leave(consented = true): Promise<void> {
    if (!this.connected) return;
    this.connected = false;
    await this.room.leave(consented);
  }
}

function getGlobalFetch(): FetchLike {
  // globalThis, never window: this package also runs in Node for bots and tests.
  const candidate = (globalThis as { fetch?: unknown }).fetch;
  if (typeof candidate !== 'function') {
    throw new Error(
      'No fetch implementation available. Pass options.fetch or run on Node 18+ / a modern browser.',
    );
  }
  return candidate as FetchLike;
}

function createTimeoutSignal(timeoutMs: number): AbortSignal | undefined {
  if (timeoutMs <= 0) return undefined;
  const factory = (globalThis as { AbortSignal?: { timeout?(ms: number): AbortSignal } })
    .AbortSignal;
  if (!factory || typeof factory.timeout !== 'function') return undefined;
  return factory.timeout(timeoutMs);
}

function parseJson(text: string): unknown {
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function hasErrorField(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false;
  const error = (body as Record<string, unknown>).error;
  return typeof error === 'string' && error.length > 0;
}

/**
 * Build the error for a join that never reached a matchmaker.
 *
 * `fetch` reports a dead host, a DNS failure and a timeout as plain `TypeError` /
 * `AbortError`, which a connect screen cannot tell apart from a bug. Both become a
 * {@link JoinRejectedError} with `httpStatus` 0 — there was no HTTP answer — and the
 * original error is kept as `cause` for the log.
 */
function transportFailure(url: string, cause: unknown): JoinRejectedError {
  const name = cause instanceof Error ? cause.name : '';
  const aborted = name === 'AbortError' || name === 'TimeoutError';
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new JoinRejectedError({
    code: aborted ? 'matchmake_timeout' : 'network_error',
    message: aborted
      ? `Matchmaking request to ${url} timed out.`
      : `Could not reach ${url}: ${detail}`,
    httpStatus: 0,
    body: undefined,
    cause,
  });
}

/**
 * Build the error for a refused join.
 *
 * The server may name its reason in `code` (a {@link JoinErrorCode}) or in `error`
 * (Colyseus's own field, which the room's `onAuth` rejection message lands in), so
 * both are consulted before falling back to the HTTP status.
 *
 * The one refusal a 0.17 server phrases entirely in HTTP is a shutdown: the
 * matchmaking endpoint answers a bare `503` with no body while `matchMaker.state` is
 * `SHUTTING_DOWN`. That is exactly {@link JoinError.ShuttingDown}, so it is mapped
 * rather than surfaced as `http_503` — otherwise this layer could never produce a
 * code the protocol documents.
 */
function refusal(status: number, body: unknown, rawText: string): JoinRejectedError {
  const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  const codeField = record.code;
  const errorField = record.error;
  const messageField = record.message;

  let code: string | undefined;
  if (typeof codeField === 'string' && codeField.length > 0) code = codeField;
  else if (typeof errorField === 'string' && isJoinErrorCode(errorField)) code = errorField;
  else if (typeof errorField === 'string' && errorField.length > 0) code = errorField;
  else if (status === 503) code = JoinError.ShuttingDown;

  const message =
    (typeof messageField === 'string' && messageField.length > 0 && messageField) ||
    (typeof errorField === 'string' && errorField.length > 0 && errorField) ||
    (rawText.length > 0 ? rawText : `Matchmaking failed with HTTP ${status}`);

  return new JoinRejectedError({
    code: code ?? `http_${status}`,
    message,
    httpStatus: status,
    ...(typeof codeField === 'number' ? { serverCode: codeField } : {}),
    body: body ?? rawText,
  });
}
