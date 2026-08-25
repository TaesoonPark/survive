import { describe, expect, it } from 'vitest';
import {
  ClientMessage,
  GAME_ROOM_NAME,
  JoinError,
  PROTOCOL_VERSION,
  SIM_DT_MS,
  ServerMessage,
} from '@survive/protocol';
import type { JoinOptions } from '@survive/protocol';
import {
  JoinRejectedError,
  connectToServer,
  nestSeatReservation,
  parseFlatSeatReservation,
  toHttpUrl,
} from './connection';
import type {
  ConnectOptions,
  FetchLike,
  FetchLikeResponse,
  NestedSeatReservation,
  RoomLike,
  SeatConsumingClient,
} from './connection';

/**
 * These tests never start a server: they inject a fake `fetch` and a fake Colyseus
 * client, which is exactly what makes the 0.17-flat/0.16-nested reservation fix-up
 * (see AGENTS.md) checkable without a network. Real end-to-end joins belong to the
 * multiplayer suite.
 */

const FLAT_RESERVATION = {
  name: GAME_ROOM_NAME,
  sessionId: 'sess-1',
  roomId: 'room-1',
  processId: 'proc-1',
};

const JOIN: JoinOptions = { protocolVersion: PROTOCOL_VERSION, name: 'Alice' };

class FakeRoom implements RoomLike {
  sessionId = 'sess-1';
  roomId = 'room-1';
  readonly sent: Array<{ type: string; message: unknown }> = [];
  readonly leaveCalls: boolean[] = [];

  private readonly handlers = new Map<string, (message: unknown) => void>();
  private readonly leaveHandlers: Array<(code: number, reason?: string) => void> = [];
  private readonly errorHandlers: Array<(code: number, message?: string) => void> = [];

  onMessage<T>(type: string, callback: (message: T) => void): unknown {
    this.handlers.set(type, callback as (message: unknown) => void);
    return undefined;
  }

  send(type: string, message?: unknown): void {
    this.sent.push({ type, message });
  }

  async leave(consented = true): Promise<number> {
    this.leaveCalls.push(consented);
    return 1000;
  }

  onLeave(callback: (code: number, reason?: string) => void): unknown {
    this.leaveHandlers.push(callback);
    return undefined;
  }

  onError(callback: (code: number, message?: string) => void): unknown {
    this.errorHandlers.push(callback);
    return undefined;
  }

  emit(type: string, message: unknown): void {
    const handler = this.handlers.get(type);
    if (!handler) throw new Error(`no handler registered for "${type}"`);
    handler(message);
  }

  emitLeave(code: number, reason?: string): void {
    for (const handler of this.leaveHandlers) handler(code, reason);
  }

  emitError(code: number, message?: string): void {
    for (const handler of this.errorHandlers) handler(code, message);
  }
}

function response(status: number, body: unknown): FetchLikeResponse {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
  };
}

interface Harness {
  room: FakeRoom;
  calls: Array<{ url: string; init?: Parameters<FetchLike>[1] }>;
  consumed: NestedSeatReservation[];
  options: ConnectOptions;
}

function harness(
  body: unknown = FLAT_RESERVATION,
  status = 200,
  extra: Partial<ConnectOptions> = {},
): Harness {
  const room = new FakeRoom();
  const calls: Harness['calls'] = [];
  const consumed: NestedSeatReservation[] = [];

  const fakeFetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return response(status, body);
  };
  const client: SeatConsumingClient = {
    async consumeSeatReservation(reservation) {
      consumed.push(reservation);
      return room;
    },
  };

  return {
    room,
    calls,
    consumed,
    options: {
      url: 'ws://127.0.0.1:27500',
      join: JOIN,
      fetch: fakeFetch,
      createClient: () => client,
      ...extra,
    },
  };
}

describe('toHttpUrl', () => {
  it('maps websocket schemes onto their http equivalents', () => {
    expect(toHttpUrl('ws://127.0.0.1:27500')).toBe('http://127.0.0.1:27500');
    expect(toHttpUrl('wss://play.example.com')).toBe('https://play.example.com');
    expect(toHttpUrl('http://localhost:2567')).toBe('http://localhost:2567');
  });

  it('keeps a path prefix but strips the trailing slash', () => {
    expect(toHttpUrl('ws://example.com:80/game/')).toBe('http://example.com/game');
  });
});

describe('nestSeatReservation', () => {
  it('re-nests a flat 0.17 reservation into the shape 0.16 consumes', () => {
    expect(nestSeatReservation(FLAT_RESERVATION)).toEqual({
      room: { name: GAME_ROOM_NAME, roomId: 'room-1', processId: 'proc-1' },
      sessionId: 'sess-1',
    });
  });

  it('carries publicAddress through, because it picks the websocket host', () => {
    const nested = nestSeatReservation({ ...FLAT_RESERVATION, publicAddress: 'edge.example:2567' });
    expect(nested.room.publicAddress).toBe('edge.example:2567');
  });

  it('omits absent optional fields rather than setting them to undefined', () => {
    // They end up as websocket query parameters; an explicit undefined would be
    // serialized as the string "undefined".
    const nested = nestSeatReservation(FLAT_RESERVATION);
    expect(Object.keys(nested.room)).toEqual(['name', 'roomId', 'processId']);
    expect(Object.keys(nested)).toEqual(['room', 'sessionId']);
  });

  it('forwards reconnection and transport hints when present', () => {
    const nested = nestSeatReservation({
      ...FLAT_RESERVATION,
      reconnectionToken: 'tok',
      protocol: 'h3',
      devMode: true,
    });
    expect(nested.reconnectionToken).toBe('tok');
    expect(nested.protocol).toBe('h3');
    expect(nested.devMode).toBe(true);
  });
});

describe('parseFlatSeatReservation', () => {
  it('rejects a body that is not a seat reservation', () => {
    expect(() => parseFlatSeatReservation({ roomId: 'r' }, GAME_ROOM_NAME)).toThrow(
      JoinRejectedError,
    );
    expect(() => parseFlatSeatReservation('nope', GAME_ROOM_NAME)).toThrow(/not an object/);
  });

  it('falls back to the requested room name', () => {
    const flat = parseFlatSeatReservation(
      { sessionId: 's', roomId: 'r', processId: 'p' },
      GAME_ROOM_NAME,
    );
    expect(flat.name).toBe(GAME_ROOM_NAME);
  });

  it('drops fields of the wrong type instead of forwarding them', () => {
    const flat = parseFlatSeatReservation(
      { sessionId: 's', roomId: 'r', processId: 'p', publicAddress: 42 },
      GAME_ROOM_NAME,
    );
    expect(flat.publicAddress).toBeUndefined();
  });
});

describe('connectToServer matchmaking', () => {
  it('POSTs the join options and consumes the re-nested reservation', async () => {
    const { options, calls, consumed } = harness();
    const connection = await connectToServer(options);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`http://127.0.0.1:27500/matchmake/joinOrCreate/${GAME_ROOM_NAME}`);
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.headers?.['Content-Type']).toBe('application/json');
    expect(JSON.parse(calls[0]?.init?.body ?? 'null')).toEqual(JOIN);

    expect(consumed).toEqual([
      {
        room: { name: GAME_ROOM_NAME, roomId: 'room-1', processId: 'proc-1' },
        sessionId: 'sess-1',
      },
    ]);
    expect(connection.sessionId).toBe('sess-1');
    expect(connection.isConnected).toBe(true);
  });

  it('honours an explicit room name and matchmake method', async () => {
    const { options, calls } = harness({ ...FLAT_RESERVATION, name: 'other' }, 200, {
      roomName: 'other',
      method: 'create',
    });
    await connectToServer(options);

    expect(calls[0]?.url).toBe('http://127.0.0.1:27500/matchmake/create/other');
  });

  it('rejects with the server JoinError code from a non-2xx body', async () => {
    const { options } = harness({ error: JoinError.BadPassword, code: 4215 }, 401);

    await expect(connectToServer(options)).rejects.toMatchObject({
      name: 'JoinRejectedError',
      code: JoinError.BadPassword,
      httpStatus: 401,
      serverCode: 4215,
    });
  });

  it('prefers an explicit protocol code and message', async () => {
    const { options } = harness(
      { code: JoinError.ServerFull, message: 'Server is full (16/16)' },
      403,
    );

    const error = await connectToServer(options).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(JoinRejectedError);
    expect(error).toMatchObject({
      code: JoinError.ServerFull,
      message: 'Server is full (16/16)',
    });
    expect((error as JoinRejectedError).isProtocolRefusal).toBe(true);
  });

  it('rejects a 200 that carries an error field, as Colyseus sometimes sends', async () => {
    const { options } = harness({ error: JoinError.ProtocolMismatch }, 200);

    await expect(connectToServer(options)).rejects.toMatchObject({
      code: JoinError.ProtocolMismatch,
      httpStatus: 200,
    });
  });

  it('falls back to the HTTP status for a non-JSON failure', async () => {
    const { options } = harness('Bad Gateway', 502);

    const error = await connectToServer(options).catch((cause: unknown) => cause);
    expect(error).toMatchObject({ code: 'http_502', message: 'Bad Gateway' });
    expect((error as JoinRejectedError).isProtocolRefusal).toBe(false);
  });

  it('rejects a reservation that is missing the fields 0.16 needs', async () => {
    const { options } = harness({ sessionId: 'sess-1' }, 200);

    await expect(connectToServer(options)).rejects.toMatchObject({
      code: 'malformed_reservation',
    });
  });

  it('maps the bodyless 503 a shutting-down matchmaker sends onto shutting_down', async () => {
    // @colyseus/core answers `throw ctx.error(503)` while the matchmaker is shutting
    // down: no code, no error field, nothing but the status.
    const { options } = harness('', 503);

    const error = await connectToServer(options).catch((cause: unknown) => cause);
    expect(error).toMatchObject({ code: JoinError.ShuttingDown, httpStatus: 503 });
    expect((error as JoinRejectedError).isProtocolRefusal).toBe(true);
  });

  it('reports an unreachable server as a JoinRejectedError, not a raw fetch error', async () => {
    const cause = new TypeError('fetch failed');
    const { options } = harness();
    const failing: ConnectOptions = {
      ...options,
      fetch: () => Promise.reject(cause),
    };

    const error = await connectToServer(failing).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(JoinRejectedError);
    expect(error).toMatchObject({ code: 'network_error', httpStatus: 0 });
    expect((error as JoinRejectedError).isProtocolRefusal).toBe(false);
    expect((error as Error).cause).toBe(cause);
  });

  it('reports a matchmaking timeout under its own code', async () => {
    const aborted = new Error('The operation was aborted');
    aborted.name = 'AbortError';
    const { options } = harness();
    const failing: ConnectOptions = { ...options, fetch: () => Promise.reject(aborted) };

    await expect(connectToServer(failing)).rejects.toMatchObject({
      code: 'matchmake_timeout',
      httpStatus: 0,
    });
  });
});

describe('ServerConnection messaging', () => {
  it('routes every server message to its callback', async () => {
    const seen: string[] = [];
    const { options, room } = harness(FLAT_RESERVATION, 200, {
      onWelcome: () => seen.push('welcome'),
      onSnapshot: () => seen.push('snapshot'),
      onChunk: () => seen.push('chunk'),
      onChunkDrop: () => seen.push('chunkdrop'),
      onEvents: () => seen.push('events'),
      onPong: () => seen.push('pong'),
      onKick: () => seen.push('kick'),
      onError: () => seen.push('error'),
    });
    const connection = await connectToServer(options);

    room.emit(ServerMessage.Welcome, welcome());
    room.emit(ServerMessage.Snapshot, { tick: 5, serverTimeMs: 250 });
    room.emit(ServerMessage.Chunk, { key: '0,0' });
    room.emit(ServerMessage.ChunkDrop, { keys: ['0,0'] });
    room.emit(ServerMessage.Events, { tick: 5, events: [] });
    room.emit(ServerMessage.Pong, { clientTimeMs: 0, serverTimeMs: 250, tick: 5 });
    room.emit(ServerMessage.Kick, { reason: 'banned' });
    room.emit(ServerMessage.Error, { code: 'oops', message: 'bad' });

    expect(seen).toEqual([
      'welcome',
      'snapshot',
      'chunk',
      'chunkdrop',
      'events',
      'pong',
      'kick',
      'error',
    ]);
    expect(connection.welcome?.playerId).toBe('alice');
  });

  it('routes transport errors onto the same error channel', async () => {
    const errors: Array<{ code: string; message: string }> = [];
    const { options, room } = harness(FLAT_RESERVATION, 200, {
      onError: (payload) => errors.push(payload),
    });
    await connectToServer(options);

    room.emitError(4213, 'matchmake unhandled');
    expect(errors).toEqual([{ code: '4213', message: 'matchmake unhandled' }]);
  });

  it('sends typed client messages', async () => {
    const { options, room } = harness();
    const connection = await connectToServer(options);

    connection.sendInputs([{ seq: 1, moveX: 1, moveY: 0, aimAngle: 0, buttons: 0 }]);
    connection.sendCommand({ type: 'selectHotbar', index: 2 });
    connection.requestChunks(['0,0', '0,1']);

    expect(room.sent).toEqual([
      {
        type: ClientMessage.Inputs,
        message: { frames: [{ seq: 1, moveX: 1, moveY: 0, aimAngle: 0, buttons: 0 }] },
      },
      { type: ClientMessage.Command, message: { command: { type: 'selectHotbar', index: 2 } } },
      { type: ClientMessage.RequestChunks, message: { keys: ['0,0', '0,1'] } },
    ]);
  });

  it('does not send empty input or chunk batches', async () => {
    const { options, room } = harness();
    const connection = await connectToServer(options);

    connection.sendInputs([]);
    connection.requestChunks([]);

    expect(room.sent).toEqual([]);
  });

  it('stops sending once the room has closed', async () => {
    const disconnects: Array<{ code: number; reason?: string }> = [];
    const { options, room } = harness(FLAT_RESERVATION, 200, {
      onDisconnect: (code, reason) => disconnects.push({ code, reason }),
    });
    const connection = await connectToServer(options);

    room.emitLeave(4001, 'kicked');

    expect(connection.isConnected).toBe(false);
    expect(disconnects).toEqual([{ code: 4001, reason: 'kicked' }]);

    connection.sendPing();
    connection.sendCommand({ type: 'wake' });
    expect(room.sent).toEqual([]);
  });

  it('leaves once and marks itself disconnected', async () => {
    const { options, room } = harness();
    const connection = await connectToServer(options);

    await connection.leave();
    await connection.leave();

    expect(room.leaveCalls).toEqual([true]);
    expect(connection.isConnected).toBe(false);
  });
});

describe('ServerConnection clock estimates', () => {
  function clockHarness(extra: Partial<ConnectOptions> = {}) {
    let now = 0;
    const built = harness(FLAT_RESERVATION, 200, {
      clockOptions: { now: () => now, smoothing: 0.5 },
      ...extra,
    });
    return {
      ...built,
      advance(ms: number) {
        now += ms;
      },
      at(ms: number) {
        now = ms;
      },
    };
  }

  it('estimates the server tick from the welcome and local time', async () => {
    const h = clockHarness();
    const connection = await connectToServer(h.options);

    h.room.emit(ServerMessage.Welcome, welcome({ tick: 100, serverTimeMs: 5000 }));
    expect(connection.serverTickEstimate).toBeCloseTo(100, 6);

    h.advance(SIM_DT_MS * 4);
    expect(connection.serverTickEstimate).toBeCloseTo(104, 6);
  });

  it('measures round trips and smooths the latency estimate', async () => {
    const h = clockHarness();
    const connection = await connectToServer(h.options);
    h.room.emit(ServerMessage.Welcome, welcome({ tick: 0, serverTimeMs: 0 }));

    connection.sendPing();
    const firstPing = h.room.sent[0]?.message as { clientTimeMs: number };
    expect(firstPing.clientTimeMs).toBe(0);
    h.at(100);
    h.room.emit(ServerMessage.Pong, { clientTimeMs: 0, serverTimeMs: 50, tick: 1 });
    // First sample is taken whole: there is nothing to blend it with.
    expect(connection.latency).toBeCloseTo(100, 6);

    connection.sendPing();
    h.at(400);
    h.room.emit(ServerMessage.Pong, { clientTimeMs: 100, serverTimeMs: 200, tick: 4 });
    // smoothing 0.5 over a 300 ms round trip: 100 + (300 - 100) * 0.5.
    expect(connection.latency).toBeCloseTo(200, 6);
  });

  it('shares one clock with the rest of the client when given one', async () => {
    const h = clockHarness();
    const connection = await connectToServer(h.options);
    h.room.emit(ServerMessage.Welcome, welcome({ tick: 40, serverTimeMs: 2000 }));

    expect(connection.clock.tick).toBe(40);
    expect(connection.clock.interpolationAlpha).toBeCloseTo(0, 6);
    h.advance(SIM_DT_MS / 4);
    expect(connection.clock.interpolationAlpha).toBeCloseTo(0.25, 6);
  });

  it('keeps the tick estimate locked to incoming snapshots', async () => {
    const h = clockHarness();
    const connection = await connectToServer(h.options);
    h.room.emit(ServerMessage.Welcome, welcome({ tick: 0, serverTimeMs: 0 }));

    // Local time runs on, but the server is not where extrapolation says.
    h.at(1000);
    h.room.emit(ServerMessage.Snapshot, { tick: 30, serverTimeMs: 1500 });

    // Extrapolation said 20 ticks, the snapshot says 30; smoothing 0.5 splits it.
    expect(connection.serverTickEstimate).toBeCloseTo(25, 6);
    expect(connection.clock.driftTicks).toBeCloseTo(10, 6);
  });
});

function welcome(overrides: { tick?: number; serverTimeMs?: number } = {}) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    playerId: 'alice',
    tick: overrides.tick ?? 0,
    serverTimeMs: overrides.serverTimeMs ?? 0,
    world: {
      name: 'world01',
      seed: 1337,
      tileSize: 32,
      chunkTiles: 32,
      worldChunks: 256,
      createdTick: 0,
    },
    config: {
      singlePlayer: false,
      maxPlayers: 16,
      pvp: true,
      cheatsEnabled: false,
      simHz: 20,
      snapshotHz: 10,
      canPause: false,
    },
    dataVersion: 'abc123',
    onlinePlayers: [],
  };
}
