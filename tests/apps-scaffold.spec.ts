// apps-scaffold.spec.ts — task/app-scaffold (docs/apps-plan.md §1/§6/§10)
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
import { APPS_ROOT, APPS_SOCKET, INTERNAL_SOCKET, PASSWORD, USERNAME } from './env';
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

test.beforeAll(async () => {
  // A leftover from an aborted run must not wedge scaffold (never
  // overwrites): drop it through the verbs + fs, the same cleanup
  // afterAll performs.
  fs.rmSync(path.join(APPS_ROOT, SLUG), { recursive: true, force: true });
});

test.afterAll(async () => {
  // Leave the fixture world exact: row dropped (the tree-following
  // cascade is the API's own semantics), mount synced away, tree gone.
  try {
    await unregisterTool(deps, SLUG);
    fs.rmSync(path.join(APPS_ROOT, SLUG), { recursive: true, force: true });
  } catch {
    /* the suite's server is gone — nothing left to clean */
  }
});

test('the build loop: scaffold → check green → register + reload → serving', async () => {
  test.setTimeout(240_000);

  // scaffold — the real template, baked, linked, committed.
  const scaffolded: Json = await scaffoldApp(
    {
      appsRoot: APPS_ROOT,
      templateDir: path.join(REPO, 'app-starter'),
      agentTemplateFile: path.join(REPO, 'apps-agent-template', 'AGENTS.md'),
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

test('the scaffolded app serves through the console origin, and /api/state reports it', async ({
  page,
}) => {
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
  // /api/state carries the app as serving (the web side's host ping).
  const state = await api(page, 'GET', '/api/state');
  const serving = (state.json.apps as Array<{ slug: string; serving: boolean }>).find(
    a => a.slug === SLUG,
  );
  expect(serving, JSON.stringify(state.json.apps)).toBeDefined();
  expect(serving?.serving).toBe(true);
});

test('after unregister the app stops serving but the tree stands (status shows it unregistered)', async ({
  page,
}) => {
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
