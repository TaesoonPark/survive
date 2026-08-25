import { build } from 'esbuild';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Bundle the GameServer into a single file.
 *
 * The server must be runnable as a plain Node process with no node_modules beside it: the
 * desktop app spawns it as a child for single-player, and a dedicated host copies it to a
 * box that has nothing else on it (spec sections 14 and 15). Bundling to one CommonJS
 * file makes both of those a copy operation.
 *
 * CJS rather than ESM because Electron's own binary running as Node is the launcher in
 * the packaged case, and `require` is the path of least resistance there.
 */
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');
const outDir = resolve(here, 'dist');

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

const result = await build({
  entryPoints: [resolve(here, 'src/main.ts')],
  outfile: resolve(outDir, 'server.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: true,
  minify: false,
  metafile: true,
  logLevel: 'info',
  banner: {
    // Two things, and they have to be in this order.
    //
    // The shebang makes the bundle directly executable. It lives here rather than in
    // `src/main.ts` so there is exactly one copy: Node strips the first shebang it sees
    // and then fails to parse a second.
    //
    // The `import.meta.url` shim is the price of bundling ESM dependencies down to
    // CommonJS. At least one package in the Colyseus tree resolves a directory relative
    // to `import.meta.url`, which esbuild rewrites to an `undefined` in a CJS output -
    // and the failure is a bare `ERR_INVALID_ARG_TYPE` from `fileURLToPath` at load time,
    // nowhere near the cause. Defining it to the bundle's own file URL is both correct
    // and what those packages actually want.
    js: [
      '#!/usr/bin/env node',
      'const __IMPORT_META_URL__ = require("node:url").pathToFileURL(__filename).href;',
    ].join('\n'),
  },
  external: [
    // Built-in, experimental, and resolved at runtime behind a feature check.
    'node:sqlite',
  ],
  alias: {
    '@survive/protocol': resolve(repoRoot, 'packages/protocol/src/index.ts'),
    '@survive/game-data': resolve(repoRoot, 'packages/game-data/src/index.ts'),
    '@survive/world': resolve(repoRoot, 'packages/world/src/index.ts'),
    '@survive/simulation': resolve(repoRoot, 'packages/simulation/src/index.ts'),
    '@survive/persistence': resolve(repoRoot, 'packages/persistence/src/index.ts'),
  },
  define: {
    'process.env.NODE_ENV': '"production"',
    'import.meta.url': '__IMPORT_META_URL__',
  },
});

const outputs = Object.entries(result.metafile?.outputs ?? {});
for (const [file, meta] of outputs) {
  if (!file.endsWith('.cjs')) continue;
  process.stdout.write(`server: ${file} (${(meta.bytes / 1024).toFixed(0)} kB)\n`);
}
