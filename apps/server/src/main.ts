import { randomBytes } from 'node:crypto';
import { parseArgs, usage } from './config/args';
import { bootstrap } from './game/bootstrap';
import { listen } from './net/listen';
import { startStatusServer, type StatusServer } from './net/status';

/**
 * Entry point.
 *
 * ```
 * GameServer --mode singleplayer --bind 127.0.0.1 --save world01
 * GameServer --mode dedicated --bind 0.0.0.0 --port 27500 --save server01 --maxPlayers 16
 * ```
 *
 * No Electron, no Chromium, no Phaser: a plain headless Node process (spec sections
 * 14, 15 and Architecture Guard rule 12).
 */
async function main(argv: readonly string[]): Promise<void> {
  const parsed = parseArgs(argv);
  if (parsed.help) {
    process.stdout.write(usage());
    return;
  }

  const { config, runtime } = parsed;

  // `--exitAfterTicks` is a profiling switch, and an idle-paused server would run exactly
  // zero of the ticks it was asked for. Make the flag mean what it says.
  if (runtime.exitAfterTicks > 0) config.mode.pauseWhenEmpty = false;

  // A single-player server that was not handed a token mints its own, so nothing else
  // on the machine can wander into the world (spec section 13).
  if (config.mode.singlePlayer && !config.network.token) {
    config.network.token = randomBytes(24).toString('base64url');
  }

  const { server, logger } = await bootstrap(config, runtime);
  for (const warning of parsed.warnings) logger.warn(warning);

  const net = await listen({ game: server, logger });

  let status: StatusServer | null = null;
  if (runtime.statusPort > 0) {
    status = await startStatusServer({
      game: server,
      port: runtime.statusPort,
      host: config.mode.singlePlayer ? '127.0.0.1' : config.network.host,
      logger,
      extra: () => ({ serverName: runtime.serverName }),
    });
  }

  if (runtime.announceReady) {
    // A single machine-readable line, so the desktop shell and the launcher can learn
    // the port and token without parsing human log output.
    process.stdout.write(
      `SURVIVE_SERVER_READY ${JSON.stringify({
        port: net.port,
        host: config.network.host,
        url: net.url,
        matchmakeUrl: net.matchmakeUrl,
        room: 'survive',
        token: config.network.token,
        world: config.saveName,
        mode: config.mode.singlePlayer ? 'singleplayer' : 'dedicated',
        statusPort: status?.port ?? 0,
      })}\n`,
    );
  }

  logger.info('server ready', {
    name: runtime.serverName,
    url: net.url,
    world: config.saveName,
    maxPlayers: config.mode.maxPlayers,
    backend: runtime.backend,
  });

  let shuttingDown = false;
  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutting down', { reason });
    try {
      await net.close();
      await status?.close();
      await server.stop();
    } catch (error) {
      logger.error('error during shutdown', { error: String(error) });
      process.exitCode = 1;
    }
    process.exit(process.exitCode ?? 0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  // The desktop shell closes stdin when the game window goes away; that is our cue to
  // stop rather than leaving an orphaned server holding the save file.
  process.stdin.on('end', () => void shutdown('stdin closed'));
  process.on('uncaughtException', (error) => {
    logger.error('uncaught exception', { error: String(error) });
    void shutdown('uncaughtException');
  });
  process.on('unhandledRejection', (reason) => {
    logger.error('unhandled rejection', { reason: String(reason) });
  });

  if (runtime.exitAfterTicks > 0) {
    logger.info('running a fixed number of ticks then exiting', {
      ticks: runtime.exitAfterTicks,
    });
    server.advance(runtime.exitAfterTicks);
    await server.settle();
    await shutdown('exitAfterTicks');
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`fatal: ${String(error)}\n`);
  if (error instanceof Error && error.stack) process.stderr.write(`${error.stack}\n`);
  process.exit(1);
});
