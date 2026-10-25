// apps-scaffold.spec.ts — task/app-scaffold (docs/plans/apps-plan.md §1/§6/§10)
// e2e: the WHOLE build loop through the cybermole-apps verbs, against the
// shared webServer's real sockets — scaffold a REAL app into the hermetic
// apps root (the tree lands in WORKSPACE/apps), check it green (the gate,
// one quiet envelope — this is also the starter template's live
// verification: a real kit-consuming check + build + self-containment
// gate), register + reload, then assert it SERVES through the console
// origin (SSR page + the example action's Result JSON) and shows up in
// /api/state serving.
//
// The verbs are the compiled MCP module's own functions (registerTool,
// reloadTool, … — the exact code the stdio tools call), invoked
// IN-PROCESS: the e2e exercises the loop, not stdio plumbing (the tool
// wiring has its own unit).
//
// Serial + budget rules: one login() for this file; afterAll unregisters
// and removes the tree so the fixture world (one app, "alpha app"; the
// app-fixture tree) stays exact for the other specs. This file runs
// BEFORE apps.spec.ts (alphabetical), so its leftovers would poison it.
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
} from './env';
import {
  registerTool,
  reloadTool,
  statusTool,
  unregisterTool,
} from '../dist-server/server/apps-mcp.js';
import { runChild } from '../dist-server/src/lib/apps-child.js';
import { scaffoldApp } from '../dist-server/src/lib/apps-scaffold.js';
import { checkApp } from '../dist-server/src/lib/apps-gate.js';

const REPO = path.resolve(__dirname, '..');
const SLUG = 'loop-probe';
/** The entry sweep's once-per-run latch (see beforeAll): inside
 * APPS_ROOT, so the hermetic WORKSPACE's per-run rm -rf makes it
 * run-scoped — nothing else ever needs to clear it. */
const SWEEP_MARKER = path.join(APPS_ROOT, `.${SLUG}.swept`);
/** The MCP's own deps shape, resolved like main() would — against THIS
 *  suite's sockets and hermetic apps root. */
const deps = {
  appsRoot: APPS_ROOT,
  internalSocketPath: INTERNAL_SOCKET,
  appsSocketPath: APPS_SOCKET,
  installRoot: REPO,
};

// dist-server ships no .d.ts, so the compiled verbs' answers are read
// as loose JSON here (the units assert the typed shapes); one disable
// covers the spec's parsed-answer style.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- parsed tool JSON
type Json = any;

/** One tool answer: isError + the parsed body (the tools' result shape). */
async function tool(
  run: Promise<{ isError?: boolean; content?: Array<{ text?: string }> } | undefined>,
): Promise<{ isError: boolean; body: Json }> {
  const r = await run;
  return { isError: r?.isError === true, body: JSON.parse(r?.content?.[0]?.text ?? '{}') };
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

/** Signs in ONCE for this file, the cookie reused after (apps.spec.ts's
 *  helper, copied — the shared 10/15-min login budget). */
/** Signs in ONCE for the whole RUN — the shared cookie file first (the
 *  sibling apps specs' login budget note, env.ts), this file's own
 *  sign-in only when nobody has signed in yet. */
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
  // ENTRY sweep — idempotent by INTENT, but GATED once per run by the
  // marker: the scheduler may split this file across workers, and a
  // replacement worker's re-run beforeAll would otherwise unregister +
  // rm the app an earlier worker's tests in THIS run just built (the
  // observed mid-test vanishing). The marker lives inside APPS_ROOT
  // (under the hermetic WORKSPACE — global-setup's per-run rm -rf makes
  // it run-scoped) and NOTHING removes it mid-run (there is no afterAll:
  // the run's true cleanup is structural — rows die with the per-run db,
  // trees with the per-run WORKSPACE rm; later files sweep their own
  // slugs at entry the same way).
  if (fs.existsSync(SWEEP_MARKER)) return;
  fs.mkdirSync(APPS_ROOT, { recursive: true });
  fs.writeFileSync(SWEEP_MARKER, `${process.pid} ${Date.now()}\n`);
  fs.rmSync(path.join(APPS_ROOT, SLUG), { recursive: true, force: true });
  try {
    await unregisterTool(deps, SLUG);
  } catch {
    /* no row — fine */
  }
});

test('the build loop: scaffold → check green → register + reload → serving', async ({
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- the fixture is the point: a uniform signature per file (see below)
  page: _page,
}) => {
  // `page` asked for (and unused): every test in this file then carries
  // the SAME fixture signature, so Playwright's scheduler keeps the file
  // in ONE worker — a mixed fixture set let it split the file across
  // workers, whose re-run hooks and racing teardowns made the shared
  // app row vanish mid-test (the pair-run flake). The unused browser
  // context is ~300ms once per file.
  test.setTimeout(240_000);

  // scaffold — the real template, baked, linked, committed.
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

  // check — THE gate: one quiet envelope, green (this run is the starter
  // template's live verification: astro check + tsc + units + build +
  // the §5 self-containment gate, all in the scaffolded tree).
  const checked: Json = await checkApp({ appsRoot: APPS_ROOT, run: runChild }, SLUG);
  expect(checked.ok, JSON.stringify(checked)).toBe(true);
  if (!checked.ok) return;
  const envelope = checked.data.envelope;
  expect(envelope.passed, envelope.output).toBe(true);
  expect(envelope.counts?.tests).toEqual({ pass: 3, fail: 0, skipped: 0 });
  expect(fs.existsSync(path.join(APPS_ROOT, SLUG, 'dist', 'route-table.json'))).toBe(true);

  // the status join BEFORE registration: an unregistered tree, built.
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

  // register + reload — the sync point (§1's order: row first, then sync).
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

/** The browser tests' shared precondition: the app REGISTERED and
 *  MOUNTED, established idempotently. The suite's Playwright scheduler
 *  may split this file across workers (observed: hooks re-run in a
 *  replacement worker while another worker's afterAll tears down the
 *  previous state — the registration a file-order assumption made
 *  vanish mid-test), so each page test re-asserts the world it needs
 *  instead of inheriting it from the previous test. Cheap when the
 *  world is already right: one statusTool round-trip. */
async function ensureRegisteredAndMounted(): Promise<void> {
  const status = await tool(statusTool(deps, SLUG));
  expect(status.isError, JSON.stringify(status)).toBe(false);
  const app = status.body.apps[0] as { registered: boolean } | undefined;
  if (!app?.registered) {
    const registered = await tool(registerTool(deps, SLUG));
    expect(registered.isError, JSON.stringify(registered)).toBe(false);
    // duplicate_slug is the API's green "already there" answer for a
    // row another worker just registered (the scheduler-split note in
    // beforeAll) — it satisfies the precondition the same as a fresh
    // register; every other body is a failure the expect above caught.
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
  // The SSR page (the wa-card's header slot is light DOM inside the
  // astro-lit declarative-shadow-DOM pipeline) — through the origin,
  // behind the session gate.
  await page.goto(`/apps/${SLUG}/`);
  await expect(page.locator('wa-card h1')).toHaveText('Loop Probe');
  // The island upgraded in the real browser: the preact-signals island's
  // own rendering (its aria-live paragraph) replaces the SSR'd initial
  // content once the client script runs.
  await expect(page.locator('.ping-island p[aria-live="polite"]')).toHaveText('— not pinged yet —');
  // The example action's API answers its Result JSON through the origin.
  const ping = await api(page, 'GET', `/apps/${SLUG}/api/ping?name=loop`);
  expect(ping.status, JSON.stringify(ping.json)).toBe(200);
  expect(ping.json).toMatchObject({ ok: true, resultType: 'ping', data: { hello: 'loop' } });
  // /api/state carries the app as serving — EVENTUALLY: the flag rides
  // a ~10 s success-cached host-status snapshot (apps-serving.ts — a
  // still-open tab's poll can cache a pre-mount snapshot a moment before
  // the reload lands), so the assertion POLLS past the cache window
  // instead of demanding an instant the design deliberately doesn't
  // promise.
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
  // gone through the origin (the proxy's unregistered-slug 404)…
  const gone = await api(page, 'GET', `/apps/${SLUG}/`);
  expect(gone.status).toBe(404);
  // …and the tree still stands at the apps root, honestly unregistered.
  expect(fs.existsSync(path.join(APPS_ROOT, SLUG, 'app.json'))).toBe(true);
  const after = await tool(statusTool(deps, SLUG));
  expect(after.isError).toBe(false);
  expect(after.body.apps[0]).toMatchObject({ slug: SLUG, registered: false, built: true });
});
