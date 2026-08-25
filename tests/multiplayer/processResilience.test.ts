import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ClientMessage } from '@survive/protocol';
import { createBot, sleep, type Bot } from '@survive/test-utils';

/**
 * The real binary, against a client that sends nonsense.
 *
 * Every other multiplayer test runs the server in-process, which cannot observe this
 * failure mode: `main.ts` installs an `uncaughtException` handler that logs and calls
 * `shutdown()`, and an in-process harness has no such handler, so an exception escaping a
 * message handler merely gets reported instead of stopping anything.
 *
 * On the shipped binary it stops everything. Colyseus dispatches message handlers
 * synchronously out of the WebSocket callback with no try/catch of its own, so one
 * unvalidated field reachable from a message was a remote kill switch: a chunk key with no
 * comma threw out of `parseChunkKey`, escaped the handler, reached `uncaughtException`, and
 * took the process down for every player on it.
 *
 * So this test spawns the actual server, throws the same garbage at it, and asserts the
 * process is still alive and still answering. It is the only place that can.
 */

let child: ChildProcessWithoutNullStreams | null = null;
let bots: Bot[] = [];

afterEach(async () => {
  for (const bot of bots) {
    try {
      await bot.leave();
    } catch {
      // The server may be gone; that is what the assertions are for.
    }
  }
  bots = [];
  if (child && child.exitCode === null) child.kill('SIGKILL');
  child = null;
});

interface Ready {
  matchmakeUrl: string;
}

/** Start the real server on an ephemeral port and wait for its machine-readable line. */
async function startServer(): Promise<Ready> {
  const repoRoot = resolve(import.meta.dirname, '../..');
  child = spawn(
    'npx',
    [
      'tsx',
      'apps/server/src/main.ts',
      '--mode',
      'dedicated',
      '--bind',
      '127.0.0.1',
      '--port',
      '0',
      '--save',
      'resilience-e2e',
      '--backend',
      'memory',
      '--reset',
      '--log',
      'error',
    ],
    { cwd: repoRoot, stdio: ['pipe', 'pipe', 'pipe'] },
  );

  let out = '';
  const deadline = Date.now() + 60_000;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    out += chunk;
  });
  child.stderr.setEncoding('utf8');

  while (Date.now() < deadline) {
    const line = out.split('\n').find((entry) => entry.startsWith('SURVIVE_SERVER_READY '));
    if (line) return JSON.parse(line.slice('SURVIVE_SERVER_READY '.length)) as Ready;
    if (child.exitCode !== null) throw new Error(`server exited early: ${child.exitCode}`);
    await sleep(100);
  }
  throw new Error('server never announced readiness');
}

describe('the shipped server process', () => {
  it('does not die when a client sends malformed messages', async () => {
    const ready = await startServer();
    const bot = await createBot({ url: ready.matchmakeUrl, name: 'Alice', playerId: 'alice' });
    bots.push(bot);

    const raw = bot.connection.room;
    // Sent with the real wire names from `ClientMessage`, not the readable channel names.
    // The values are short strings ('reqchunk', 'in', 'cmd'), and a message aimed at an
    // unregistered type is dropped by Colyseus before any handler sees it - which is how an
    // earlier version of this test passed against the unfixed server while proving nothing.
    // A key with no comma, a non-string key, a `keys` that is a string, a `frames` that is
    // a string (passes a `.length` check, then has no `.filter`), a command with no type,
    // and a non-numeric ping. Each of these threw before the handlers were hardened.
    raw.send(ClientMessage.RequestChunks, { keys: ['not-a-key'] });
    raw.send(ClientMessage.RequestChunks, { keys: [{ nope: true }] });
    raw.send(ClientMessage.RequestChunks, { keys: '128,128' });
    raw.send(ClientMessage.RequestChunks, { keys: [null, 12, 'x,y'] });
    raw.send(ClientMessage.Inputs, { frames: 'not-an-array' });
    raw.send(ClientMessage.Inputs, { frames: [{ seq: 'soon' }] });
    raw.send(ClientMessage.Command, { command: {} });
    raw.send(ClientMessage.Command, {});
    raw.send(ClientMessage.Ping, { clientTimeMs: 'soon' });

    await sleep(1500);

    // The process is the assertion. `exitCode === null` means it is still running.
    expect(child?.exitCode, 'the server process exited').toBeNull();

    // ...and it is still doing its job rather than merely alive: a brand-new client has to
    // be able to complete matchmaking, join and receive a snapshot. `createBot` does not
    // resolve until the welcome packet and the first snapshot have both arrived, so this
    // exercises the whole path a real player takes.
    const fresh = await createBot({ url: ready.matchmakeUrl, name: 'Bob', playerId: 'bob' });
    bots.push(fresh);
    const snapshot = await fresh.nextSnapshot();
    expect(snapshot.tick).toBeGreaterThan(0);
  }, 90_000);
});
