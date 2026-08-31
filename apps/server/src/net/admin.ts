import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Logger } from '@survive/simulation';
import type { GameServer } from '../game/gameServer';

/**
 * The one destructive thing a client may ask of a server: throw the world away.
 *
 * This lives on the matchmaking port rather than on the status server because the lobby
 * only ever knows one address - the one the player typed - and a reset the player cannot
 * find is not a feature. It is a plain HTTP route rather than a room command because the
 * lobby has not joined anything yet; asking someone to enter a world in order to delete
 * it is a strange order of events, and after a reset there would be nothing to leave.
 *
 * ## Who is allowed
 *
 * Two gates, and both have to open.
 *
 * **The peer address must be loopback.** Not a password, not a flag. The person sitting at
 * the machine running the server is the only one who can be assumed to own the save - a
 * join password is an *entry* credential, and everyone who has one would otherwise be able
 * to delete everyone else's world. A remote attacker cannot spoof this, because a spoofed
 * source address never completes the TCP handshake and so never sends a request at all.
 *
 * **The request must carry {@link ADMIN_HEADER}.** This is not a secret - it is a CSRF
 * defence. Address checks alone do not survive a browser: any page on the internet can
 * make your browser POST to `127.0.0.1`, and that request arrives *from loopback* because
 * your machine sent it. The attacker never sees the response, which is no comfort at all
 * when the response is "your world is gone". Requiring a header the fetch spec calls
 * non-simple forces a CORS preflight, and {@link adminCorsHeaders} permits that header
 * only for a loopback origin - so a page at `evil.example` is stopped by its own browser
 * before the POST is ever sent, and a `<form>` post, which cannot set a header at all,
 * never gets past this gate.
 *
 * The preflight itself is not ours to answer. Colyseus *prepends* a request listener that
 * replies to every `OPTIONS` on this port with its own CORS headers, before any route sees
 * it - so a preflight route of our own would never run, and a second listener answering
 * after it would be writing headers onto a response that had already ended. Instead we
 * widen the headers Colyseus offers, through the hook it documents for the purpose.
 *
 * An untrusted *program* on the same machine could still call this. That is a boundary
 * this codebase does not defend anywhere else either - such a program could simply delete
 * the save directory - so nothing is being given away.
 */

/** Required on every admin request. Its value is ignored; its presence is the point. */
export const ADMIN_HEADER = 'x-survive-admin';

/** Loopback in all the spellings Node hands out. */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  // Node reports an IPv4 peer on a dual-stack socket as `::ffff:127.0.0.1`.
  const bare = address.startsWith('::ffff:') ? address.slice(7) : address;
  if (bare === '::1') return true;
  // The whole 127.0.0.0/8 block, not just 127.0.0.1: `localhost` resolves elsewhere in it
  // on some systems, and every address in it is by definition this machine.
  const parts = bare.split('.');
  if (parts.length !== 4) return false;
  if (!parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)) return false;
  return parts[0] === '127';
}

/**
 * Whether a browser origin may talk to this route.
 *
 * The client is served from a dev server or a file on the same machine, so its origin is
 * loopback on some other port. Anything else is a page that has no business here, and
 * refusing it at the preflight is what stops the request from ever being sent.
 */
export function isLoopbackOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const host = parsed.hostname;
  if (host === 'localhost' || host === '[::1]' || host === '::1') return true;
  return isLoopbackAddress(host);
}

export interface AdminRouteOptions {
  game: GameServer;
  logger: Logger;
  /** Get the players off before the world under them is deleted. */
  disconnectAll: () => Promise<unknown>;
}

/** The parts of a request this route reads. Narrow, so a test does not have to fake a socket. */
export interface AdminRequest {
  headers: Record<string, string | string[] | undefined>;
  remoteAddress: string | undefined;
}

export type Respond = (
  status: number,
  body: Record<string, unknown> | null,
  headers?: Record<string, string>,
) => void;

/**
 * Widen Colyseus's CORS headers, but only for a page served from this machine.
 *
 * Merged over whatever Colyseus already offers, so matchmaking from a remote origin keeps
 * working exactly as before - a dedicated server's players are on other machines, and
 * breaking their `Access-Control-Allow-Origin: *` to protect a local button would be a
 * poor trade. What changes for a loopback origin, and only for one, is that the admin
 * header becomes permitted. That is the whole CSRF gate: a page anywhere else asks for
 * permission to send it, is not given it, and never sends the request.
 */
export function adminCorsHeaders(
  origin: string | undefined,
  base: Record<string, string>,
): Record<string, string> {
  if (!isLoopbackOrigin(origin)) return base;
  const allowed = base['Access-Control-Allow-Headers'];
  return {
    ...base,
    'Access-Control-Allow-Headers': allowed ? `${allowed}, ${ADMIN_HEADER}` : ADMIN_HEADER,
    // Echo the one origin rather than leaving a wildcard: a wildcard here would be a
    // wildcard for the admin header too.
    'Access-Control-Allow-Origin': origin!,
    Vary: 'Origin',
  };
}

function header(request: AdminRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Handle `POST /admin/reset`.
 *
 * Returns the status code it answered with, so a caller can log the outcome without
 * re-deriving it, and so tests can assert on the decision rather than on the wire.
 */
export async function handleResetRequest(
  options: AdminRouteOptions,
  request: AdminRequest,
  respond: Respond,
): Promise<number> {
  const { game, logger, disconnectAll } = options;
  const origin = header(request, 'origin');
  // Colyseus has already put its own CORS headers on this response; ours only has to be
  // readable by the page that asked, which the preflight has already vouched for.
  const cors: Record<string, string> = isLoopbackOrigin(origin)
    ? { 'Access-Control-Allow-Origin': origin! }
    : {};

  if (!isLoopbackAddress(request.remoteAddress)) {
    logger.warn('refused a world reset from off-machine', { from: request.remoteAddress });
    respond(403, { error: 'loopback_only' }, cors);
    return 403;
  }
  // A cross-site POST cannot set this header without a preflight it will not survive, and
  // a form post cannot set it at all. Both of those arrive *from loopback*, so this is the
  // check that makes the address check mean anything in a browser.
  if (header(request, ADMIN_HEADER) === undefined) {
    logger.warn('refused a world reset with no admin header', { origin });
    respond(403, { error: 'header_required' }, cors);
    return 403;
  }
  if (!game.canResetWorld) {
    respond(501, { error: 'not_supported' }, cors);
    return 501;
  }

  try {
    // Players first. A client still holding the old world's entity ids would spend the
    // reset rendering things that no longer exist, and its character would be written
    // back into the new save on the next autosave.
    await disconnectAll();
    await game.resetWorld();
  } catch (error) {
    logger.error('world reset failed', { error: String(error) });
    respond(500, { error: 'reset_failed' }, cors);
    return 500;
  }

  respond(200, { ok: true, world: game.config.saveName, seed: game.simulation.state.seed }, cors);
  return 200;
}

/** Write a JSON response, for callers holding a raw `ServerResponse`. */
export function respondJson(
  response: ServerResponse,
  status: number,
  body: Record<string, unknown> | null,
  headers: Record<string, string> = {},
): void {
  if (body === null) {
    response.writeHead(status, headers);
    response.end();
    return;
  }
  response.writeHead(status, { ...headers, 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

/** Read the parts of a Node request this route cares about. */
export function toAdminRequest(request: IncomingMessage): AdminRequest {
  return {
    headers: request.headers,
    remoteAddress: request.socket.remoteAddress,
  };
}
