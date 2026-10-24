// apps.spec.ts — task/app-web (docs/apps-plan.md §4/§10) e2e: the
// /apps/* proxy, gate and serving flag against the REAL app host.
//
// The host is the shared webServer's own supervised child — the config
// leaves CYBERMOLE_APPS_SOCK unset (the single-user spawn rule starts +
// supervises `node dist-server/server/app-host.js` at the state-dir
// default socket, a sibling of WORKSPACE so global-setup's rm -rf can't
// pull it out from under the listener). The fixture app is BUILT by
// global-setup (skip-if-fresh); this spec registers its row through the
// internal API's app verbs (the same Apps domain the console routes
// use — §0's amendment, dogfooded here) and pokes the host's reload,
// the single sync point. afterAll unregisters it, so the fixture tree
// the other specs assert on (one app, "alpha app") is unchanged.
//
// Login budget: login() signs in ONCE for this file and reuses the
// cookie (the shared per-IP budget is 10/15 min; the rate-limit test at
// the end of e2e.spec.ts exhausts the rest).
import { expect, test } from '@playwright/test';
import type { Cookie, Page } from '@playwright/test';
import * as http from 'node:http';
import * as path from 'node:path';
import { APPS_SOCKET, INTERNAL_SOCKET, PASSWORD, USERNAME } from './env';

const FIXTURE_TREE = path.resolve(__dirname, 'fixtures', 'app-fixture');

/** One HTTP request over a unix socket (the units' call() shape). */
function callSocket(
  socketPath: string,
  method: 'GET' | 'POST' | 'DELETE',
  urlPath: string,
  body?: unknown,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the parsed body, callers narrow it
): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        socketPath,
        method,
        path: urlPath,
        headers:
          payload === undefined
            ? {}
            : {
                'content-type': 'application/json',
                'content-length': String(Buffer.byteLength(payload)),
              },
      },
      res => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json: unknown = null;
          try {
            json = JSON.parse(text);
          } catch {
            /* non-JSON */
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on('error', reject);
    if (payload === undefined) req.end();
    else req.end(payload);
  });
}

/** Authed in-page JSON fetch (the shared suite idiom — Playwright's API
 *  client doesn't send the Secure session cookie over plain http). */
async function api(
  page: Page,
  method: string,
  url: string,
): // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the parsed body, callers narrow it
Promise<{ status: number; json: any }> {
  return page.evaluate(
    async ([m, u]) => {
      const r = await fetch(u!, { method: m! });
      return { status: r.status, json: await r.json().catch(() => null) };
    },
    [method, url] as const,
  );
}

/** Lands on the signed-in console (e2e.spec.ts's helper, copied — one
 *  sign-in per file, the cookie reused after). */
let sessionCookie: Cookie | null = null;
async function login(page: Page): Promise<void> {
  if (sessionCookie) {
    await page.context().addCookies([sessionCookie]);
    await page.goto('/');
  } else {
    await page.goto('/login');
    await page.fill('wa-input#username input', USERNAME);
    await page.fill('wa-input#password input', PASSWORD);
    await page.click('wa-button:has-text("sign in")');
    await page.waitForURL(u => u.pathname === '/');
    sessionCookie =
      (await page.context().cookies()).find(c => c.name === 'cybermole_session') ?? null;
  }
  await page.waitForSelector('workspace-sidebar .nav');
}

/** Register the fixture app's row (through the internal API's app verb
 *  — the same Apps domain the console route uses) and poke the host's
 *  reload, the single sync point (plan §1's loop). Idempotent: a row
 *  leaked by an aborted run is unregistered first. */
async function registerFixtureApp(): Promise<void> {
  const listed = await callSocket(INTERNAL_SOCKET, 'GET', '/apps');
  expect(listed.status, JSON.stringify(listed.json)).toBe(200);
  if (listed.json.apps.some((a: { slug: string }) => a.slug === 'app-fixture')) {
    const dropped = await callSocket(INTERNAL_SOCKET, 'DELETE', '/apps/app-fixture');
    expect(dropped.status, JSON.stringify(dropped.json)).toBe(200);
  }
  const made = await callSocket(INTERNAL_SOCKET, 'POST', '/apps', {
    name: 'App Fixture',
    cwd: FIXTURE_TREE,
  });
  expect(made.status, JSON.stringify(made.json)).toBe(200);
  await expectHostMounted();
}

async function expectHostMounted(): Promise<void> {
  const reloaded = await callSocket(APPS_SOCKET, 'POST', '/_admin/reload', {
    slug: 'app-fixture',
  });
  expect(reloaded.status, JSON.stringify(reloaded.json)).toBe(200);
  // The reload REPORTS transitions (mounted = newly mounted this sync,
  // reimported = cache-busted re-import of an already-mounted one) — the
  // host's boot-retry discovery can land between this helper's row-create
  // and this poke, moving the app between the two buckets. The assertion
  // that matters is the post-STATE: /_admin/status lists it mounted.
  expect(
    [...(reloaded.json.mounted ?? []), ...(reloaded.json.reimported ?? [])],
    JSON.stringify(reloaded.json),
  ).toContain('app-fixture');
  const status = await callSocket(APPS_SOCKET, 'GET', '/_admin/status');
  expect(status.status, JSON.stringify(status.json)).toBe(200);
  expect(
    status.json.mounted.map((m: { slug: string }) => m.slug),
    JSON.stringify(status.json),
  ).toContain('app-fixture');
}

test.beforeAll(async () => {
  await registerFixtureApp();
});

test.afterAll(async () => {
  // Unregister + re-sync so the fixture tree the other specs assert on
  // (one app, "alpha app") is exactly what global-setup seeded. Best
  // effort: a dead server here means the whole suite is gone anyway.
  try {
    await callSocket(INTERNAL_SOCKET, 'DELETE', '/apps/app-fixture');
    await callSocket(APPS_SOCKET, 'POST', '/_admin/reload', { slug: 'app-fixture' });
  } catch {
    /* the suite's server is gone — nothing left to clean */
  }
});

test('the /apps/* gate: an unauthenticated page GET renders the login page in place; a non-GET answers 401', async ({
  page,
}) => {
  await page.goto('/apps/app-fixture/');
  // In-place login render (the console's page-gate convention): the
  // address bar keeps the asked-for URL.
  await expect(page.locator('wa-input#username')).toBeVisible();
  await expect(page).toHaveURL(/\/apps\/app-fixture\/$/);
  // GETs anywhere in the namespace are PAGES to the gate (apps mix pages
  // and API under one prefix the web side cannot split): the same
  // in-place login render, never app bytes. A non-GET is a data route:
  // 401, no login HTML.
  const r = await page.evaluate(async () => {
    const res = await fetch('/apps/app-fixture/api/ping?name=x');
    return { status: res.status, body: await res.text() };
  });
  expect(r.status).toBe(200);
  expect(r.body).toContain('sign in');
  expect(r.body).not.toContain('pong');
  const posted = await page.evaluate(async () => {
    const res = await fetch('/apps/app-fixture/api/ping', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    return { status: res.status, body: await res.text() };
  });
  expect(posted.status).toBe(401);
  expect(posted.body).toBe('unauthorized');
});

test('the happy path: the fixture app serves its SSR page and Result-JSON API through the console origin', async ({
  page,
}) => {
  await login(page);
  await page.goto('/apps/app-fixture/');
  // The SSR page: the wa-card's header slot is light DOM inside the
  // declarative shadow-DOM pipeline (astro-lit) — its text is the marker.
  await expect(page.locator('wa-card h1')).toHaveText('app-fixture');
  await expect(page.locator('wa-card')).toHaveCount(1);
  // The API route answers its Result JSON (in-page fetch — authed).
  const ping = await api(page, 'GET', '/apps/app-fixture/api/ping?name=web');
  expect(ping.status, JSON.stringify(ping.json)).toBe(200);
  expect(ping.json).toMatchObject({ ok: true, resultType: 'ping', data: { hello: 'web' } });
});

test('the serving flag: /api/state reports the registered app serving, the tree-less fixture app not', async ({
  page,
}) => {
  await login(page);
  const state = await api(page, 'GET', '/api/state');
  expect(state.status).toBe(200);
  const apps = state.json.apps as Array<{
    slug: string;
    serving: boolean;
    servingReason: string | null;
  }>;
  const fixture = apps.find(a => a.slug === 'app-fixture');
  expect(fixture, JSON.stringify(apps)).toBeDefined();
  expect(fixture?.serving).toBe(true);
  expect(fixture?.servingReason).toBeNull();
  // "alpha app" (global-setup's tree-less grouping row) is honestly
  // served as not-serving, with the host's skip reason.
  const alpha = apps.find(a => a.slug === 'alpha-app');
  expect(alpha, JSON.stringify(apps)).toBeDefined();
  expect(alpha?.serving).toBe(false);
  expect(typeof alpha?.servingReason).toBe('string');
  // The sidebar's app group carries the open link (dimmed only when the
  // host is not serving the app).
  const open = page.locator('workspace-sidebar .ws-group[data-group="app-fixture"] .open-app-btn');
  await expect(open).toHaveAttribute('href', '/apps/app-fixture/');
  await expect(open).not.toHaveClass(/not-serving/);
  const alphaOpen = page.locator(
    'workspace-sidebar .ws-group[data-group="alpha-app"] .open-app-btn',
  );
  await expect(alphaOpen).toHaveClass(/not-serving/);
});

test('an unknown slug answers the Result-JSON 404 through the origin', async ({ page }) => {
  await login(page);
  const r = await api(page, 'GET', '/apps/never-registered/');
  expect(r.status).toBe(404);
  expect(r.json).toEqual({ error: 'not found', detail: null, code: 'not_found' });
});
