#!/usr/bin/env node
/**
 * Stage the server bundle under the name the launcher looks for at runtime.
 *
 * See `apps/desktop/scripts/stage.mjs` for why this is needed: `extraResource` copies by
 * basename, so `apps/server/dist` would land at `resources/dist` while `main.ts` looks in
 * `resources/server/server.cjs`.
 */
import { cp, mkdir, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const app = resolve(here, '..');
const repoRoot = resolve(app, '../..');

export const STAGED_RESOURCES = [
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
        `server-launcher: cannot stage "${resource.name}" - ${resource.from} is missing.\n` +
          `  Build it first: ${resource.hint}`,
      );
    }
  }

  await rm(STAGE_DIR, { recursive: true, force: true });
  await mkdir(STAGE_DIR, { recursive: true });
  for (const resource of STAGED_RESOURCES) {
    await cp(resource.from, join(STAGE_DIR, resource.name), { recursive: true });
    process.stdout.write(`server-launcher: staged ${resource.name}\n`);
  }
}

await main();
