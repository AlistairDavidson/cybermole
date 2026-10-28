// The notes use loop, app-side: the kit harness boots this tree's built
// dist/server/entry.mjs on an ephemeral server with a throwaway data dir
// (the tree's real data/ is never touched), and Playwright walks the pages
// directly — no console origin, login or session gate: that face is the
// console's own apps-notes spec. The live list's WS nudge is likewise out
// (the harness mounts the HTTP handler only); a reload stands in for it.
// NOT part of `npm run check`; run when page-level behavior changes.
import { expect } from '@playwright/test';
import { createAppTest } from '@cybermole/app-kit/testing';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const test = createAppTest(import.meta.url);
const treeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('capture, find, open, edit, archive — one note through the pages', async ({ page, app }) => {
  await page.goto(app.baseURL);
  await expect(page.locator('wa-card h1')).toHaveText('Notes');
  await expect(page.locator('wa-card')).toContainText('no notes yet — capture one below.');

  // Capture through the island: the wa-* controls upgrade, .value rides
  // the shadow DOM, the save goes through the route table.
  await page.locator('.note-editor wa-input').nth(0).locator('input').fill('e2e standup');
  await page.locator('.note-editor wa-textarea textarea').fill('captured by the app-side e2e');
  await page.locator('.note-editor wa-input').nth(1).locator('input').fill('standup, journal');
  await page.locator('.note-editor wa-button', { hasText: 'save note' }).click();
  await expect(page.locator('.note-editor p[aria-live="polite"]')).toHaveText(
    /saved: e2e standup \(#1\)/,
  );

  // A second note through the API face (the spec's own fetch; no cookies
  // here), then the list: reload shows both, the no-JS find form narrows.
  const seeded = await fetch(`${app.baseURL}/api/notes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'shopping list', body: 'oats', tags: ['errand'] }),
  });
  expect(seeded.status).toBe(201);
  await page.reload();
  await expect(page.locator('.notes a')).toHaveCount(2);
  await page.locator('form.find input[name="search"]').fill('standup');
  await page.locator('form.find button[type="submit"]').click();
  await expect(page.locator('.notes a')).toHaveCount(1);
  await expect(page.locator('.notes a')).toHaveText('e2e standup');

  // Open: the note page SSRs note_get, the editor island carries the note.
  await page.locator('.notes a').click();
  await expect(page.locator('wa-card h1')).toHaveText('e2e standup');
  await expect(page.locator('.note-editor wa-input').nth(0).locator('input')).toHaveValue(
    'e2e standup',
  );

  // Edit through the island, then archive: back on the list, gone from
  // the live view, kept whole in the archive (a flag, never a delete).
  await page.locator('.note-editor wa-input').nth(0).locator('input').fill('e2e standup, edited');
  await page.locator('.note-editor wa-button', { hasText: 'save changes' }).click();
  await expect(page.locator('.note-editor p[aria-live="polite"]')).toHaveText(
    'saved: e2e standup, edited',
  );
  await page.locator('.note-editor wa-button', { hasText: 'archive' }).click();
  await page.waitForURL(`${app.baseURL}/`);
  await expect(page.locator('.notes a')).toHaveCount(1);
  await expect(page.locator('.notes a')).toHaveText('shopping list');
  await page.locator('form.find a', { hasText: 'archived' }).click();
  await expect(page.locator('.notes a')).toHaveText('e2e standup, edited');
  await expect(page.locator('.notes wa-badge', { hasText: 'archived' })).toHaveCount(1);

  // Hermeticity: everything above landed in the harness's throwaway dir —
  // the tree's own data/ never saw a db.
  assert.equal(
    fs.existsSync(path.join(treeRoot, 'data', 'app.db')),
    false,
    "the tree's data/ saw a db — the harness lost hermeticity",
  );
});

test('an empty title answers invalid_title on both faces', async ({ page, app }) => {
  await page.goto(app.baseURL);
  await page.locator('.note-editor wa-input').nth(0).locator('input').fill('   ');
  await page.locator('.note-editor wa-button', { hasText: 'save note' }).click();
  await expect(page.locator('.note-editor p[aria-live="polite"]')).toHaveText(
    'error: title is required',
  );

  const rejected = await fetch(`${app.baseURL}/api/notes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: '   ' }),
  });
  expect(rejected.status).toBe(400);
  expect(await rejected.json()).toMatchObject({
    ok: false,
    resultType: 'note_create',
    errorCode: 'invalid_title',
  });
});
