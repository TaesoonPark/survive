import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LauncherChannel,
  defaultSettings,
  type LauncherStatus,
  type ServerMetrics,
  type ServerSettings,
  type WorldEntry,
} from './ipc';

/**
 * Dedicated Server Launcher.
 *
 * A convenience GUI over the command line, and nothing more. The server it starts is
 * an ordinary child process; killing the launcher does not have to kill the server's
 * world, and the launcher never contains a line of game logic (spec section 16).
 *
 *   ServerLauncher.exe
 *        └── GameServer.exe
 */

const isDev = !app.isPackaged;
const here =
  typeof __dirname === 'string' ? __dirname : fileURLToPath(new URL('.', import.meta.url));
const repoRoot = resolve(here, '../../..');

let window: BrowserWindow | null = null;
let child: ChildProcessWithoutNullStreams | null = null;
let status: LauncherStatus = {
  running: false,
  pid: undefined,
  port: 0,
  statusPort: 0,
  world: '',
  startedAtMs: null,
};

/** Previous CPU sample, so a percentage can be derived from two absolute readings. */
let cpuSample: { totalUs: number; atMs: number } | null = null;

function settingsPath(): string {
  return join(app.getPath('userData'), 'launcher-settings.json');
}

function defaultSaveDir(): string {
  return isDev ? resolve(repoRoot, 'saves') : join(app.getPath('userData'), 'saves');
}

function serverLaunch(): { nodePath: string; entry: string; runtimeArgs: string[] } {
  if (isDev) {
    return {
      nodePath: process.execPath,
      entry: resolve(repoRoot, 'apps/server/src/main.ts'),
      runtimeArgs: ['--import', 'tsx'],
    };
  }
  return {
    nodePath: process.execPath,
    entry: join(process.resourcesPath, 'server', 'server.cjs'),
    runtimeArgs: [],
  };
}

function argsFor(settings: ServerSettings, statusPort: number): string[] {
  const args = [
    '--mode',
    'dedicated',
    '--bind',
    '0.0.0.0',
    '--port',
    String(settings.port),
    '--save',
    settings.world,
    '--saveDir',
    settings.saveDir,
    '--maxPlayers',
    String(settings.maxPlayers),
    '--backend',
    settings.backend,
    '--name',
    settings.serverName,
    '--log',
    settings.logLevel,
    '--statusPort',
    String(statusPort),
    settings.pvp ? '--pvp' : '--no-pvp',
    settings.pauseWhenEmpty ? '--pauseEmpty' : '--no-pauseEmpty',
    '--zombieDensity',
    String(settings.zombieDensity),
    '--lootAbundance',
    String(settings.lootAbundance),
    '--needRate',
    String(settings.needRate),
    '--quiet',
  ];
  if (settings.password) args.push('--password', settings.password);
  if (settings.seed !== null) args.push('--seed', String(settings.seed));
  return args;
}

function send(channel: string, ...payload: unknown[]): void {
  window?.webContents.send(channel, ...payload);
}

/** Split a stream into lines and forward each to the renderer's log panel. */
function pipeLines(stream: ChildProcessWithoutNullStreams['stdout'], kind: 'out' | 'err'): void {
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    buffer += chunk;
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, '');
      buffer = buffer.slice(index + 1);
      if (line.length > 0) send(LauncherChannel.Log, line, kind);
      index = buffer.indexOf('\n');
    }
  });
}

async function createWindow(): Promise<void> {
  window = new BrowserWindow({
    width: 980,
    height: 780,
    minWidth: 720,
    minHeight: 600,
    backgroundColor: '#101314',
    title: 'Survive Dedicated Server',
    webPreferences: {
      preload: join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  await window.loadFile(join(here, '..', 'static', 'index.html'));
  window.on('closed', () => {
    window = null;
  });
}

function registerHandlers(): void {
  ipcMain.handle(LauncherChannel.Start, async (_event, settings: ServerSettings) => {
    if (child) throw new Error('the server is already running');

    await mkdir(settings.saveDir, { recursive: true });
    // The status endpoint sits next to the game port so the operator only has to
    // remember one number.
    const statusPort = settings.port + 1;
    const launch = serverLaunch();

    const proc = spawn(
      launch.nodePath,
      [...launch.runtimeArgs, launch.entry, ...argsFor(settings, statusPort)],
      {
        cwd: isDev ? repoRoot : process.resourcesPath,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      },
    ) as ChildProcessWithoutNullStreams;
    child = proc;
    cpuSample = null;

    pipeLines(proc.stdout, 'out');
    pipeLines(proc.stderr, 'err');

    proc.once('error', (error) => {
      send(LauncherChannel.Log, `failed to start: ${String(error)}`, 'err');
    });
    proc.once('exit', (code) => {
      send(LauncherChannel.Exit, { code });
      child = null;
      status = { ...status, running: false, pid: undefined, startedAtMs: null };
    });

    status = {
      running: true,
      pid: proc.pid,
      port: settings.port,
      statusPort,
      world: settings.world,
      startedAtMs: Date.now(),
    };
    return status;
  });

  ipcMain.handle(LauncherChannel.Stop, async (): Promise<void> => {
    if (!child) return;
    const proc = child;
    const done = new Promise<void>((resolvePromise) => proc.once('exit', () => resolvePromise()));
    // Closing stdin is the graceful signal; SIGTERM is the follow-up.
    try {
      proc.stdin.end();
    } catch {
      // Already closed.
    }
    proc.kill('SIGTERM');
    const escalate = setTimeout(() => proc.kill('SIGKILL'), 8_000);
    escalate.unref?.();
    await done;
    clearTimeout(escalate);
    child = null;
  });

  ipcMain.handle(LauncherChannel.Status, (): LauncherStatus => status);

  ipcMain.handle(LauncherChannel.Metrics, async (): Promise<ServerMetrics> => {
    const empty: ServerMetrics = {
      reachable: false,
      players: 0,
      maxPlayers: 0,
      tick: 0,
      day: 0,
      hour: 0,
      weather: '-',
      loadedChunks: 0,
      entities: 0,
      droppedTicks: 0,
      averageStepMs: 0,
      cpuPercent: 0,
      rssBytes: 0,
      uptimeMs: 0,
    };
    if (!status.running || status.statusPort === 0) return empty;
    try {
      const response = await fetch(`http://127.0.0.1:${status.statusPort}/status`, {
        signal: AbortSignal.timeout(1500),
      });
      if (!response.ok) return empty;
      const body = (await response.json()) as Record<string, number | string>;

      const totalUs = Number(body.cpuUserUs ?? 0) + Number(body.cpuSystemUs ?? 0);
      const nowMs = Date.now();
      let cpuPercent = 0;
      if (cpuSample) {
        const elapsedMs = nowMs - cpuSample.atMs;
        if (elapsedMs > 0) {
          cpuPercent = ((totalUs - cpuSample.totalUs) / 1000 / elapsedMs) * 100;
        }
      }
      cpuSample = { totalUs, atMs: nowMs };

      return {
        reachable: true,
        players: Number(body.players ?? 0),
        maxPlayers: Number(body.maxPlayers ?? 0),
        tick: Number(body.tick ?? 0),
        day: Number(body.day ?? 0),
        hour: Number(body.hour ?? 0),
        weather: String(body.weather ?? '-'),
        loadedChunks: Number(body.loadedChunks ?? 0),
        entities: Number(body.entities ?? 0),
        droppedTicks: Number(body.droppedTicks ?? 0),
        averageStepMs: Number(body.averageStepMs ?? 0),
        cpuPercent: Math.max(0, Math.min(100 * 64, cpuPercent)),
        rssBytes: Number(body.rssBytes ?? 0),
        uptimeMs: Number(body.uptimeMs ?? 0),
      };
    } catch {
      return empty;
    }
  });

  ipcMain.handle(
    LauncherChannel.ListWorlds,
    async (_event, saveDir: string): Promise<WorldEntry[]> => {
      if (!existsSync(saveDir)) return [];
      const dirs = await readdir(saveDir, { withFileTypes: true });
      const entries: WorldEntry[] = [];
      for (const dir of dirs) {
        if (!dir.isDirectory()) continue;
        const metaPath = join(saveDir, dir.name, 'metadata.json');
        if (!existsSync(metaPath)) {
          entries.push({ name: dir.name, day: 0, savedAtMs: 0, seed: 0 });
          continue;
        }
        try {
          const meta = JSON.parse(await readFile(metaPath, 'utf8')) as {
            tick?: number;
            savedAtMs?: number;
            seed?: number;
          };
          entries.push({
            name: dir.name,
            day: Math.floor((meta.tick ?? 0) / (20 * 60 * 24)) + 1,
            savedAtMs: meta.savedAtMs ?? 0,
            seed: meta.seed ?? 0,
          });
        } catch {
          entries.push({ name: dir.name, day: 0, savedAtMs: 0, seed: 0 });
        }
      }
      return entries.sort((a, b) => b.savedAtMs - a.savedAtMs);
    },
  );

  ipcMain.handle(LauncherChannel.LoadSettings, async (): Promise<ServerSettings> => {
    const fallback = defaultSettings(defaultSaveDir());
    try {
      const raw = await readFile(settingsPath(), 'utf8');
      // Merge rather than replace, so a settings file written by an older build still
      // loads when new options are added.
      return { ...fallback, ...(JSON.parse(raw) as Partial<ServerSettings>) };
    } catch {
      return fallback;
    }
  });

  ipcMain.handle(
    LauncherChannel.SaveSettings,
    async (_event, settings: ServerSettings): Promise<void> => {
      await mkdir(app.getPath('userData'), { recursive: true });
      await writeFile(settingsPath(), JSON.stringify(settings, null, 2), 'utf8');
    },
  );

  ipcMain.handle(LauncherChannel.PickSaveDir, async (): Promise<string | null> => {
    const result = await dialog.showOpenDialog({
      title: 'Choose the folder that holds world saves',
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  ipcMain.handle(LauncherChannel.OpenSaveDir, async (_event, saveDir: string): Promise<void> => {
    await mkdir(saveDir, { recursive: true });
    await shell.openPath(saveDir);
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (window?.isMinimized()) window.restore();
    window?.focus();
  });

  app.whenReady().then(async () => {
    registerHandlers();
    await createWindow();
  });

  app.on('window-all-closed', () => app.quit());

  // Closing the launcher stops the server it started. An operator who wants the server
  // to outlive the GUI should run GameServer directly - which is exactly why the two
  // are separate processes.
  app.on('before-quit', () => {
    child?.kill('SIGTERM');
  });
}
