import { describe, expect, it, vi } from 'vitest';
import { nullLogger } from '@survive/simulation';
import type { GameServer } from '../game/gameServer';
import {
  ADMIN_HEADER,
  adminCorsHeaders,
  handleResetRequest,
  isLoopbackAddress,
  isLoopbackOrigin,
  type AdminRequest,
} from './admin';

/**
 * Who may delete a world.
 *
 * Two gates: the peer's address must be loopback, and the request must carry the admin
 * header. The second one is the browser gate - a page on the internet can make your
 * browser POST to `127.0.0.1`, and that request arrives *from loopback* - so most of what
 * is checked here is the difference between "this machine" and "a page that reached this
 * machine through you".
 *
 * The end-to-end half - that a reset over a real socket actually empties a real save -
 * lives in `tests/multiplayer/worldReset.test.ts`.
 */

describe('isLoopbackAddress', () => {
  it('accepts loopback in every spelling Node hands out', () => {
    for (const address of [
      '127.0.0.1',
      // A dual-stack socket reports an IPv4 peer this way, and reading it as a hostname
      // rather than as an address is how a loopback check quietly stops accepting IPv4.
      '::ffff:127.0.0.1',
      '::1',
      // The rest of 127.0.0.0/8 is this machine too; `localhost` resolves into it.
      '127.0.0.53',
      '127.1.2.3',
    ]) {
      expect(isLoopbackAddress(address), address).toBe(true);
    }
  });

  it('refuses everything else, including addresses that merely look local', () => {
    for (const address of [
      '192.168.1.10',
      '10.0.0.5',
      // Private, and on the same wifi - which is exactly the case this exists to refuse.
      '172.16.4.2',
      '0.0.0.0',
      // Starts with the right digits and is a different machine entirely.
      '1270.0.0.1',
      '12.7.0.1',
      // A hostname is not an address; resolving one would be trusting DNS.
      'localhost',
      '',
      undefined,
    ]) {
      expect(isLoopbackAddress(address), String(address)).toBe(false);
    }
  });
});

/** A server stub that records whether the destructive part was reached. */
function fakeGame(overrides: Partial<GameServer> = {}): {
  game: GameServer;
  resetWorld: ReturnType<typeof vi.fn>;
} {
  const resetWorld = vi.fn(async () => {});
  const game = {
    canResetWorld: true,
    resetWorld,
    config: { saveName: 'test-world' },
    simulation: { state: { seed: 7 } },
    ...overrides,
  } as unknown as GameServer;
  return { game, resetWorld };
}

function request(
  remoteAddress: string | undefined,
  overrides: Partial<AdminRequest> = {},
): AdminRequest {
  return {
    headers: { [ADMIN_HEADER]: 'reset' },
    remoteAddress,
    ...overrides,
  };
}

describe('isLoopbackOrigin', () => {
  it('accepts the pages this client is actually served from', () => {
    for (const origin of [
      'http://localhost:5173',
      'http://127.0.0.1:4173',
      'http://[::1]:5173',
      'https://localhost:8443',
    ]) {
      expect(isLoopbackOrigin(origin), origin).toBe(true);
    }
  });

  it('refuses pages that only look like they are local', () => {
    for (const origin of [
      'http://evil.example',
      // The prefix trick: a hostname may start with anything and resolve anywhere.
      'http://localhost.evil.example',
      'http://127.0.0.1.evil.example',
      // A scheme with no origin to speak of.
      'file://',
      'null',
      '',
      undefined,
    ]) {
      expect(isLoopbackOrigin(origin), String(origin)).toBe(false);
    }
  });
});

/**
 * The preflight, which Colyseus answers on our behalf.
 *
 * It prepends a listener that replies to every OPTIONS on this port before any route runs,
 * so the only way to permit the admin header is to widen what that listener offers. These
 * check the widening: additive for a local page, and *not* additive for anyone else, which
 * is the difference between a CSRF gate and a decoration.
 */
describe('adminCorsHeaders', () => {
  const base = {
    'Access-Control-Allow-Headers': 'Origin, Content-Type',
    'Access-Control-Allow-Origin': '*',
  };

  it('permits the admin header for a page served from this machine', () => {
    const headers = adminCorsHeaders('http://localhost:5173', base);
    // Without the header named here the browser drops the POST before sending it, and the
    // lobby reports a server it cannot reach - on a server that is running fine.
    expect(headers['Access-Control-Allow-Headers']).toContain(ADMIN_HEADER);
    // And the wildcard is replaced: a wildcard here would be a wildcard for the header too.
    expect(headers['Access-Control-Allow-Origin']).toBe('http://localhost:5173');
  });

  it('offers a page from anywhere else exactly what it offered before', () => {
    // This is the gate. A page at evil.example asks whether it may send the admin header,
    // is not told yes, and so never sends the request - even though the request it wanted
    // to send would have arrived from loopback.
    expect(adminCorsHeaders('http://evil.example', base)).toEqual(base);
    // A request with no Origin is not a browser page, and gets no widening either.
    expect(adminCorsHeaders(undefined, base)).toEqual(base);
  });

  it("leaves matchmaking's own permissions alone", () => {
    const headers = adminCorsHeaders('http://localhost:5173', base);
    // Additive, not a replacement: a dedicated server's players are on other machines and
    // still have to be able to matchmake cross-origin.
    expect(headers['Access-Control-Allow-Headers']).toContain('Content-Type');
  });
});

describe('POST /admin/reset', () => {
  it('resets for a request from this machine', async () => {
    const { game, resetWorld } = fakeGame();
    const disconnectAll = vi.fn(async () => {});
    const bodies: Array<[number, Record<string, unknown> | null]> = [];

    const status = await handleResetRequest(
      { game, logger: nullLogger, disconnectAll },
      request('127.0.0.1'),
      (code, body) => bodies.push([code, body]),
    );

    expect(status).toBe(200);
    expect(resetWorld).toHaveBeenCalledOnce();
    // Players go first: a client left holding the old world's entity ids would write its
    // character back into the new save on the next autosave.
    expect(disconnectAll).toHaveBeenCalledBefore(resetWorld);
    expect(bodies[0]?.[1]).toMatchObject({ ok: true, world: 'test-world' });
  });

  it('refuses a request from anywhere else, without touching the world', async () => {
    const { game, resetWorld } = fakeGame();
    const disconnectAll = vi.fn(async () => {});

    const status = await handleResetRequest(
      { game, logger: nullLogger, disconnectAll },
      request('192.168.1.42'),
      () => {},
    );

    expect(status).toBe(403);
    expect(resetWorld).not.toHaveBeenCalled();
    // Not even the disconnect: a refused request must cost the other players nothing.
    expect(disconnectAll).not.toHaveBeenCalled();
  });

  it('says so rather than pretending, on a server built without a reset', async () => {
    const { game, resetWorld } = fakeGame({ canResetWorld: false } as Partial<GameServer>);

    const status = await handleResetRequest(
      { game, logger: nullLogger, disconnectAll: async () => {} },
      request('127.0.0.1'),
      () => {},
    );

    expect(status).toBe(501);
    expect(resetWorld).not.toHaveBeenCalled();
  });

  it('refuses a loopback request that carries no admin header', async () => {
    // This is the shape a cross-site attack takes: a page on the internet makes *your*
    // browser send the request, so it arrives from 127.0.0.1 and the address check passes.
    // A form post and a simple fetch both land here, and neither can set a header.
    const { game, resetWorld } = fakeGame();

    const status = await handleResetRequest(
      { game, logger: nullLogger, disconnectAll: async () => {} },
      request('127.0.0.1', { headers: { origin: 'http://evil.example' } }),
      () => {},
    );

    expect(status).toBe(403);
    expect(resetWorld).not.toHaveBeenCalled();
  });

  it('reports a failed reset instead of claiming success', async () => {
    const { game } = fakeGame({
      resetWorld: vi.fn(async () => {
        throw new Error('disk on fire');
      }),
    } as Partial<GameServer>);

    const status = await handleResetRequest(
      { game, logger: nullLogger, disconnectAll: async () => {} },
      request('127.0.0.1'),
      () => {},
    );

    expect(status).toBe(500);
  });
});
