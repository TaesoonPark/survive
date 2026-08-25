import { build } from 'esbuild';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Bundle the Electron main and preload scripts.
 *
 * Both are emitted as CommonJS: Electron's preload loader and its main process are
 * still happiest with CJS, and bundling means the packaged app carries no node_modules
 * for these two files.
 */
const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');
const outDir = resolve(appRoot, 'dist');

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: true,
  external: ['electron'],
  logLevel: 'info',
};

await build({
  ...common,
  entryPoints: [resolve(appRoot, 'src/main.ts')],
  outfile: resolve(outDir, 'main.cjs'),
});

await build({
  ...common,
  entryPoints: [resolve(appRoot, 'src/preload.ts')],
  outfile: resolve(outDir, 'preload.cjs'),
});

process.stdout.write('desktop: main.cjs and preload.cjs built\n');
