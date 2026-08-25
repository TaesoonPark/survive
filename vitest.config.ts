import { defineConfig } from 'vitest/config';
import { workspaceAliases } from './tooling/aliases';

const alias = workspaceAliases();

export default defineConfig({
  resolve: { alias },
  test: {
    globals: false,
    environment: 'node',
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'unit',
          environment: 'node',
          include: [
            'packages/*/src/**/*.test.ts',
            'apps/*/src/**/*.test.ts',
            'tests/unit/**/*.test.ts',
          ],
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'integration',
          environment: 'node',
          include: ['tests/integration/**/*.test.ts'],
          // Integration tests step thousands of ticks against a fully populated world.
          // The budget is generous on purpose: a timeout here should mean a real
          // regression, not a busy machine.
          testTimeout: 120_000,
          hookTimeout: 60_000,
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'multiplayer',
          environment: 'node',
          include: ['tests/multiplayer/**/*.test.ts'],
          testTimeout: 60_000,
          hookTimeout: 60_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
