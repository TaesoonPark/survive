import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      // Staged packaging resources - copies of dist/, not sources.
      'apps/*/build/**',
      '**/out/**',
      '**/.vite/**',
      '**/coverage/**',
      '**/playwright-report/**',
      '**/test-results/**',
      'saves/**',
      // Build output that happens to live next to source.
      'apps/*/static/renderer.js',
      'docs/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    files: ['**/*.ts'],
    rules: {
      /**
       * TypeScript already reports an undefined identifier, with better information and
       * without needing a `globals` list per environment. Leaving `no-undef` on for TS
       * only produces false positives on DOM and Node globals - which is exactly the 56
       * it produced here - and is what typescript-eslint itself recommends turning off.
       */
      'no-undef': 'off',
    },
  },
  {
    // Build scripts and Electron Forge configs are Node, not browser and not TypeScript.
    files: ['**/*.mjs', '**/*.js', '**/*.cjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        require: 'readonly',
        module: 'writable',
        exports: 'writable',
        URL: 'readonly',
        setTimeout: 'readonly',
      },
    },
    rules: {
      // Forge configs must be CommonJS; that is the format the tool loads.
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-console': 'off',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'prefer-const': 'error',
    },
  },
  {
    // The simulation must stay deterministic: no wall-clock, no Math.random.
    files: ['packages/simulation/**/*.ts', 'packages/world/**/*.ts', 'packages/game-data/**/*.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'Date', message: 'Simulation code must use SimulationClock, not wall-clock time.' },
      ],
      'no-restricted-properties': [
        'error',
        {
          object: 'Math',
          property: 'random',
          message: 'Use the seeded Rng service (packages/protocol/src/rng.ts) instead.',
        },
        {
          object: 'Date',
          property: 'now',
          message: 'Simulation code must use SimulationClock, not wall-clock time.',
        },
      ],
    },
  },
  {
    files: ['**/*.test.ts', 'tests/**/*.ts', 'packages/test-utils/**/*.ts'],
    rules: {
      'no-restricted-globals': 'off',
      'no-restricted-properties': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
