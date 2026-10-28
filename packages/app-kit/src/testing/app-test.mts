// The per-app Playwright test object: boots the built app once per worker
// (with appPlaywrightConfig's workers: 1, once per run) on an ephemeral
// server with its own hermetic data dir. `from` is any file in the app tree
// — a spec passes import.meta.url, and the walk-up to app.json finds the
// root, so no path is baked into the spec.
import { test as base } from '@playwright/test';
import { startAppServer, type AppServer } from './app-server.mjs';

export function createAppTest(from: URL | string) {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- playwright's extend() shape: no extra test fixtures, the app fixture is worker-scoped
  return base.extend<{}, { app: AppServer }>({
    app: [
      // eslint-disable-next-line no-empty-pattern -- playwright requires a destructuring pattern here; this worker fixture takes no deps
      async ({}, use) => {
        const app = await startAppServer({ from });
        await use(app);
        await app.close();
      },
      { scope: 'worker' },
    ],
  });
}
