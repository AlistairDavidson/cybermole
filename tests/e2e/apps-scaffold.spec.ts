// The whole build loop through the cybermole-apps verbs, against the shared
// webServer's sockets: scaffold a real app into the hermetic apps root,
// check it green (which also verifies the starter template), register and
// reload, then assert it serves through the console origin and shows as
// serving in /api/state. The verbs are the compiled MCP module's own
// functions, called in-process; stdio wiring has its own unit.
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
  readSharedSessionCookie,
  writeSharedSessionCookie,
} from '../support/env';
import {
  registerTool,
  reloadTool,
  statusTool,
  unregisterTool,
} from '../../dist-server/server/apps-mcp.js';
import { runChild } from '../../dist-server/src/lib/apps/apps-child.js';
import { scaffoldApp } from '../../dist-server/src/lib/apps/apps-scaffold.js';
import { checkApp } from '../../dist-server/src/lib/apps/apps-gate.js';

const REPO = path.resolve(__dirname, '..', '..');
const SLUG = 'loop-probe';
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

/** Signs in once per run: the shared cookie file first, a form sign-in
 *  only if nobody has yet. */
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

test.beforeAll(async () => {
  // Entry sweep, gated once per run by the marker: the scheduler may split
  // this file across workers, and a replacement worker's beforeAll would
  // otherwise unregister and remove what earlier tests in this run built.
  if (fs.existsSync(SWEEP_MARKER)) return;
  fs.mkdirSync(APPS_ROOT, { recursive: true });
  fs.writeFileSync(SWEEP_MARKER, `${process.pid} ${Date.now()}\n`);
  fs.rmSync(path.join(APPS_ROOT, SLUG), { recursive: true, force: true });
  try {
    await unregisterTool(deps, SLUG);
  } catch {
    /* no row */
  }
});

test('the build loop: scaffold → check green → register + reload → serving', async ({
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- the fixture is the point: a uniform signature per file (see below)
  page: _page,
}) => {
  // `page` is unused, but giving every test the same fixtures keeps the
  // file in one worker; split across workers, racing hooks made the app
  // row vanish mid-test.
  test.setTimeout(240_000);

  // scaffold: the real template, baked, linked, committed
  const scaffolded: Json = await scaffoldApp(
    {
      appsRoot: APPS_ROOT,
      templateDir: path.join(REPO, 'runtime', 'app-starter'),
      agentTemplateFile: path.join(REPO, 'runtime', 'app-agents', 'AGENTS.md'),
      installRoot: REPO,
      run: runChild,
    },
    { name: 'Loop Probe', description: 'the e2e build-loop run' },
  );
  expect(scaffolded.ok, JSON.stringify(scaffolded)).toBe(true);
  if (!scaffolded.ok) return;
  expect(scaffolded.data).toMatchObject({ slug: SLUG, linked: true, committed: true });

  // The gate: one quiet envelope, green.
  const checked: Json = await checkApp({ appsRoot: APPS_ROOT, run: runChild }, SLUG);
  expect(checked.ok, JSON.stringify(checked)).toBe(true);
  if (!checked.ok) return;
  const envelope = checked.data.envelope;
  expect(envelope.passed, envelope.output).toBe(true);
  expect(envelope.counts?.tests).toEqual({ pass: 3, fail: 0, skipped: 0 });
  expect(fs.existsSync(path.join(APPS_ROOT, SLUG, 'dist', 'route-table.json'))).toBe(true);

  // Before registration, status shows an unregistered, built tree.
  const pre = await tool(statusTool(deps, SLUG));
  expect(pre.isError).toBe(false);
  expect(pre.body.unregisteredTrees).toEqual([SLUG]);
  expect(pre.body.apps[0]).toMatchObject({
    slug: SLUG,
    registered: false,
    built: true,
    buildStale: false,
    mounted: false,
  });

  // register, then reload (the sync point)
  const registered = await tool(registerTool(deps, SLUG));
  expect(registered.isError, JSON.stringify(registered)).toBe(false);
  expect(registered.body).toMatchObject({
    slug: SLUG,
    name: 'Loop Probe',
    cwd: path.join(APPS_ROOT, SLUG),
  });
  const reloaded = await tool(reloadTool(deps, SLUG));
  expect(reloaded.isError, JSON.stringify(reloaded)).toBe(false);
  expect(
    [...(reloaded.body.mounted ?? []), ...(reloaded.body.reimported ?? [])],
    JSON.stringify(reloaded.body),
  ).toContain(SLUG);
});

/** Registered and mounted, re-established per test since the file may be
 *  split across workers. One status round trip when already right. */
async function ensureRegisteredAndMounted(): Promise<void> {
  const status = await tool(statusTool(deps, SLUG));
  expect(status.isError, JSON.stringify(status)).toBe(false);
  const app = status.body.apps[0] as { registered: boolean } | undefined;
  if (!app?.registered) {
    const registered = await tool(registerTool(deps, SLUG));
    expect(registered.isError, JSON.stringify(registered)).toBe(false);
    // duplicate_slug: another worker just registered it, which is fine.
    expect(
      [true, registered.body?.code === 'duplicate_slug'].some(Boolean),
      JSON.stringify(registered),
    ).toBe(true);
  }
  const reloaded = await tool(reloadTool(deps, SLUG));
  expect(reloaded.isError, JSON.stringify(reloaded)).toBe(false);
  expect(
    [...(reloaded.body.mounted ?? []), ...(reloaded.body.reimported ?? [])],
    JSON.stringify(reloaded.body),
  ).toContain(SLUG);
}

test('the scaffolded app serves through the console origin, and /api/state reports it', async ({
  page,
}) => {
  await ensureRegisteredAndMounted();
  await login(page);
  // The SSR page, through the origin and behind the session gate.
  await page.goto(`/apps/${SLUG}/`);
  await expect(page.locator('wa-card h1')).toHaveText('Loop Probe');
  // The island upgraded: its own rendering replaces the SSR'd content.
  await expect(page.locator('.ping-island p[aria-live="polite"]')).toHaveText('— not pinged yet —');
  const ping = await api(page, 'GET', `/apps/${SLUG}/api/ping?name=loop`);
  expect(ping.status, JSON.stringify(ping.json)).toBe(200);
  expect(ping.json).toMatchObject({ ok: true, resultType: 'ping', data: { hello: 'loop' } });
  // Eventually serving: the flag rides a ~10 s cached host-status snapshot,
  // which an open tab's poll may have taken just before the reload.
  await expect
    .poll(
      async () => {
        const state = await api(page, 'GET', '/api/state');
        const serving = (state.json.apps as Array<{ slug: string; serving: boolean }>).find(
          a => a.slug === SLUG,
        );
        return serving?.serving === true;
      },
      { timeout: 15_000 },
    )
    .toBe(true);
});

test('after unregister the app stops serving but the tree stands (status shows it unregistered)', async ({
  page,
}) => {
  await ensureRegisteredAndMounted();
  await login(page);
  const dropped = await tool(unregisterTool(deps, SLUG));
  expect(dropped.isError, JSON.stringify(dropped)).toBe(false);
  expect(dropped.body.unregister).toBeTruthy();
  expect(dropped.body.reload).toBeTruthy();
  // Gone through the origin (the proxy's unregistered-slug 404)…
  const gone = await api(page, 'GET', `/apps/${SLUG}/`);
  expect(gone.status).toBe(404);
  // …while the tree still stands, unregistered.
  expect(fs.existsSync(path.join(APPS_ROOT, SLUG, 'app.json'))).toBe(true);
  const after = await tool(statusTool(deps, SLUG));
  expect(after.isError).toBe(false);
  expect(after.body.apps[0]).toMatchObject({ slug: SLUG, registered: false, built: true });
});
