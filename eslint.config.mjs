// ESLint 9 flat config. .astro files are left to `astro check`. Baseline is
// @eslint/js recommended + typescript-eslint strict, plus three type-checked
// promise rules; the rest of the type-checked family is skipped as noise at
// intentional boundary casts.
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default [
  {
    ignores: [
      'dist/',
      'dist-server/',
      'node_modules/',
      'runtime/pi-agent-dir/',
      '.astro/',
      'test-results/',
      'playwright-report/',
      // built by their own toolchains
      'tests/fixtures/app-fixture/',
      'runtime/app-starter/',
      'runtime/reference-apps/',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.strict,

  // Both tsconfigs listed: the project service only discovers tsconfig.json.
  // packages/app-kit has its own (the island module needs DOM libs, which
  // the node-typed server build excludes).
  {
    files: [
      'src/**/*.ts',
      'server/**/*.ts',
      'cli/**/*.ts',
      'packages/app-kit/**/*.{ts,mts}',
      'tests/**/*.ts',
      'playwright.config.ts',
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.json', './tsconfig.server.json', './packages/app-kit/tsconfig.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
    },
  },

  {
    files: ['tools/**/*.mjs', 'tests/**/*.mjs', 'astro.config.mjs', 'eslint.config.mjs'],
    languageOptions: { globals: { ...globals.node } },
  },

  {
    files: ['public/**/*.js'],
    languageOptions: { globals: { ...globals.serviceworker, ...globals.browser } },
  },

  {
    rules: {
      // Deliberate, mostly where markup the module rendered guarantees the element.
      '@typescript-eslint/no-non-null-assertion': 'off',
      // `_`-prefixed bindings are intentional placeholders.
      '@typescript-eslint/no-unused-vars': ['error', { varsIgnorePattern: '^_' }],
    },
  },
];
