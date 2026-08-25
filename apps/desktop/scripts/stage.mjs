#!/usr/bin/env node
/**
 * Stage the packaged resources under the names the app looks for at runtime.
 *
 * `extraResource` copies each path into `resources/` under its own **basename**, with no
 * way to rename. Pointing it straight at `apps/client/dist` and `apps/server/dist`
 * therefore lands both at `resources/dist` - they collide with each other, and neither is
 * where `main.ts` looks (`resources/client/index.html`, `resources/server/server.cjs`).
 * A packaged app built that way starts, finds no client, and shows the "bundle missing"
 * fallback forever.
 *
 * So the copies are made here first, into directories whose basenames are the contract,
 * and Forge is pointed at those. Run from the `prePackage` hook; safe to run by hand.
 */
import { cp, mkdir, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const app = resolve(here, '..');
const repoRoot = resolve(app, '../..');

/** Landing name -> source directory. The names are what `main.ts` joins onto resourcesPath. */
export const STAGED_RESOURCES = [
  {
    name: 'client',
    from: join(repoRoot, 'apps/client/dist'),
    hint: 'npm run build --workspace @survive/client',
  },
  {
    name: 'server',
    from: join(repoRoot, 'apps/server/dist'),
    hint: 'npm run build --workspace @survive/server',
  },
];

export const STAGE_DIR = join(app, 'build/resources');

async function main() {
  for (const resource of STAGED_RESOURCES) {
    const found = await stat(resource.from).catch(() => null);
    if (!found?.isDirectory()) {
      throw new Error(
        `desktop: cannot stage "${resource.name}" - ${resource.from} is missing.\n` +
          `  Build it first: ${resource.hint}`,
      );
    }
  }

  await rm(STAGE_DIR, { recursive: true, force: true });
  await mkdir(STAGE_DIR, { recursive: true });
  for (const resource of STAGED_RESOURCES) {
    await cp(resource.from, join(STAGE_DIR, resource.name), { recursive: true });
    process.stdout.write(`desktop: staged ${resource.name}\n`);
  }
}

await main();
