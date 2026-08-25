import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { existsSync } from 'node:fs';
import { readdir, readFile, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DesktopChannel,
  type AppInfo,
  type LocalConnection,
  type ServerStatusInfo,
  type StartSinglePlayerRequest,
  type WorldListEntry,
} from './ipc';
import { LocalServer } from './serverProcess';

/**
 * The Electron shell.
 *
 * Two jobs, and only these two (Architecture Guard rule 3):
 *   1. show a window that hosts the Phaser client;
 *   2. for single-player, spawn the headless GameServer as a child process and tell
 *      the renderer which loopback port to connect to.
 *
 * Every rule of the game lives in the server. Deleting this app would cost you the
 * desktop packaging and nothing else.
 */

const isDev = !app.isPackaged;
const here =
  typeof __dirname === 'string' ? __dirname : fileURLToPath(new URL('.', import.meta.url));
const repoRoot = resolve(here, '../../..');

let window: BrowserWindow | null = null;
let localServer: LocalServer | null = null;

/** Where world folders live. Inside userData so an installed game is writable. */
function saveDir(): string {
  return isDev ? resolve(repoRoot, 'saves') : join(app.getPath('userData'), 'saves');
}

/**
 * How to launch the server.
 *
 * In development the sources are run through `tsx`; a packaged build ships a bundled
 * `server.cjs` next to the app resources. Either way it is a plain Node process.
 */
function serverLaunchConfig(): { nodePath: string; entry: string; runtimeArgs: string[] } {
  if (isDev) {
    return {
      nodePath: process.execPath,
      entry: resolve(repoRoot, 'apps/server/src/main.ts'),
      // ELECTRON_RUN_AS_NODE plus the tsx loader turns Electron's own binary into a
      // perfectly ordinary Node that can run TypeScript, which avoids depending on a
      // separate system Node during development.
      runtimeArgs: ['--import', 'tsx'],
    };
  }
  return {
    nodePath: process.execPath,
    entry: join(process.resourcesPath, 'server', 'server.cjs'),
    runtimeArgs: [],
  };
}

function clientEntry(): { url?: string; file?: string } {
  const devUrl = process.env.SURVIVE_CLIENT_URL;
  if (isDev) return { url: devUrl ?? 'http://127.0.0.1:5173' };
  return { file: join(process.resourcesPath, 'client', 'index.html') };
}

async function createWindow(): Promise<void> {
  window = new BrowserWindow({
    width: 1600,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: '#0b0d0c',
    title: 'Survive',
    show: false,
    webPreferences: {
      preload: join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // The game canvas has no business navigating anywhere.
      webSecurity: true,
    },
  });

  window.once('ready-to-show', () => window?.show());

  // External links open in the user's browser, never inside the game window.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  const entry = clientEntry();
  if (entry.url) await window.loadURL(entry.url);
  else if (entry.file && existsSync(entry.file)) await window.loadFile(entry.file);
  else {
    await window.loadURL(
      `data:text/html,${encodeURIComponent(
        '<h1>Client bundle missing</h1><p>Run <code>npm run build:client</code> first.</p>',
      )}`,
    );
  }

  window.on('closed', () => {
    window = null;
  });
}

/** Read a world folder's metadata for the load-game list. */
async function readWorldEntry(root: string, name: string): Promise<WorldListEntry | null> {
  try {
    const metaPath = join(root, name, 'metadata.json');
    if (!existsSync(metaPath)) return null;
    const meta = JSON.parse(await readFile(metaPath, 'utf8')) as {
      seed?: number;
      tick?: number;
      savedAtMs?: number;
    };
    const players = join(root, name, 'players');
    let playerCount = 0;
    if (existsSync(players)) {
      playerCount = (await readdir(players)).filter((file) => file.endsWith('.json')).length;
    }
    const info = await stat(join(root, name));
    // One in-game day is 24 game hours at 20 ticks per game minute.
    const day = Math.floor((meta.tick ?? 0) / (20 * 60 * 24)) + 1;
    return {
      name,
      seed: meta.seed ?? 0,
      day,
      savedAtMs: meta.savedAtMs ?? info.mtimeMs,
      playerCount,
      sizeBytes: info.size,
    };
  } catch {
    return null;
  }
}

function registerHandlers(): void {
  ipcMain.handle(
    DesktopChannel.StartSinglePlayer,
    async (_event, request: StartSinglePlayerRequest): Promise<LocalConnection> => {
      if (localServer?.isRunning) await localServer.stopAndWait();

      const launch = serverLaunchConfig();
      const server = new LocalServer();
      localServer = server;

      server.on('log', (line) => window?.webContents.send(DesktopChannel.ServerLog, line, 'out'));
      server.on('error', (line) => window?.webContents.send(DesktopChannel.ServerLog, line, 'err'));
      server.on('exit', (info) => {
        window?.webContents.send(DesktopChannel.ServerExit, { code: info.code });
        if (localServer === server) localServer = null;
      });

      const info = await server.start({
        nodePath: launch.nodePath,
        entry: launch.entry,
        runtimeArgs: launch.runtimeArgs,
        world: request.world,
        saveDir: saveDir(),
        extraArgs: request.seed === undefined ? [] : ['--seed', String(request.seed)],
        cwd: isDev ? repoRoot : process.resourcesPath,
        // Electron's binary behaves as plain Node when this is set, which is how the
        // dev launch path avoids needing a system Node install.
        env: { ELECTRON_RUN_AS_NODE: '1' },
      });

      return {
        url: info.matchmakeUrl,
        room: info.room,
        token: info.token,
        world: info.world,
        port: info.port,
      };
    },
  );

  ipcMain.handle(DesktopChannel.StopServer, async (): Promise<void> => {
    await localServer?.stopAndWait();
    localServer = null;
  });

  ipcMain.handle(DesktopChannel.ServerStatus, (): ServerStatusInfo => {
    const info = localServer?.ready ?? null;
    return {
      running: localServer?.isRunning ?? false,
      connection: info
        ? {
            url: info.matchmakeUrl,
            room: info.room,
            token: info.token,
            world: info.world,
            port: info.port,
          }
        : null,
      pid: localServer?.pid,
    };
  });

  ipcMain.handle(DesktopChannel.ListWorlds, async (): Promise<WorldListEntry[]> => {
    const root = saveDir();
    if (!existsSync(root)) return [];
    const names = await readdir(root, { withFileTypes: true });
    const entries = await Promise.all(
      names.filter((entry) => entry.isDirectory()).map((entry) => readWorldEntry(root, entry.name)),
    );
    return entries
      .filter((entry): entry is WorldListEntry => entry !== null)
      .sort((a, b) => b.savedAtMs - a.savedAtMs);
  });

  ipcMain.handle(DesktopChannel.DeleteWorld, async (_event, name: string): Promise<void> => {
    // Never let a renderer-supplied name escape the saves folder.
    const safe = String(name).replace(/[^a-zA-Z0-9_-]/g, '');
    if (!safe) throw new Error('invalid world name');
    const target = join(saveDir(), safe);
    const confirmation = await dialog.showMessageBox({
      type: 'warning',
      buttons: ['Cancel', 'Delete'],
      defaultId: 0,
      cancelId: 0,
      title: 'Delete world',
      message: `Permanently delete "${safe}"?`,
      detail: 'This cannot be undone.',
    });
    if (confirmation.response !== 1) return;
    await rm(target, { recursive: true, force: true });
  });

  ipcMain.handle(DesktopChannel.AppInfo, (): AppInfo => ({
    version: app.getVersion(),
    platform: process.platform,
    saveDir: saveDir(),
    isPackaged: app.isPackaged,
  }));

  ipcMain.handle(DesktopChannel.Quit, (): void => {
    app.quit();
  });

  ipcMain.handle(DesktopChannel.ToggleFullscreen, (): boolean => {
    if (!window) return false;
    const next = !window.isFullScreen();
    window.setFullScreen(next);
    return next;
  });
}

// A second instance would fight the first over the same save folder.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });

  app.whenReady().then(async () => {
    registerHandlers();
    await createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) void createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  // Whatever happens, do not leave an orphaned server holding the save file.
  app.on('before-quit', () => {
    localServer?.stop();
  });
  app.on('will-quit', () => {
    localServer?.stop();
  });
}
