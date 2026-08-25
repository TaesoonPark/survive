import { build } from 'esbuild';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Bundle the launcher's main, preload and renderer scripts. */
const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');
const outDir = resolve(appRoot, 'dist');

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

const node = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: true,
  external: ['electron'],
  logLevel: 'info',
};

await build({ ...node, entryPoints: [resolve(appRoot, 'src/main.ts')], outfile: resolve(outDir, 'main.cjs') });
await build({ ...node, entryPoints: [resolve(appRoot, 'src/preload.ts')], outfile: resolve(outDir, 'preload.cjs') });

// The renderer runs in a browser context with context isolation on, so it is a plain
// ES module with no Node built-ins available.
await build({
  bundle: true,
  platform: 'browser',
  target: 'chrome120',
  format: 'esm',
  sourcemap: true,
  logLevel: 'info',
  entryPoints: [resolve(appRoot, 'src/renderer.ts')],
  outfile: resolve(appRoot, 'static/renderer.js'),
});

process.stdout.write('server-launcher: built main.cjs, preload.cjs and static/renderer.js\n');
