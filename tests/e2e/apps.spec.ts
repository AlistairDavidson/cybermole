// The /apps/* proxy, gate and serving flag against the real app host: the
// shared webServer's own supervised child (CYBERMOLE_APPS_SOCK unset). The
// fixture app is built by global-setup; this spec registers it via the
// internal API and reloads the host. afterAll unregisters it so the other
// specs' fixture world (one app, "alpha app") is unchanged. One login per
// run via the shared cookie file.
import { expect, test } from '@playwright/test';
import type { Cookie, Page } from '@playwright/test';
import * as http from 'node:http';
import * as path from 'node:path';
import {
  APPS_SOCKET,
  INTERNAL_SOCKET,
  PASSWORD,
  USERNAME,
  readSharedSessionCookie,
  writeSharedSessionCookie,
} from '../support/env';

const FIXTURE_TREE = path.resolve(__dirname, '..', 'fixtures', 'app-fixture');

/** One HTTP request over a unix socket. */
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

/** In-page fetch, so the Secure session cookie is sent. */
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

/** Signs in once per run via the shared cookie file (the apps specs share
 *  the 10/15-min login budget). */
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
    await page.goto('/');
  } else {
    await page.goto('/login');
    await page.fill('wa-input#username input', USERNAME);
    await page.fill('wa-input#password input', PASSWORD);
    await page.click('wa-button:has-text("sign in")');
    await page.waitForURL(u => u.pathname === '/');
    sessionCookie =
      (await page.context().cookies()).find(c => c.name === 'cybermole_session') ?? null;
    if (sessionCookie) writeSharedSessionCookie(`${sessionCookie.name}=${sessionCookie.value}`);
  }
  await page.waitForSelector('workspace-sidebar .nav');
}

/** Register the fixture app via the internal API and reload the host.
 *  Idempotent: a row leaked by an aborted run is unregistered first. */
async function registerFixtureApp(): Promise<void> {
  const listed = await callSocket(INTERNAL_SOCKET, 'GET', '/apps');
  expect(listed.status, JSON.stringify(listed.json)).toBe(200);
  // Runs last of the apps specs, which have no afterAll, so their rows can
  // linger into e2e.spec's sidebar counts: sweep them, best-effort.
  for (const leftover of listed.json.apps as Array<{ slug: string }>) {
    if (leftover.slug !== 'app-fixture' && leftover.slug !== 'alpha-app') {
      await callSocket(INTERNAL_SOCKET, 'DELETE', `/apps/${leftover.slug}`);
    }
  }
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
  // A boot-retry discovery can land between the row create and this
  // reload, moving the app between mounted and reimported. What matters is
  // the post-state: /_admin/status lists it mounted.
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
  // Restore global-setup's fixture world. Best-effort: a dead server means
  // the suite is gone anyway.
  try {
    await callSocket(INTERNAL_SOCKET, 'DELETE', '/apps/app-fixture');
    await callSocket(APPS_SOCKET, 'POST', '/_admin/reload', { slug: 'app-fixture' });
  } catch {
    /* the server is gone */
  }
});

test('the /apps/* gate: an unauthenticated page GET renders the login page in place; a non-GET answers 401', async ({
  page,
}) => {
  await page.goto('/apps/app-fixture/');
  // Login renders in place; the address bar keeps the URL.
  await expect(page.locator('wa-input#username')).toBeVisible();
  await expect(page).toHaveURL(/\/apps\/app-fixture\/$/);
  // App pages and APIs share the prefix, so GETs get the login page and
  // non-GETs a 401 with no HTML; never app bytes.
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
  // The SSR page: the wa-card header slot's text is the marker.
  await expect(page.locator('wa-card h1')).toHaveText('app-fixture');
  await expect(page.locator('wa-card')).toHaveCount(1);
  const ping = await api(page, 'GET', '/apps/app-fixture/api/ping?name=web');
  expect(ping.status, JSON.stringify(ping.json)).toBe(200);
  expect(ping.json).toMatchObject({ ok: true, resultType: 'ping', data: { hello: 'web' } });
});

test('the serving flag: /api/state reports the registered app serving, the tree-less fixture app not', async ({
  page,
}) => {
  await login(page);
  // The serving flag rides a host snapshot cached for 10 s, so a poll right
  // after mounting may read the previous one. Poll until it turns over.
  await expect
    .poll(
      async () => {
        const polled = await api(page, 'GET', '/api/state');
        const polledApps = polled.json.apps as Array<{ slug: string; serving: boolean }>;
        return polledApps.find(a => a.slug === 'app-fixture')?.serving ?? false;
      },
      { timeout: 20_000 },
    )
    .toBe(true);
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
  // "alpha app" (a tree-less grouping row) shows not-serving, with the host's reason.
  const alpha = apps.find(a => a.slug === 'alpha-app');
  expect(alpha, JSON.stringify(apps)).toBeDefined();
  expect(alpha?.serving).toBe(false);
  expect(typeof alpha?.servingReason).toBe('string');
  // The sidebar's app group has the open link (dimmed when not serving).
  const open = page.locator('workspace-sidebar .ws-group[data-group="app-fixture"] .open-app-btn');
  // The sidebar's own poll reads the same cached flag; ride out the window.
  await expect(open).toHaveAttribute('href', '/apps/app-fixture/');
  await expect(open).not.toHaveClass(/not-serving/, { timeout: 30_000 });
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
