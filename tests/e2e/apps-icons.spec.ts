// App icons: the scaffold's icon field (explicit and suggested-by-default),
// the register path landing the manifest icon on the row, and the icons
// showing in the builder sidebar's app group headers — the row's icon for a
// registered app, the manifest's for an unregistered tree. The new-app
// dialog's live preview rides the same shared suggestion rule.
//
// Apps-spec discipline: see apps-notes.spec.ts.
import { expect, test } from '@playwright/test';
import type { Cookie, Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  APPS_ROOT,
  APPS_SOCKET,
  INTERNAL_SOCKET,
  PASSWORD,
  USERNAME,
  WORKSPACE,
  readSharedSessionCookie,
  writeSharedSessionCookie,
} from '../support/env';
import { registerTool, statusTool, unregisterTool } from '../../dist-server/server/apps-mcp.js';
import { runChild } from '../../dist-server/src/lib/apps/apps-child.js';
import { scaffoldApp } from '../../dist-server/src/lib/apps/apps-scaffold.js';

const REPO = path.resolve(__dirname, '..', '..');
/** Explicit-icon scaffold; registered to walk the row's icon. */
const SLUG = 'icon-probe';
/** No-icon scaffold: the name suggests the icon; stays unregistered so the
 *  manifest icon path is visible too. */
const NOTE_SLUG = 'note-probe';
/** Inside APPS_ROOT, so the per-run WORKSPACE rm makes it run-scoped. */
const SWEEP_MARKER = path.join(APPS_ROOT, `.${SLUG}.swept`);
/** Resolved like main() would, against this suite's sockets and apps root. */
const deps = {
  appsRoot: APPS_ROOT,
  internalSocketPath: INTERNAL_SOCKET,
  appsSocketPath: APPS_SOCKET,
  installRoot: REPO,
};

// dist-server ships no .d.ts, so tool answers are loose JSON here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- parsed tool JSON
type Json = any;

async function tool(
  run: Promise<{ isError?: boolean; content?: Array<{ text?: string }> } | undefined>,
): Promise<{ isError: boolean; body: Json }> {
  const r = await run;
  return { isError: r?.isError === true, body: JSON.parse(r?.content?.[0]?.text ?? '{}') };
}

/** In-page fetch, so the Secure session cookie is sent. */
async function api(
  page: Page,
  method: string,
  url: string,
): // eslint-disable-next-line @typescript-eslint/no-explicit-any -- parsed JSON, callers narrow it
Promise<{ status: number; json: any }> {
  return page.evaluate(
    async ([m, u]) => {
      const r = await fetch(u!, { method: m! });
      return { status: r.status, json: await r.json().catch(() => null) };
    },
    [method, url] as const,
  );
}

/** Signs in once per run: the shared cookie file first, a form sign-in
 *  only if nobody has yet (the apps specs share the login budget). */
let sessionCookie: Cookie | null = null;
async function login(page: Page): Promise<void> {
  if (!sessionCookie) {
    const shared = readSharedSessionCookie();
    if (shared !== null) {
      const [name, ...rest] = shared.split('=');
      sessionCookie = {
        name,
        value: rest.join('='),
        domain: '127.0.0.1',
        path: '/',
        httpOnly: true,
        secure: false,
        sameSite: 'Strict',
        expires: -1,
      };
    }
  }
  if (sessionCookie) {
    await page.context().addCookies([sessionCookie]);
    await page.goto('/builder');
  } else {
    await page.goto('/login');
    await page.fill('wa-input#username input', USERNAME);
    await page.fill('wa-input#password input', PASSWORD);
    await page.click('wa-button:has-text("sign in")');
    await page.waitForURL(u => u.pathname === '/');
    sessionCookie =
      (await page.context().cookies()).find(c => c.name === 'cybermole_session') ?? null;
    if (sessionCookie) writeSharedSessionCookie(`${sessionCookie.name}=${sessionCookie.value}`);
    await page.goto('/builder');
  }
  await page.waitForSelector('workspace-sidebar .nav');
}

async function refreshState(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const app = document.querySelector('console-app') as unknown as {
      loadState(): Promise<void>;
      loadAppsStatus(): Promise<void>;
    };
    await app.loadState();
    await app.loadAppsStatus();
  });
}

/** Registered, established idempotently (no file-order assumptions). */
async function ensureRegistered(): Promise<void> {
  const status = await tool(statusTool(deps, SLUG));
  expect(status.isError, JSON.stringify(status.body)).toBe(false);
  const app = status.body.apps[0] as { registered?: boolean } | undefined;
  if (!app?.registered) {
    const registered = await tool(registerTool(deps, SLUG));
    expect(
      !registered.isError || registered.body?.code === 'duplicate_slug',
      JSON.stringify(registered),
    ).toBe(true);
  }
}

test.beforeAll(async () => {
  // Entry sweep, gated once per run by the marker: the scheduler may split
  // this file across workers, and a replacement worker's beforeAll would
  // otherwise unregister and remove what earlier tests in this run built.
  if (fs.existsSync(SWEEP_MARKER)) return;
  fs.mkdirSync(APPS_ROOT, { recursive: true });
  fs.writeFileSync(SWEEP_MARKER, `${process.pid} ${Date.now()}\n`);
  for (const slug of [SLUG, NOTE_SLUG]) {
    fs.rmSync(path.join(APPS_ROOT, slug), { recursive: true, force: true });
    try {
      await unregisterTool(deps, slug);
    } catch {
      /* no row */
    }
  }
});

test('scaffold: an explicit icon is validated and baked into app.json; an absent one is suggested from the name', async ({
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- the fixture is the point: a uniform signature per file (one worker)
  page: _page,
}) => {
  test.setTimeout(120_000);
  const scaffoldDeps = {
    appsRoot: APPS_ROOT,
    templateDir: path.join(REPO, 'runtime', 'app-starter'),
    agentTemplateFile: path.join(REPO, 'runtime', 'app-agents', 'AGENTS.md'),
    installRoot: REPO,
    run: runChild,
  };

  // explicit: the icon rides the tree's manifest
  const explicit: Json = await scaffoldApp(scaffoldDeps, {
    name: 'Icon Probe',
    description: 'the explicit-icon run',
    icon: 'robot',
  });
  expect(explicit.ok, JSON.stringify(explicit)).toBe(true);
  expect(explicit.data.icon).toBe('robot');
  expect(JSON.parse(fs.readFileSync(path.join(APPS_ROOT, SLUG, 'app.json'), 'utf8'))).toEqual({
    name: 'Icon Probe',
    description: 'the explicit-icon run',
    slug: SLUG,
    icon: 'robot',
  });

  // absent: the shared suggestion rule decides (notes → file-lines)
  const suggested: Json = await scaffoldApp(scaffoldDeps, {
    name: 'Note Probe',
    description: 'the suggested-icon run',
  });
  expect(suggested.ok, JSON.stringify(suggested)).toBe(true);
  expect(suggested.data.icon).toBe('file-lines');
  expect(JSON.parse(fs.readFileSync(path.join(APPS_ROOT, NOTE_SLUG, 'app.json'), 'utf8'))).toEqual({
    name: 'Note Probe',
    description: 'the suggested-icon run',
    slug: NOTE_SLUG,
    icon: 'file-lines',
  });

  // unknown names are refused, nothing written
  const bad: Json = await scaffoldApp(scaffoldDeps, { name: 'Bad Icon Probe', icon: 'sparkles' });
  expect(bad.ok).toBe(false);
  expect(bad.errorCode).toBe('invalid_icon');
  expect(bad.errorMessage).toContain('robot');
  expect(fs.existsSync(path.join(APPS_ROOT, 'bad-icon-probe'))).toBe(false);
});

test('register lands the manifest icon on the row; the sidebar shows it (and the tree\u2019s, unregistered)', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await ensureRegistered();
  await login(page);

  // the row carries the manifest's icon through the internal API
  const registered = await tool(statusTool(deps, SLUG));
  expect(registered.isError, JSON.stringify(registered.body)).toBe(false);
  expect(registered.body.apps[0]).toMatchObject({ slug: SLUG, registered: true, icon: 'robot' });
  const state = await api(page, 'GET', '/api/state');
  expect(state.status).toBe(200);
  expect(state.json.apps.find((a: Json) => a.slug === SLUG)?.icon).toBe('robot');

  // The registered app's group header shows the row's icon; the
  // unregistered tree's shows its manifest's (the status join is cached
  // ~10 s, so poll the page's own refresh until it lands).
  const group = page.locator('workspace-sidebar .ws-group[data-group="' + SLUG + '"]');
  await expect(group.locator('h2 .g-icon wa-icon')).toHaveAttribute('name', 'robot');
  const noteGroup = page.locator(`workspace-sidebar .ws-group[data-group="${NOTE_SLUG}"]`);
  await expect
    .poll(
      async () => {
        await refreshState(page);
        return noteGroup.locator('h2 .g-icon wa-icon').getAttribute('name');
      },
      { timeout: 25_000, intervals: [500, 1000, 2000, 2000] },
    )
    .toBe('file-lines');
});

test('the new-app dialog previews the suggested icon from the name (the shared rule, client-side)', async ({
  page,
}) => {
  await login(page);
  await page.click('workspace-sidebar #new-app');
  await expect(page.locator('#app-icon-name')).toHaveText('suggested icon: cubes (from the name)');
  await page.fill('wa-input#app-name input', 'Dialog Code Probe');
  await expect(page.locator('#app-icon-name')).toHaveText('suggested icon: code (from the name)');
  await expect(page.locator('#app-icon-glyph')).toHaveAttribute('name', 'code');
  // nothing was created; the dialog just previews
  await page.click('#app-dialog [data-dialog="close"]');
});

test('the settings page: gear -> change icon, name and cwd; the sidebar shows it; empty name is a field error', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await ensureRegistered();
  await login(page);

  // The gear affordance on the row's group links to its settings page.
  const group = page.locator(`workspace-sidebar .ws-group[data-group="${SLUG}"]`);
  await expect(group.locator('.app-settings-btn')).toHaveAttribute('href', `/builder/${SLUG}`);
  await group.locator('.app-settings-btn').click();
  await page.waitForURL(u => u.pathname === `/builder/${SLUG}`);

  // The page prefilled from the row: name, cwd, the picked icon, and the
  // read-only slug + timestamps.
  await expect(page.locator('wa-input#app-name input')).toHaveValue('Icon Probe');
  await expect(page.locator('wa-input#app-cwd input')).toHaveValue(`${APPS_ROOT}/${SLUG}`);
  await expect(page.locator('.icon-choice[aria-checked="true"]')).toHaveAttribute(
    'data-icon',
    'robot',
  );
  await expect(page.locator('.cfg-row').filter({ hasText: 'slug' })).toContainText(SLUG);
  await expect(page.locator('.cfg-row').filter({ hasText: 'created' })).toContainText(
    /\d{4}-\d{2}-\d{2}T/,
  );

  await page.waitForFunction(() => customElements.get('validation-enhancer-zod') !== undefined);
  // An empty name is blocked in the browser, the error in the hint slot.
  const patches: string[] = [];
  page.on('request', r => {
    if (r.method() === 'PATCH') patches.push(new URL(r.url()).pathname);
  });
  await page.fill('wa-input#app-name input', '');
  await page.click('#app-settings-save');
  await expect(page.locator('#app-name-error')).toHaveText('name is required');
  expect(patches.filter(p => p === `/api/apps/${SLUG}`)).toEqual([]);

  // A cwd that does not exist is a server field error (the rename path
  // checks existence — it never mkdirs).
  const dir = `${WORKSPACE}/icon-probe-cwd`;
  await page.fill('wa-input#app-name input', 'Icon Probe Renamed');
  await page.fill('wa-input#app-cwd input', dir);
  await page.click('.icon-choice[data-icon="terminal"]');
  await page.click('#app-settings-save');
  await expect(page.locator('#app-cwd-error')).toHaveText(`cwd does not exist: ${dir}`);
  expect(patches.filter(p => p === `/api/apps/${SLUG}`)).toEqual([`/api/apps/${SLUG}`]);

  // An existing dir + the new icon and name: saved, and the header agrees.
  fs.mkdirSync(dir, { recursive: true });
  await page.click('#app-settings-save');
  await expect(page.locator('#app-settings-result')).toContainText('saved');
  await expect(page.locator('#app-settings-title-name')).toHaveText('Icon Probe Renamed');
  await expect(page.locator('#app-settings-title-icon')).toHaveAttribute('name', 'terminal');

  // The row agrees, and /builder shows it in the group header (the group
  // key stays the slug — it never changes).
  const state = await api(page, 'GET', '/api/state');
  expect(state.json.apps.find((a: Json) => a.slug === SLUG)).toMatchObject({
    name: 'Icon Probe Renamed',
    icon: 'terminal',
    cwd: dir,
  });
  await page.goto('/builder');
  await page.waitForSelector('workspace-sidebar .nav');
  const renamed = page.locator(`workspace-sidebar .ws-group[data-group="${SLUG}"]`);
  await expect(renamed.locator('h2 .g-name')).toHaveText('Icon Probe Renamed');
  await expect(renamed.locator('h2 .g-icon wa-icon')).toHaveAttribute('name', 'terminal');

  // Clearing the cwd returns the app to the server default (the hint's
  // “empty = the server default”: an empty save sends null, not a keep).
  await page.goto(`/builder/${SLUG}`);
  await expect(page.locator('wa-input#app-cwd input')).toHaveValue(dir); // prefilled from the row
  await page.fill('wa-input#app-cwd input', '');
  await page.click('#app-settings-save');
  await expect
    .poll(
      async () =>
        (await api(page, 'GET', '/api/state')).json.apps.find((a: Json) => a.slug === SLUG)?.cwd,
      { timeout: 10_000 },
    )
    .toBe(null);

  // A slug with no row (or a bad shape) is the 404 body.
  const missing = await page.goto('/builder/no-such-app');
  expect(missing?.status()).toBe(404);
  await expect(page.locator('.app-settings-main')).toContainText('no such app');
  const badShape = await page.goto(`/builder/${encodeURIComponent('NO!')}`);
  expect(badShape?.status()).toBe(404);
});
