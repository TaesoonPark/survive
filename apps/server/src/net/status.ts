import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from 'node:http';
import type { Logger } from '@survive/simulation';
import type { GameServer } from '../game/gameServer';

/**
 * A tiny status endpoint.
 *
 * Runs on its own port and its own HTTP server so it cannot interfere with the
 * Colyseus matchmaking routes. The dedicated-server launcher polls it for the player
 * count and performance figures (spec section 16), and the end-to-end suite waits on
 * `/health` to know the server is up.
 */

export interface StatusServer {
  readonly port: number;
  close(): Promise<void>;
}

export interface StatusServerOptions {
  game: GameServer;
  port: number;
  host?: string;
  logger?: Logger;
  /** Extra fields merged into the /status payload, e.g. connected player names. */
  extra?: () => Record<string, unknown>;
}

export async function startStatusServer(options: StatusServerOptions): Promise<StatusServer> {
  const { game, port } = options;
  const host = options.host ?? '127.0.0.1';

  const handler = (request: IncomingMessage, response: ServerResponse): void => {
    const url = (request.url ?? '/').split('?')[0];
    if (url === '/health') {
      respond(response, 200, { ok: game.isRunning, tick: game.simulation?.state.tick ?? 0 });
      return;
    }
    if (url === '/status') {
      const memory = process.memoryUsage();
      const cpu = process.cpuUsage();
      respond(response, 200, {
        ...game.stats(),
        world: game.config.saveName,
        seed: game.simulation.state.seed,
        day: game.simulation.state.time.day,
        hour: game.simulation.state.time.hour,
        weather: game.simulation.state.weather.type,
        maxPlayers: game.config.mode.maxPlayers,
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
        // Cumulative CPU time in microseconds. The launcher differentiates these
        // between polls to show a percentage; reporting a rate here would be wrong
        // because the poll interval is the caller's choice.
        cpuUserUs: cpu.user,
        cpuSystemUs: cpu.system,
        processUptimeMs: Math.round(process.uptime() * 1000),
        ...(options.extra?.() ?? {}),
      });
      return;
    }
    respond(response, 404, { error: 'not_found' });
  };

  const server: HttpServer = createServer(handler);
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolvePromise();
    });
  });

  const address = server.address();
  const boundPort = typeof address === 'object' && address ? address.port : port;
  options.logger?.info('status endpoint listening', { host, port: boundPort });

  return {
    port: boundPort,
    close: () =>
      new Promise<void>((resolvePromise) => {
        server.close(() => resolvePromise());
      }),
  };
}

function respond(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    // The launcher and the Playwright harness are the only intended consumers.
    'access-control-allow-origin': '*',
  });
  response.end(text);
}
