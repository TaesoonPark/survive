import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Development launcher.
 *
 * Builds the Electron entry points, then starts Electron pointing at the Vite dev
 * server. The Phaser client is served by Vite so hot reload keeps working; the game
 * server is spawned by the Electron main process exactly as it will be in production.
 */
const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', shell: process.platform === 'win32', ...options });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolvePromise() : reject(new Error(`${command} exited ${code}`))));
  });
}

await run(process.execPath, [resolve(here, 'build.mjs')]);

const electron = resolve(appRoot, '../../node_modules/.bin/electron');
await run(electron, [appRoot], {
  cwd: appRoot,
  env: {
    ...process.env,
    SURVIVE_CLIENT_URL: process.env.SURVIVE_CLIENT_URL ?? 'http://127.0.0.1:5173',
  },
});
