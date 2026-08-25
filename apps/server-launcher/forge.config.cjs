const { execFileSync } = require('node:child_process');
const { join, resolve } = require('node:path');

const stageScript = resolve(__dirname, 'scripts/stage.mjs');
const stagedResources = resolve(__dirname, 'build/resources');

/**
 * The launcher ships the server bundle as a resource and starts it as a separate
 * process. The two stay separate on purpose (spec section 16): the launcher is a
 * convenience, not a dependency of the server.
 *
 * The bundle is staged into `build/resources/server` first: `extraResource` copies by
 * basename, so pointing it at `apps/server/dist` would land the bundle at
 * `resources/dist` while `main.ts` looks in `resources/server/server.cjs`.
 */
module.exports = {
  packagerConfig: {
    name: 'Survive Server Launcher',
    executableName: 'survive-launcher',
    asar: true,
    extraResource: [join(stagedResources, 'server')],
    ignore: [/^\/src\//, /^\/scripts\//, /\.map$/],
  },
  rebuildConfig: {},
  hooks: {
    prePackage: () => {
      execFileSync(process.execPath, [stageScript], { stdio: 'inherit' });
    },
  },
  makers: [{ name: '@electron-forge/maker-zip', platforms: ['darwin', 'linux', 'win32'] }],
};
