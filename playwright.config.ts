import { defineConfig, devices } from '@playwright/test';

/**
 * Gameplay tests drive the real Phaser client against a real GameServer.
 *
 * Both are started here rather than in the tests so a failure in one is reported as a
 * setup failure instead of a mysterious timeout inside a spec.
 */
export default defineConfig({
  testDir: './tests/gameplay',
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    ...devices['Desktop Chrome'],
  },
  webServer: [
    {
      // The server's own `start` script, not the root alias: Playwright runs this from
      // the repository root and the workspace flag resolves the package, not the script.
      command:
        'npm run start --workspace @survive/server -- --mode dedicated --bind 127.0.0.1 --port 27510 --statusPort 27511 --save e2e --saveDir ./saves --reset --maxPlayers 4 --log warn',
      // Wait on the status endpoint rather than the game port: it only answers once the
      // world is loaded and the simulation is ready to accept a player.
      url: 'http://127.0.0.1:27511/health',
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command:
        'npm run build --workspace @survive/client && npm run preview --workspace @survive/client',
      url: 'http://127.0.0.1:4173',
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
    },
  ],
});
