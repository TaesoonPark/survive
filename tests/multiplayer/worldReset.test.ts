import { afterEach, describe, expect, it } from 'vitest';
import { createBot, createLiveServer, type Bot, type LiveServer } from '@survive/test-utils';

/**
 * Resetting the world over the wire, on the port the lobby already knows.
 *
 * The unit tests in `apps/server/src/net/admin.test.ts` decide *who* is allowed. These
 * check the part that only a real socket can show: that the route is reachable at all
 * next to Colyseus's own matchmaking routes, that the players are actually put out, and
 * that the save the reset promised to destroy is destroyed.
 */

let server: LiveServer | null = null;
let bots: Bot[] = [];

afterEach(async () => {
  for (const bot of bots) {
    try {
      await bot.leave();
    } catch {
      // Already gone - a reset disconnects them, which is the point.
    }
  }
  bots = [];
  await server?.stop();
  server = null;
});

/** What the lobby sends: the header is a CSRF gate, not a secret. */
async function reset(live: LiveServer): Promise<Response> {
  return fetch(`${live.url}/admin/reset`, {
    method: 'POST',
    headers: { 'x-survive-admin': 'reset' },
  });
}

describe('world reset', () => {
  it('answers on the matchmaking port, beside the routes Colyseus owns', async () => {
    server = await createLiveServer();

    // The premise: this is the same base URL a client matchmakes against. A reset on a
    // port the lobby cannot derive is a reset the player cannot reach.
    const matchmake = await fetch(`${server.url}/matchmake/joinOrCreate/survive`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(matchmake.status, 'colyseus still owns its own routes').toBeLessThan(500);

    const response = await reset(server);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true });
  });

  it('throws the characters away, not just the players', async () => {
    server = await createLiveServer();
    const bot = await createBot({ url: server.url, name: 'Alice' });
    bots.push(bot);

    const playerId = bot.playerId;
    const before = server.server.simulation.getPlayer(playerId);
    expect(before, 'the character exists before the reset').toBeDefined();
    // Move them off spawn, so "the character came back" cannot be confused with "a new
    // character happened to be created in the same place".
    before!.x += 512;
    await server.advance(20);

    const response = await reset(server);
    expect(response.status).toBe(200);

    expect(server.server.simulation.getPlayer(playerId)).toBeUndefined();
    expect(Object.keys(server.server.simulation.state.players)).toHaveLength(0);
    // And the save is gone, not merely the memory: reopening finds nothing to load.
    const repository = server.server.repository;
    expect(await repository.loadPlayer(playerId)).toBeNull();
  });

  it('leaves a running server, on a world that starts over', async () => {
    server = await createLiveServer();
    // A new world does not begin at tick zero - it begins at the configured hour of its
    // first morning - so what a reset has to restore is *this* number, read off a world
    // that has just been created rather than assumed to be any particular constant.
    const freshTick = server.server.simulation.state.tick;
    await server.advance(200);
    expect(server.server.simulation.state.tick).toBeGreaterThan(freshTick);

    await reset(server);

    expect(server.server.isRunning, 'the server keeps running through a reset').toBe(true);
    expect(server.server.simulation.state.tick).toBe(freshTick);
    expect(server.server.simulation.state.time.day).toBe(1);
    // The seed is kept: the same world name means the same ground. This is a reset, not
    // a reroll, and a player who liked their map does not lose it to a wiped save.
    expect(server.server.simulation.state.seed).toBe(server.config.world.seed);

    // And it is a live world, not a husk: it still advances.
    await server.advance(10);
    expect(server.server.simulation.state.tick).toBe(freshTick + 10);
  });

  it('lets a player join again afterwards, into the new world', async () => {
    server = await createLiveServer();
    const first = await createBot({ url: server.url, name: 'Alice' });
    bots.push(first);
    await reset(server);

    const second = await createBot({ url: server.url, name: 'Alice' });
    bots.push(second);
    expect(server.server.simulation.getPlayer(second.playerId)).toBeDefined();
  });
});
