// The kit's per-app e2e harness — see app-server.mts for the boot and
// runtime/app-starter/README.md § End-to-end tests for the app-side loop.
// All .mts on purpose: these sources run only inside ESM contexts (the
// Playwright runner loads them directly), and the CJS-dialect kit root
// cannot be imported across that wall (see app-tree.mts). Deliberately
// NOT part of `npm run check`: apps wire their own `test:e2e` script.
export { startAppServer, type AppServer, type StartAppServerOptions } from './app-server.mjs';
export { createAppTest } from './app-test.mjs';
export { appPlaywrightConfig, type AppPlaywrightConfigOptions } from './playwright-config.mjs';
