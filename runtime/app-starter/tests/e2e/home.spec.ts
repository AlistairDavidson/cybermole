// The scaffolded e2e sample — the loop's shape for every app stamped from
// this template. `npm run test:e2e` runs it (NOT part of `npm run check`):
// the kit's harness boots this tree's built dist/server/entry.mjs on an
// ephemeral server with a throwaway data dir, and Playwright drives the
// real pages. Extend this file per app; keep the suite serial-cheap (one
// boot per run).
import { expect } from '@playwright/test';
import { createAppTest } from '@cybermole/app-kit/testing';

const test = createAppTest(import.meta.url);

test('the home page renders and the ping island answers end to end', async ({ page, app }) => {
  await page.goto(app.baseURL);
  await expect(page.getByRole('heading', { level: 1, name: '__APP_NAME__' })).toBeVisible();

  // One real behavior, browser-real: the wa-* island upgrades, calls the
  // action through the route table, and the page answers.
  await page.locator('.ping-island wa-button', { hasText: 'ping' }).click();
  await expect(page.locator('.ping-island p[aria-live="polite"]')).toHaveText(
    'pong — hello, world',
  );
});
