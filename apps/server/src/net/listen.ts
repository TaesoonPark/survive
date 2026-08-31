import type { IncomingMessage, ServerResponse } from 'node:http';
import { Server, matchMaker } from 'colyseus';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { GAME_ROOM_NAME } from '@survive/protocol';
import type { Logger } from '@survive/simulation';
import type { GameServer } from '../game/gameServer';
import { adminCorsHeaders, handleResetRequest, respondJson, toAdminRequest } from './admin';
import { joinGate } from './joinGate';
import { GameRoom } from './room';

/**
 * Bring the network up.
 *
 * Separated from `main` so integration tests can start a real server on an ephemeral
 * port, run bot clients against it, and shut it down cleanly (spec section 35).
 */

export interface ListeningServer {
  /** The port actually bound. Meaningful when the caller asked for port 0. */
  readonly port: number;
  readonly host: string;
  readonly url: string;
  readonly matchmakeUrl: string;
  close(): Promise<void>;
}

export interface ListenOptions {
  game: GameServer;
  logger: Logger;
}

export async function listen(options: ListenOptions): Promise<ListeningServer> {
  const { game, logger } = options;
  const { host, port } = game.config.network;

  // The join gate has to be armed before the first matchmaking request, because
  // Colyseus calls the room's static `onAuth` *while creating* the room - so `onCreate`
  // has not run yet on the very first join.
  joinGate.configure(game.config);

  const transport = new WebSocketTransport({});
  // Registered before Colyseus binds its own matchmaking routes, because express matches
  // in registration order and its final handler would otherwise 404 this path first.
  registerAdminRoutes(transport, game, logger);
  const colyseus = new Server({ transport });
  colyseus.define(GAME_ROOM_NAME, GameRoom, { server: game, logger });

  await colyseus.listen(port, host);

  const bound = resolveBoundPort(transport, port);
  const url = `ws://${displayHost(host)}:${bound}`;
  const matchmakeUrl = `http://${displayHost(host)}:${bound}`;

  logger.info('listening', { host, port: bound, room: GAME_ROOM_NAME });

  return {
    port: bound,
    host,
    url,
    matchmakeUrl,
    close: async () => {
      await colyseus.gracefullyShutdown(false);
      joinGate.reset();
    },
  };
}

/**
 * Read the real port off the transport's underlying HTTP server.
 *
 * Single-player asks for port 0 so the OS picks a free one; the desktop shell then
 * needs to be told which one it got.
 */
function resolveBoundPort(transport: WebSocketTransport, requested: number): number {
  const candidate = transport as unknown as {
    server?: { address?: () => string | { port: number } | null };
  };
  const address = candidate.server?.address?.();
  if (address && typeof address === 'object' && typeof address.port === 'number') {
    return address.port;
  }
  return requested;
}

/** `0.0.0.0` is not a connectable host; show loopback in printed URLs. */
function displayHost(host: string): string {
  return host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
}

/**
 * Attach the admin routes to the transport's own HTTP server.
 *
 * Reaching for the express app rather than adding a second `request` listener is
 * deliberate: two listeners both answer, and express's final handler would try to write a
 * 404 onto a response this route had already ended. Express's router hands each path to
 * the first match and leaves the rest alone.
 */
function registerAdminRoutes(
  transport: WebSocketTransport,
  game: GameServer,
  logger: Logger,
): void {
  // Colyseus answers every OPTIONS on this port itself, from a listener it prepends ahead
  // of the routes, so widening the preflight has to go through its own hook. Chained onto
  // whatever is already there rather than replacing it, because the default is what lets a
  // remote player's browser matchmake at all.
  const inherited = matchMaker.controller.getCorsHeaders.bind(matchMaker.controller);
  matchMaker.controller.getCorsHeaders = (headers: Headers) =>
    adminCorsHeaders(headers.get('origin') ?? undefined, {
      ...matchMaker.controller.DEFAULT_CORS_HEADERS,
      ...inherited(headers),
    });

  type Route = (
    path: string,
    handler: (request: IncomingMessage, response: ServerResponse) => void,
  ) => void;
  const app = transport.getExpressApp() as unknown as { post: Route };

  const handler = (request: IncomingMessage, response: ServerResponse): void => {
    void handleResetRequest(
      {
        game,
        logger,
        disconnectAll: async () => {
          await Promise.allSettled(matchMaker.disconnectAll());
        },
      },
      toAdminRequest(request),
      (status, body, headers) => respondJson(response, status, body, headers),
    );
  };
  app.post('/admin/reset', handler);
}
