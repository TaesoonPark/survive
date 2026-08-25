import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

/** Workspace packages, resolved to their TypeScript sources (no build step needed). */
export const WORKSPACE_PACKAGES = [
  'protocol',
  'game-data',
  'world',
  'simulation',
  'persistence',
  'netcode',
  'test-utils',
] as const;

/** Vite/Vitest `resolve.alias` entries for every workspace package. */
export function workspaceAliases(): Array<{ find: RegExp; replacement: string }> {
  return WORKSPACE_PACKAGES.flatMap((name) => [
    {
      find: new RegExp(`^@survive/${name}/(.*)$`),
      replacement: resolve(root, `packages/${name}/src/$1`),
    },
    {
      find: new RegExp(`^@survive/${name}$`),
      replacement: resolve(root, `packages/${name}/src/index.ts`),
    },
  ]);
}

export const REPO_ROOT = root;
