import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';

/**
 * Supervises a local GameServer child process.
 *
 * The single-player architecture is deliberately boring: Electron spawns the very same
 * headless server a dedicated host would run, waits for it to announce its port, and
 * points the Phaser client at loopback (spec sections 9 and 14). No game logic lives on
 * this side of the boundary - this file only starts, watches and stops a process.
 */

/** The machine-readable line the server prints once it is listening. */
export interface ServerReadyInfo {
  port: number;
  host: string;
  url: string;
  matchmakeUrl: string;
  room: string;
  token: string;
  world: string;
  mode: 'singleplayer' | 'dedicated';
  statusPort: number;
}

export interface LocalServerOptions {
  /** Node executable to run the server with. */
  nodePath: string;
  /** Path to the server entry point (a .ts run through tsx in dev, or a bundle). */
  entry: string;
  /** Extra arguments before the server's own, e.g. the tsx loader. */
  runtimeArgs?: string[];
  world: string;
  saveDir: string;
  /** Extra CLI arguments appended verbatim. */
  extraArgs?: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** How long to wait for the ready line before giving up. */
  startupTimeoutMs?: number;
}

const READY_PREFIX = 'SURVIVE_SERVER_READY ';

export interface LocalServerEvents {
  log: [string];
  error: [string];
  exit: [{ code: number | null; signal: NodeJS.Signals | null }];
  ready: [ServerReadyInfo];
}

/**
 * A running local server.
 *
 * Emits `log` for every line of server output so the UI can show a console, and `exit`
 * exactly once. Killing it is idempotent.
 */
export class LocalServer extends EventEmitter<LocalServerEvents> {
  private child: ChildProcessWithoutNullStreams | null = null;
  private info: ServerReadyInfo | null = null;
  private exited = false;
  private readonly logLines: string[] = [];

  get ready(): ServerReadyInfo | null {
    return this.info;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  get isRunning(): boolean {
    return this.child !== null && !this.exited;
  }

  /** The last 500 lines of server output, for the log panel. */
  get recentLogs(): readonly string[] {
    return this.logLines;
  }

  /**
   * Start the server and resolve once it has announced its port.
   *
   * Rejects - and cleans up the child - if the server dies or stays silent, so a
   * broken build shows an error dialog instead of a window that never connects.
   */
  async start(options: LocalServerOptions): Promise<ServerReadyInfo> {
    if (this.child) throw new Error('server already running');

    const args = [
      ...(options.runtimeArgs ?? []),
      options.entry,
      '--mode',
      'singleplayer',
      '--bind',
      '127.0.0.1',
      '--port',
      '0',
      '--save',
      options.world,
      '--saveDir',
      options.saveDir,
      ...(options.extraArgs ?? []),
    ];

    const child = spawn(options.nodePath, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams;
    this.child = child;

    const readyPromise = new Promise<ServerReadyInfo>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('the local server did not start in time'));
        this.stop();
      }, options.startupTimeoutMs ?? 30_000);

      const settleReady = (info: ServerReadyInfo) => {
        clearTimeout(timeout);
        this.info = info;
        this.emit('ready', info);
        resolve(info);
      };

      lineReader(child.stdout, (line) => {
        this.record(line);
        if (!line.startsWith(READY_PREFIX)) {
          this.emit('log', line);
          return;
        }
        try {
          settleReady(JSON.parse(line.slice(READY_PREFIX.length)) as ServerReadyInfo);
        } catch (error) {
          reject(new Error(`could not parse the server ready line: ${String(error)}`));
        }
      });

      lineReader(child.stderr, (line) => {
        this.record(line);
        this.emit('error', line);
      });

      child.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });

      child.once('exit', (code, signal) => {
        this.exited = true;
        clearTimeout(timeout);
        this.emit('exit', { code, signal });
        if (!this.info) reject(new Error(`the local server exited early (code ${String(code)})`));
      });
    });

    return readyPromise;
  }

  /**
   * Ask the server to shut down, escalating to SIGKILL if it hangs.
   *
   * Closing stdin is the polite signal: the server treats it as "the game window is
   * gone, save and exit", which means the world is flushed to disk rather than
   * truncated.
   */
  stop(graceMs = 5_000): void {
    const child = this.child;
    if (!child || this.exited) return;
    try {
      child.stdin.end();
    } catch {
      // Already closed; nothing to do.
    }
    child.kill('SIGTERM');
    const timer = setTimeout(() => {
      if (!this.exited) child.kill('SIGKILL');
    }, graceMs);
    // Do not hold the event loop open just to kill a process that already died.
    timer.unref?.();
  }

  /** Stop and wait for the process to actually be gone. */
  async stopAndWait(graceMs = 5_000): Promise<void> {
    if (!this.child || this.exited) return;
    const done = new Promise<void>((resolve) => {
      this.child?.once('exit', () => resolve());
    });
    this.stop(graceMs);
    await done;
  }

  private record(line: string): void {
    this.logLines.push(line);
    if (this.logLines.length > 500) this.logLines.shift();
  }
}

/** Split a stream into lines, tolerating chunk boundaries mid-line. */
function lineReader(
  stream: {
    setEncoding(encoding: string): unknown;
    on(event: 'data', listener: (chunk: string) => void): unknown;
  },
  onLine: (line: string) => void,
): void {
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    buffer += chunk;
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, '');
      buffer = buffer.slice(index + 1);
      if (line.length > 0) onLine(line);
      index = buffer.indexOf('\n');
    }
  });
}
