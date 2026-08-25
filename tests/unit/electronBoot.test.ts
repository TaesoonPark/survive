import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';

/**
 * Boot each built Electron main process against a stubbed `electron` module.
 *
 * There is no display in CI or in the agent environment, so the real apps cannot be
 * launched, and "it compiled" was the only thing anyone had ever checked about them. That
 * is a thin guarantee for the two binaries a player actually double-clicks: the main
 * process decides the window's security posture and resolves every path to a bundled
 * resource, and both are easy to get wrong in ways a type checker cannot see. (A packaged
 * layout bug that made the desktop app unable to find its own client survived exactly
 * because nothing here ran - see `packaging.test.ts`.)
 *
 * Run in a child process rather than inline: intercepting `Module._load` to swap in a fake
 * `electron` is global, and the bundles register process-level listeners on load. A
 * separate process keeps that out of the test runner.
 */

const repoRoot = resolve(import.meta.dirname, '../..');

interface BootResult {
  ok: boolean;
  windows: {
    contextIsolation?: boolean;
    nodeIntegration?: boolean;
    preload?: string;
  }[];
  loaded: string[];
  ipcChannels: number;
  error?: string;
}

/**
 * The harness, written to disk as CJS and run by node.
 *
 * `process.resourcesPath` is defined by real Electron and not by node, so it is set here:
 * without it the packaged branch throws inside `join()` and the failure looks like an app
 * bug rather than a missing stub.
 */
const HARNESS = String.raw`
const Module = require('node:module');
const path = require('node:path');

const [, , mainPath, packagedFlag, resourcesPath] = process.argv;
const packaged = packagedFlag === 'true';
const record = { windows: [], loaded: [], exposed: [] };
const channels = [];

class BrowserWindow {
  constructor(options) {
    record.windows.push({
      contextIsolation: options?.webPreferences?.contextIsolation,
      nodeIntegration: options?.webPreferences?.nodeIntegration,
      preload: options?.webPreferences?.preload,
    });
    this.webContents = {
      on() {}, once() {}, setWindowOpenHandler() {}, send() {}, openDevTools() {},
    };
  }
  loadURL(url) { record.loaded.push(url); return Promise.resolve(); }
  loadFile(file) { record.loaded.push(file); return Promise.resolve(); }
  on() {} once() {} show() {} focus() {} setFullScreen() {}
  isFullScreen() { return false; }
  isDestroyed() { return false; }
  static getAllWindows() { return []; }
}

const stub = {
  app: {
    whenReady: () => Promise.resolve(),
    on() {}, quit() {}, disableHardwareAcceleration() {},
    getVersion: () => '0.0.0-test',
    getPath: () => path.join(require('node:os').tmpdir(), 'survive-electron-boot'),
    getAppPath: () => process.cwd(),
    setAsDefaultProtocolClient: () => true,
    requestSingleInstanceLock: () => true,
    isPackaged: packaged,
  },
  BrowserWindow,
  ipcMain: { handle: (c) => channels.push(c), on: (c) => channels.push(c), removeHandler() {} },
  dialog: { showMessageBox: () => Promise.resolve({ response: 0 }), showErrorBox() {} },
  shell: { openExternal: () => Promise.resolve(), openPath: () => Promise.resolve('') },
  Menu: { setApplicationMenu() {}, buildFromTemplate: () => ({}) },
  nativeTheme: { on() {}, shouldUseDarkColors: true },
  contextBridge: { exposeInMainWorld: (k) => record.exposed.push(k) },
  ipcRenderer: { invoke: () => Promise.resolve(), on() {}, send() {} },
};

Object.defineProperty(process, 'resourcesPath', { value: resourcesPath, configurable: true });

const load = Module._load;
Module._load = function (request) {
  if (request === 'electron') return stub;
  return load.apply(this, arguments);
};

(async () => {
  try {
    require(mainPath);
    // Let the whenReady().then(...) chain settle.
    await new Promise((r) => setTimeout(r, 500));
    process.stdout.write(
      JSON.stringify({ ok: true, windows: record.windows, loaded: record.loaded, ipcChannels: channels.length }),
    );
  } catch (err) {
    process.stdout.write(JSON.stringify({ ok: false, windows: [], loaded: [], ipcChannels: 0, error: String(err && err.message ? err.message : err) }));
  }
})();
`;

const harnessPath = join(tmpdir(), 'survive-electron-boot-harness.cjs');
writeFileSync(harnessPath, HARNESS);

function boot(mainRelative: string, packaged: boolean, resourcesPath: string): BootResult {
  const out = execFileSync(
    process.execPath,
    [harnessPath, resolve(repoRoot, mainRelative), String(packaged), resourcesPath],
    { encoding: 'utf8', timeout: 30_000 },
  );
  return JSON.parse(out) as BootResult;
}

/** A resources tree laid out the way `stage.mjs` lays one out. */
function stagedResources(): string {
  const dir = join(tmpdir(), 'survive-electron-boot-resources');
  for (const [sub, file, body] of [
    ['client', 'index.html', '<!doctype html><title>Survive</title>'],
    ['server', 'server.cjs', '// stand-in\n'],
  ] as const) {
    mkdirSync(join(dir, sub), { recursive: true });
    writeFileSync(join(dir, sub, file), body);
  }
  return dir;
}

const APPS = [
  { label: 'desktop', main: 'apps/desktop/dist/main.cjs' },
  { label: 'server-launcher', main: 'apps/server-launcher/dist/main.cjs' },
] as const;

describe.each(APPS.map((app) => [app.label, app.main] as const))(
  '%s main process',
  (_label, mainRelative) => {
    const built = existsSync(resolve(repoRoot, mainRelative));

    it('has been built', () => {
      // Not skipped when missing: an unbuilt bundle is exactly the state in which nobody
      // notices that the boot checks below stopped running.
      expect(built, `${mainRelative} is missing - run npm run build --workspace`).toBe(true);
    });

    it('boots in development mode without throwing, and opens one window', () => {
      const result = boot(mainRelative, false, stagedResources());
      expect(result.error).toBeUndefined();
      expect(result.ok).toBe(true);
      expect(result.windows).toHaveLength(1);
      expect(result.ipcChannels).toBeGreaterThan(0);
    });

    it('boots in packaged mode and resolves a resource that exists on disk', () => {
      const resources = stagedResources();
      const result = boot(mainRelative, true, resources);
      expect(result.error).toBeUndefined();
      expect(result.ok).toBe(true);
      // Whatever it loads must be a real file under the staged tree, not a dev server and
      // not the "bundle missing" fallback: those are the two failure modes that look fine
      // until someone runs the packaged app.
      expect(result.loaded).not.toHaveLength(0);
      for (const target of result.loaded) {
        expect(target.startsWith('data:'), `fell back to an error page: ${target}`).toBe(false);
        expect(target.startsWith('http'), `packaged app loaded a URL: ${target}`).toBe(false);
        expect(existsSync(target), `loaded a path that does not exist: ${target}`).toBe(true);
      }
    });

    it.each([false, true])('locks the window down (packaged=%s)', (packaged) => {
      const result = boot(mainRelative, packaged, stagedResources());
      expect(result.windows).not.toHaveLength(0);
      for (const window of result.windows) {
        expect(window.contextIsolation).toBe(true);
        expect(window.nodeIntegration).not.toBe(true);
        expect(
          window.preload,
          'a renderer with no preload has no way to talk to main',
        ).toBeTruthy();
      }
    });
  },
);
