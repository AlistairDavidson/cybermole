// eslint.config.mjs — ESLint 9 flat config for cybermole's hand-written code.
//
// Scope: the TypeScript surfaces (src/, server/, cli/, tests/, playwright.config.ts)
// and the plain-JS ones (tools/, tests/unit/*.test.mjs, the .mjs config files,
// public/sw.js). `.astro` files stay out — `astro check` (npm run check) already
// type-checks them, and eslint-plugin-astro would only add template style rules.
// Generated and vendored trees stay out (the global ignores below).
//
// Baseline: @eslint/js recommended + typescript-eslint strict. On top of that,
// three type-checked rules (no-floating-promises, no-misused-promises,
// await-thenable) — the async web-component code paths them through; the
// rest of the type-checked family (no-unsafe-*, switch-exhaustiveness-check,
// …) is deliberately skipped: this repo is carefully typed (branded IDs,
// Result families with `satisfies`-narrowed error codes — see
// docs/CODE_STYLE.md), so the compiler already catches what those would,
// and their findings here would be noise at intentional boundary casts.
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default [
  {
    ignores: [
      'dist/',
      'dist-server/',
      'node_modules/',
      'pi/',
      '.astro/',
      'test-results/',
      'playwright-report/',
      // fixture app + the starter template + the shipped reference tree,
      // built by their own toolchains
      'tests/fixtures/app-fixture/',
      'app-starter/',
      'apps-reference/',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.strict,

  // Type-aware linting for the TypeScript surfaces. Both root tsconfigs are
  // listed explicitly: the project service only discovers configs named
  // tsconfig.json, and src/lib + src/schemas + server + cli live in
  // tsconfig.server.json. packages/app-kit has its own tsconfig.json (the
  // client-only island module needs DOM libs, which the server build
  // excludes on purpose — preact's jsx types would drag lib.dom into a
  // node-typed program).
  {
    files: [
      'src/**/*.ts',
      'server/**/*.ts',
      'cli/**/*.ts',
      'packages/app-kit/**/*.ts',
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

  // Node-side plain JS: the tools, the node:test units, and the .mjs configs.
  {
    files: ['tools/**/*.mjs', 'tests/**/*.mjs', 'astro.config.mjs', 'eslint.config.mjs'],
    languageOptions: { globals: { ...globals.node } },
  },

  // Browser-side plain JS: the service worker.
  {
    files: ['public/**/*.js'],
    languageOptions: { globals: { ...globals.serviceworker, ...globals.browser } },
  },

  // Repo idioms the strict baseline would otherwise fight:
  {
    rules: {
      // Non-null assertions are used deliberately, mostly where markup the
      // module itself rendered (or an e2e locator) guarantees the element —
      // querySelector/Map.get/etc. (~40 sites in src and tests). Rewriting them
      // as runtime guards would re-check impossible states.
      '@typescript-eslint/no-non-null-assertion': 'off',
      // `_`-prefixed bindings are intentional placeholders (e.g. stripping
      // fields out of a destructure: `const { body: _body, ...rest } = ...`).
      '@typescript-eslint/no-unused-vars': ['error', { varsIgnorePattern: '^_' }],
    },
  },
];
