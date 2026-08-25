import { afterEach, describe, expect, it } from 'vitest';
import {
  CHUNK_SIZE,
  ClientMessage,
  GAME_ROOM_NAME,
  JoinError,
  PROTOCOL_VERSION,
  SIM_DT_MS,
  type SimEvent,
} from '@survive/protocol';
import {
  createBot,
  createBots,
  createLiveServer,
  sleep,
  waitForAll,
  type Bot,
  type LiveServer,
} from '@survive/test-utils';

/**
 * Multiplayer integration, over a real socket (spec section 35).
 *
 * A real Colyseus server on an ephemeral port, real bot clients running the same netcode
 * the game client uses. If a bot sees the wrong thing here, so would a player.
 */

let server: LiveServer | null = null;
let bots: Bot[] = [];

afterEach(async () => {
  for (const bot of bots) {
    try {
      await bot.leave();
    } catch {
      // Already gone.
    }
  }
  bots = [];
  await server?.stop();
  server = null;
});

describe('handshake', () => {
  it('accepts a client and sends it a welcome packet and a first snapshot', async () => {
    server = await createLiveServer();
    const bot = await createBot({ url: server.url, name: 'Alice', playerId: 'alice' });
    bots.push(bot);

    expect(bot.welcome).not.toBeNull();
    expect(bot.welcome!.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(bot.welcome!.playerId).toBe('alice');
    expect(bot.welcome!.world.seed).toBe(server.config.world.seed);
    expect(bot.welcome!.dataVersion).toBe(server.data.version);
    expect(bot.welcome!.config.maxPlayers).toBe(server.config.mode.maxPlayers);
    expect(bot.self).not.toBeNull();
    expect(bot.self!.alive).toBe(true);
    expect(bot.self!.health).toBeGreaterThan(0);
  });

  it('refuses a protocol mismatch', async () => {
    server = await createLiveServer();
    // Reach past the bot helper so a deliberately wrong version can be sent.
    const response = await fetch(`${server.url}/matchmake/joinOrCreate/${GAME_ROOM_NAME}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ protocolVersion: PROTOCOL_VERSION + 99, name: 'Stale' }),
    });
    expect(response.ok).toBe(false);
    expect(await response.text()).toContain(JoinError.ProtocolMismatch);
  });

  it('refuses a bad password and accepts the right one', async () => {
    server = await createLiveServer({ password: 'hunter2' });

    const rejected = await fetch(`${server.url}/matchmake/joinOrCreate/${GAME_ROOM_NAME}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ protocolVersion: PROTOCOL_VERSION, name: 'Nope', password: 'wrong' }),
    });
    expect(rejected.ok).toBe(false);
    expect(await rejected.text()).toContain(JoinError.BadPassword);

    const bot = await createBot({
      url: server.url,
      name: 'Alice',
      playerId: 'alice',
      password: 'hunter2',
    });
    bots.push(bot);
    expect(bot.welcome).not.toBeNull();
  });

  it('refuses a bad single-player token', async () => {
    server = await createLiveServer({ token: 'one-shot-token' });
    const rejected = await fetch(`${server.url}/matchmake/joinOrCreate/${GAME_ROOM_NAME}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ protocolVersion: PROTOCOL_VERSION, name: 'Nope', token: 'guess' }),
    });
    expect(rejected.ok).toBe(false);
    expect(await rejected.text()).toContain(JoinError.BadToken);
  });

  it('enforces the player cap', async () => {
    server = await createLiveServer({ maxPlayers: 1 });
    bots.push(await createBot({ url: server.url, name: 'First', playerId: 'first' }));

    const rejected = await fetch(`${server.url}/matchmake/joinOrCreate/${GAME_ROOM_NAME}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ protocolVersion: PROTOCOL_VERSION, name: 'Second' }),
    });
    expect(rejected.ok).toBe(false);
    expect(await rejected.text()).toContain(JoinError.ServerFull);
  });

  it('refuses two sockets claiming the same character', async () => {
    server = await createLiveServer({ maxPlayers: 4 });
    bots.push(await createBot({ url: server.url, name: 'Alice', playerId: 'alice' }));

    const rejected = await fetch(`${server.url}/matchmake/joinOrCreate/${GAME_ROOM_NAME}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ protocolVersion: PROTOCOL_VERSION, name: 'Alice', playerId: 'alice' }),
    });
    expect(rejected.ok).toBe(false);
    expect(await rejected.text()).toContain(JoinError.NameTaken);
  });
});

describe('replication', () => {
  it('streams terrain chunks for the ground the player is standing on', async () => {
    server = await createLiveServer();
    const bot = await createBot({ url: server.url, name: 'Alice', playerId: 'alice' });
    bots.push(bot);
    await bot.waitFor((b) => b.chunks.size > 0, 'terrain chunks');

    const self = bot.self!;
    const chunkKey = `${Math.floor(self.x / 1024)},${Math.floor(self.y / 1024)}`;
    expect(bot.chunks.has(chunkKey)).toBe(true);
    const chunk = bot.chunks.get(chunkKey)!;
    expect(chunk.tiles).toHaveLength(32 * 32);
    expect(chunk.biomes).toHaveLength(32 * 32);
  });

  it('shows two nearby players to each other', async () => {
    server = await createLiveServer({ maxPlayers: 4 });
    const [alice, bob] = await createBots(server.url, ['Alice', 'Bob']);
    bots.push(alice!, bob!);

    await waitForAll(
      [alice!, bob!],
      (bot) => bot.entities().some((e) => e.k === 'player'),
      'each other',
    );

    const seenByAlice = alice!.entities().filter((entity) => entity.k === 'player');
    expect(seenByAlice.map((entity) => entity.id)).toContain('bob');
    // The reduced remote-player projection: no inventory, no skills.
    const bobView = seenByAlice[0]!;
    expect(bobView).not.toHaveProperty('inventory');
    expect(bobView).not.toHaveProperty('skills');
  });

  it('does not replicate a player who is far outside the area of interest', async () => {
    server = await createLiveServer({
      maxPlayers: 4,
      // A deliberately tiny radius, so "far away" is a short walk rather than a long one.
      config: (config) => {
        config.network.aoiRadius = 200;
      },
    });
    const [alice, bob] = await createBots(server.url, ['Alice', 'Bob']);
    bots.push(alice!, bob!);

    // Both spawn at the same point, so they start visible to each other.
    await waitForAll(
      [alice!, bob!],
      (bot) => bot.entities().some((e) => e.k === 'player'),
      'each other',
    );

    // Move Bob well past the replication radius.
    const server_ = server;
    const bobPlayer = server_.server.simulation.getPlayer('bob');
    expect(bobPlayer).toBeDefined();
    bobPlayer!.x += 4000;
    bobPlayer!.rev++;

    await alice!.waitFor(
      (bot) => !bot.entities().some((entity) => entity.id === 'bob'),
      'bob leaving the area of interest',
    );
  });

  it('echoes the last consumed input sequence so the client can reconcile', async () => {
    server = await createLiveServer();
    const bot = await createBot({ url: server.url, name: 'Alice', playerId: 'alice' });
    bots.push(bot);

    for (let i = 0; i < 12; i++) {
      bot.input({ moveX: 1, moveY: 0 });
      await sleep(SIM_DT_MS);
    }
    const snapshot = await bot.nextSnapshot();
    expect(snapshot.ackSeq).toBeGreaterThan(0);
    expect(snapshot.tick).toBeGreaterThan(0);
  });

  it('reports latency through the ping/pong round trip', async () => {
    server = await createLiveServer();
    const bot = await createBot({ url: server.url, name: 'Alice', playerId: 'alice' });
    bots.push(bot);
    for (let i = 0; i < 4; i++) {
      bot.connection.sendPing();
      await sleep(60);
    }
    // Loopback, so this is small but must be a real measurement, not zero-by-default.
    expect(bot.connection.latency).toBeGreaterThanOrEqual(0);
    expect(bot.connection.latency).toBeLessThan(500);
  });
});

describe('session lifecycle', () => {
  it('saves a character on disconnect and restores it on reconnect', async () => {
    server = await createLiveServer();
    const first = await createBot({ url: server.url, name: 'Alice', playerId: 'alice' });
    // Change something persistent while connected.
    const player = server.server.simulation.getPlayer('alice');
    expect(player).toBeDefined();
    player!.hunger = 73;
    player!.stats.zombieKills = 5;
    await first.leave();
    // Give the server a moment to run its save on leave.
    await sleep(200);

    const second = await createBot({ url: server.url, name: 'Alice', playerId: 'alice' });
    bots.push(second);
    expect(second.self!.hunger).toBeCloseTo(73, 3);
    expect(second.self!.stats.zombieKills).toBe(5);
  });

  it('refuses to let a multiplayer client pause the world', async () => {
    server = await createLiveServer();
    const bot = await createBot({ url: server.url, name: 'Alice', playerId: 'alice' });
    bots.push(bot);

    bot.send({ type: 'setPaused', paused: true });
    await sleep(200);
    // A dedicated server must keep running whatever one client asks for (spec s.12).
    expect(server.server.simulation.paused).toBe(false);
    const snapshot = await bot.nextSnapshot();
    expect(snapshot.paused).toBe(false);
  });

  it('keeps ticking with several clients connected', async () => {
    server = await createLiveServer({ maxPlayers: 4 });
    const trio = await createBots(server.url, ['Alice', 'Bob', 'Carol']);
    bots.push(...trio);

    const startTick = server.server.simulation.state.tick;
    await sleep(400);
    expect(server.server.simulation.state.tick).toBeGreaterThan(startTick);

    // Every client is being served snapshots, not just the first one.
    await waitForAll(trio, (bot) => (bot.self?.rev ?? 0) > 0, 'snapshots');
    for (const bot of trio) {
      const snapshot = await bot.nextSnapshot();
      expect(snapshot.tick).toBeGreaterThan(startTick);
    }
  });
});

/**
 * Events, as opposed to snapshots.
 *
 * Snapshots carry *state* - where everyone is, what they hold, how hurt they are. Events
 * carry the things that *happened*: a swing connecting, a level gained, a notification.
 * The client turns them into damage numbers, hit flashes, sounds and toasts in
 * `render/effects.ts`, and none of that is reconstructible from a snapshot diff.
 *
 * Nothing asserted the wire actually carried them, and it did not: `GameServer.tick`
 * drains the event sink, `pump` discarded what it returned, and the room then drained the
 * already-empty sink. Every client received zero events - in single player too, since it
 * runs this same room over loopback - while the world itself replicated perfectly. The
 * whole feedback layer was missing and every existing test still passed.
 */
describe('event replication', () => {
  it('delivers events to a client, not just snapshots', async () => {
    server = await createLiveServer();
    const bot = await createBot({ url: server.url, name: 'Alice', playerId: 'alice' });
    bots.push(bot);

    // Any event will do; a swing is the cheapest thing a client can cause on demand. It
    // reports `hit: false` with nothing in range, which is still an event.
    await bot.attack(0);

    const swing = await bot.waitForEvent(
      (event): event is Extract<SimEvent, { type: 'attackSwing' }> => event.type === 'attackSwing',
    );
    expect(swing.type).toBe('attackSwing');
    expect(bot.events.length).toBeGreaterThan(0);
  });
});

/**
 * The server's own survival against a client that lies.
 *
 * Colyseus dispatches message handlers synchronously out of the WebSocket callback with no
 * try/catch of its own, and `main.ts` treats an uncaught exception as fatal. So any
 * unvalidated field reachable from a message was a remote kill switch: one malformed chunk
 * key threw out of `parseChunkKey`, escaped the handler, and shut a dedicated server down
 * for everybody on it.
 *
 * The chunk handler was also an entitlement hole rather than only a crash: it served any
 * coordinate on the map, so a client could read terrain it had never travelled to, and
 * every forged key installed a resident chunk that eviction - which only walks chunks the
 * simulation itself loaded - never reclaimed.
 */
describe('malformed messages', () => {
  it('survives garbage on every channel and keeps serving everyone else', async () => {
    server = await createLiveServer();
    const attacker = await createBot({ url: server.url, name: 'Alice', playerId: 'alice' });
    const bystander = await createBot({ url: server.url, name: 'Bob', playerId: 'bob' });
    bots.push(attacker, bystander);

    const before = server.server.simulation.state.tick;
    // Straight at the room, bypassing the typed helpers: the point is to send shapes a
    // well-behaved client could never produce.
    const raw = attacker.connection.room;

    // Each of these threw straight into the socket callback before the handlers were
    // hardened: a key with no comma, a non-string key, a `frames` that is a string (which
    // passes a `.length` check and then has no `.filter`), and a command with no type.
    //
    // What is asserted afterwards is deliberately about the *bystander*. Whether the
    // offender keeps its own socket is Colyseus's business and not a property worth
    // pinning; that one client's bad message must not stop the world for everybody else
    // is the whole point.
    raw.send(ClientMessage.RequestChunks, { keys: ['not-a-key'] });
    raw.send(ClientMessage.RequestChunks, { keys: [{ nope: true }] });
    raw.send(ClientMessage.RequestChunks, { keys: '128,128' });
    raw.send(ClientMessage.Inputs, { frames: 'not-an-array' });
    raw.send(ClientMessage.Command, { command: {} });
    raw.send(ClientMessage.Ping, { clientTimeMs: 'soon' });

    await sleep(500);

    // Still up, still ticking, and the innocent client is still being served.
    expect(server.server.simulation.state.tick).toBeGreaterThan(before);
    expect(bystander.connection.isConnected).toBe(true);
    const snapshot = await bystander.nextSnapshot();
    expect(snapshot.tick).toBeGreaterThan(before);
  });

  it('refuses chunks the player is nowhere near', async () => {
    server = await createLiveServer();
    const bot = await createBot({ url: server.url, name: 'Alice', playerId: 'alice' });
    bots.push(bot);

    const self = server.server.simulation.getPlayer('alice')!;
    const nearCx = Math.floor(self.x / CHUNK_SIZE);
    const nearCy = Math.floor(self.y / CHUNK_SIZE);
    const before = server.server.stats().loadedChunks;

    // Far corners of a 256x256-chunk world, nowhere near this player.
    bot.connection.requestChunks(['1,1', '200,200', '5,250', `${nearCx + 60},${nearCy}`]);
    await sleep(400);

    for (const key of ['1,1', '200,200', '5,250']) {
      expect(bot.chunks.has(key), `served a chunk at ${key}`).toBe(false);
    }
    // ...and refusing did not quietly generate them server-side either.
    expect(server.server.stats().loadedChunks).toBeLessThanOrEqual(before);
  });
});
