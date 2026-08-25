/**
 * Electron Forge packaging.
 *
 * The client bundle and the server bundle are copied in as extra resources rather than
 * being bundled into the renderer: the server has to remain a separate, spawnable Node
 * process (spec section 14), and the client is a plain static build.
 *
 * They are copied from `build/resources/{client,server}` rather than straight from
 * `apps/*\/dist`, because `extraResource` lands each path in `resources/` under its own
 * basename with no way to rename: two `dist` directories would collide with each other
 * and neither would be where `main.ts` looks. `scripts/stage.mjs` makes the correctly
 * named copies and the `prePackage` hook below runs it. `tests/unit/packaging.test.ts`
 * pins the names to what the app actually joins onto `process.resourcesPath`.
 */
const { execFileSync } = require('node:child_process');
const { join, resolve } = require('node:path');

const stageScript = resolve(__dirname, 'scripts/stage.mjs');
const stagedResources = resolve(__dirname, 'build/resources');

module.exports = {
  packagerConfig: {
    name: 'Survive',
    executableName: 'survive',
    asar: true,
    icon: resolve(__dirname, 'static/icon'),
    extraResource: [join(stagedResources, 'client'), join(stagedResources, 'server')],
    ignore: [/^\/src\//, /^\/scripts\//, /\.map$/],
  },
  rebuildConfig: {},
  hooks: {
    // Fails loudly when a bundle has not been built, rather than packaging an app whose
    // client is silently absent.
    prePackage: () => {
      execFileSync(process.execPath, [stageScript], { stdio: 'inherit' });
    },
  },
  makers: [
    { name: '@electron-forge/maker-squirrel', platforms: ['win32'], config: { name: 'survive' } },
    { name: '@electron-forge/maker-zip', platforms: ['darwin', 'linux', 'win32'] },
  ],
};
