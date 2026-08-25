import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The packaging contract: what Forge ships must be where the app looks for it.
 *
 * Electron Forge's `extraResource` copies each path into `resources/` under its own
 * **basename**, and offers no way to rename. That makes two independent statements about
 * layout - the paths in `forge.config.cjs` and the `join(process.resourcesPath, ...)`
 * calls in `main.ts` - which nothing was checking against each other.
 *
 * They had in fact drifted: both apps pointed `extraResource` at `apps/*\/dist`, which
 * lands as `resources/dist`, while both looked for `resources/client/index.html` and
 * `resources/server/server.cjs`. The desktop app shipped two directories that collided on
 * the same name and then found neither. Nothing failed - the app starts, shows its
 * "client bundle missing" fallback, and cannot host a game. Only packaging and running
 * the result would have shown it, and neither happens in this suite.
 *
 * So the contract is asserted from both sides here instead.
 */

const require_ = createRequire(import.meta.url);
const repoRoot = resolve(import.meta.dirname, '../..');

interface PackagedApp {
  readonly label: string;
  readonly forge: string;
  readonly main: string;
}

const APPS: PackagedApp[] = [
  {
    label: 'desktop',
    forge: 'apps/desktop/forge.config.cjs',
    main: 'apps/desktop/src/main.ts',
  },
  {
    label: 'server-launcher',
    forge: 'apps/server-launcher/forge.config.cjs',
    main: 'apps/server-launcher/src/main.ts',
  },
];

interface ForgeConfig {
  packagerConfig?: { extraResource?: string[] };
  hooks?: { prePackage?: unknown };
}

/** Directory names the packaged app will find directly under `resources/`. */
function shippedNames(app: PackagedApp): string[] {
  const config = require_(resolve(repoRoot, app.forge)) as ForgeConfig;
  return (config.packagerConfig?.extraResource ?? []).map((entry) => basename(entry));
}

/**
 * Names the source joins onto `process.resourcesPath`.
 *
 * Read out of the source text rather than by running it: the expectation lives in a
 * string literal, and importing an Electron main process here would mean stubbing
 * Electron to learn something a regex already tells us exactly.
 */
function expectedNames(app: PackagedApp): string[] {
  const source = readFileSync(resolve(repoRoot, app.main), 'utf8');
  const found = new Set<string>();
  for (const match of source.matchAll(/process\.resourcesPath\s*,\s*'([^']+)'/g)) {
    if (match[1]) found.add(match[1]);
  }
  return [...found].sort();
}

describe.each(APPS.map((app) => [app.label, app] as const))('%s packaging', (_label, app) => {
  it('looks for at least one resource, so the checks below are not vacuous', () => {
    expect(expectedNames(app).length).toBeGreaterThan(0);
  });

  it('ships every resource directory the app looks for', () => {
    const shipped = shippedNames(app);
    for (const name of expectedNames(app)) expect(shipped).toContain(name);
  });

  it('ships no two resources that would collide on one name', () => {
    const shipped = shippedNames(app);
    expect(shipped).toHaveLength(new Set(shipped).size);
  });

  it('stages resources before packaging rather than copying dist directories directly', () => {
    // Both halves matter: a `dist` basename means the rename step was skipped, and
    // without the hook the staged directories are whatever a previous build left behind.
    const shipped = shippedNames(app);
    expect(shipped).not.toContain('dist');
    const config = require_(resolve(repoRoot, app.forge)) as ForgeConfig;
    expect(typeof config.hooks?.prePackage).toBe('function');
  });
});
