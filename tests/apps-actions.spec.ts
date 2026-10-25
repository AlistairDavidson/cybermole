// apps-actions.spec.ts — task/app-actions (docs/plans/apps-plan.md §1/§6/§10)
// e2e: the action-vocabulary loop continued — the whole §1 build loop PLUS
// the generator: scaffold a fresh app, add_action a 'note' action (POST
// with a text field), check green (the gate — the grown unit tests AND the
// build now emit a two-action route-table.json), register + reload, then
// every face of the ONE vocabulary answers the same Result JSON:
//   describe — the emitted table, the new action in it;
//   the UI face — the page serves the new island's affordance, and driving
//     it through the real browser answers end to end;
//   call — the root agent's use path, in-process through the compiled MCP's
//     own function, the same Result JSON as the page's own API hit;
//   the shim — ONE stdio spawn of the compiled per-app MCP binary
//     (node dist-server/server/app-mcp-shim.js <slug> with the suite's env):
//     its tool list is the route table's names, a call answers verbatim.
//
// Serial + budget rules: one login() for this file; afterAll unregisters
// and removes the tree so the fixture world stays exact for the other
// specs. This file runs FIRST among the apps specs (alphabetical), before
// apps-scaffold.spec.ts and apps.spec.ts — its leftovers would poison both.
import { expect, test } from '@playwright/test';
import type { Cookie, Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
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
  callActionTool,
  describeTool,
  registerTool,
  reloadTool,
  statusTool,
  unregisterTool,
} from '../dist-server/server/apps-mcp.js';
import { addAction } from '../dist-server/src/lib/apps-actions.js';
import { checkApp } from '../dist-server/src/lib/apps-gate.js';
import { runChild } from '../dist-server/src/lib/apps-child.js';

const REPO = path.resolve(__dirname, '..');
const SLUG = 'actions-probe';
/** The entry sweep's once-per-run latch (see beforeAll): inside
 * APPS_ROOT, so the hermetic WORKSPACE's per-run rm -rf makes it
 * run-scoped — nothing else ever needs to clear it. */
const SWEEP_MARKER = path.join(APPS_ROOT, `.${SLUG}.swept`);
/** The MCP's own deps shape, resolved like main() would — against THIS
 *  suite's sockets and hermetic apps root (apps-scaffold.spec.ts's shape). */
const deps = {
  appsRoot: APPS_ROOT,
  internalSocketPath: INTERNAL_SOCKET,
  appsSocketPath: APPS_SOCKET,
  installRoot: REPO,
};

// dist-server ships no .d.ts, so the compiled verbs' answers are read
// as loose JSON here (the units assert the typed shapes).
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
  body?: unknown,
): // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the parsed body, callers narrow it
Promise<{ status: number; json: any }> {
  return page.evaluate(
    async ([m, u, b]) => {
      const r = await fetch(u!, {
        method: m!,
        ...(b === undefined
          ? {}
          : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }),
      });
      return { status: r.status, json: await r.json().catch(() => null) };
    },
    [method, url, body] as const,
  );
}

/** Signs in ONCE for the whole RUN — the cookie is shared with the
 *  sibling apps specs through the workspace file (env.ts's helpers:
 *  the three apps files were each burning one of the 10/15-min login
 *  attempts, pushing the suite's late re-logins into 429s). */
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

test('the extended loop: scaffold → add_action → check green → register + reload → serving', async () => {
  test.setTimeout(300_000);

  // scaffold — the real template, baked, linked, committed.
  const { scaffoldApp } = await import('../dist-server/src/lib/apps-scaffold.js');
  const scaffolded: Json = await scaffoldApp(
    {
      appsRoot: APPS_ROOT,
      templateDir: path.join(REPO, 'runtime', 'app-starter'),
      agentTemplateFile: path.join(REPO, 'runtime', 'app-agents', 'AGENTS.md'),
      installRoot: REPO,
      run: runChild,
    },
    { name: 'Actions Probe', description: 'the e2e action-vocabulary run' },
  );
  expect(scaffolded.ok, JSON.stringify(scaffolded)).toBe(true);
  if (!scaffolded.ok) return;
  expect(scaffolded.data).toMatchObject({ slug: SLUG, linked: true, committed: true });
  const tree = scaffolded.data.tree as string;

  // add_action — the generator, in lockstep from one table entry. The
  // default shape IS the spec's example: POST, one `text` field.
  const added: Json = await addAction(
    { appsRoot: APPS_ROOT },
    { slug: SLUG, name: 'note', summary: 'captures a short note' },
  );
  expect(added.ok, JSON.stringify(added)).toBe(true);
  if (!added.ok) return;
  expect(added.data.action).toBe('note');
  expect(added.data.method).toBe('POST');
  expect(added.data.written.map((w: { file: string }) => w.file)).toEqual([
    'src/lib/note.ts',
    'src/routes.ts',
    'tests/note.test.mjs',
    'src/islands/NoteIsland.tsx',
    'src/pages/index.astro',
    'AGENTS.md',
  ]);
  expect(added.data.next.join(' ')).toMatch(/check/);
  expect(added.data.next.join(' ')).toMatch(/build/);
  expect(added.data.next.join(' ')).toMatch(/reload/);
  // the operator manual grew with the table (the block regeneration).
  const agents = fs.readFileSync(path.join(tree, 'AGENTS.md'), 'utf8');
  expect(agents.match(/### note[\s\S]*?POST \/apps\/actions-probe\/api\/note/)).toBeTruthy();

  // check — THE gate, green: the grown unit tests (3 ping + 3 note) and
  // the build's emitted two-action route table.
  const checked: Json = await checkApp({ appsRoot: APPS_ROOT, run: runChild }, SLUG);
  expect(checked.ok, JSON.stringify(checked)).toBe(true);
  if (!checked.ok) return;
  expect(checked.data.envelope.passed, checked.data.envelope.output).toBe(true);
  expect(checked.data.envelope.counts.tests).toEqual({ pass: 6, fail: 0, skipped: 0 });
  expect(
    JSON.parse(fs.readFileSync(path.join(tree, 'dist', 'route-table.json'), 'utf8')).map(
      (e: { name: string }) => e.name,
    ),
  ).toEqual(['ping', 'note']);

  // register + reload — the sync point (§1's order: row first, then sync).
  const registered = await tool(registerTool(deps, SLUG));
  expect(registered.isError, JSON.stringify(registered.body)).toBe(false);
  const reloaded = await tool(reloadTool(deps, SLUG));
  expect(reloaded.isError, JSON.stringify(reloaded.body)).toBe(false);
  expect(
    [...(reloaded.body.mounted ?? []), ...(reloaded.body.reimported ?? [])],
    JSON.stringify(reloaded.body),
  ).toContain(SLUG);
});

/** The page test's shared precondition: the app REGISTERED and
 *  MOUNTED, established idempotently — the scheduler-split note in
 *  beforeAll means no file-order state assumptions. Cheap when the
 *  world is already right: one statusTool round-trip. */
async function ensureRegisteredAndMounted(): Promise<void> {
  const status = await tool(statusTool(deps, SLUG));
  expect(status.isError, JSON.stringify(status)).toBe(false);
  const app = status.body.apps[0] as { registered: boolean } | undefined;
  if (!app?.registered) {
    const registered = await tool(registerTool(deps, SLUG));
    // duplicate_slug = another worker just registered it (green);
    // isError + anything else is a real failure.
    expect(
      !registered.isError || registered.body?.code === 'duplicate_slug',
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

test('every face of the one vocabulary: describe, the UI island, call, and one shim round-trip', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await ensureRegisteredAndMounted();
  await login(page);

  // describe — the emitted table, the new action in it.
  const described = await tool(describeTool(deps, SLUG));
  expect(described.isError).toBe(false);
  expect(
    described.body.map((e: { name: string; method: string; path: string }) => [
      e.name,
      e.method,
      e.path,
    ]),
  ).toEqual([
    ['ping', 'GET', '/api/ping'],
    ['note', 'POST', '/api/note'],
  ]);
  expect(described.body[1].input.required).toEqual(['text']);

  // the UI face: the page serves the new island's affordance, SSR'd, and
  // driving it through the real browser answers end to end (the typed
  // client on the same table the API serves).
  await page.goto(`/apps/${SLUG}/`);
  await expect(page.locator('.note-island p[aria-live="polite"]')).toHaveText('— not sent yet —');
  await page.fill('.note-island wa-input input', 'from-the-ui');
  await page.click('.note-island wa-button');
  await expect(page.locator('.note-island p[aria-live="polite"]')).toHaveText(
    'ok: received from-the-ui',
  );

  // the page's own API hit — the Result JSON face the UI consumes.
  const viaPage = await api(page, 'POST', `/apps/${SLUG}/api/note`, { text: 'from-page' });
  expect(viaPage.status, JSON.stringify(viaPage.json)).toBe(200);
  expect(viaPage.json).toMatchObject({
    ok: true,
    resultType: 'note',
    data: { received: 'from-page' },
  });

  // call — the root agent's use path, in-process through the compiled
  // MCP's own function: the SAME Result JSON as the page's face (§0).
  const viaCall = await tool(
    callActionTool(deps, { slug: SLUG, action: 'note', params: { text: 'from-call' } }),
  );
  expect(viaCall.isError, JSON.stringify(viaCall.body)).toBe(false);
  expect(viaCall.body.resultType).toBe('note');
  expect(viaCall.body.data.received).toBe('from-call');
  expect(typeof viaCall.body.data.at).toBe('number');
  // the shapes agree (the input values and the epoch-ms `at` are the only
  // legitimate differences) — one vocabulary, every face (§0).
  expect(Object.keys(viaCall.body)).toEqual(['ok', 'resultType', 'data']);
  expect(viaCall.body.ok).toBe(viaPage.json.ok);
  expect(viaCall.body.resultType).toBe(viaPage.json.resultType);
  expect(Object.keys(viaCall.body.data)).toEqual(Object.keys(viaPage.json.data));

  // ONE shim round-trip — the compiled per-app binary, spawned as pi
  // spawns it (the tree's .pi/mcp.json entry: <shim.js> <slug>), spoken
  // to over stdio: the tool list IS the route table, a call answers the
  // same verbatim Result JSON (a child process, not a per-test server).
  const client = new Client({ name: 'apps-actions-e2e', version: '0' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(REPO, 'dist-server', 'server', 'app-mcp-shim.js'), SLUG],
      env: { CYBERMOLE_APPS_ROOT: APPS_ROOT, CYBERMOLE_APPS_SOCK: APPS_SOCKET },
    }),
  );
  const tools = await client.listTools();
  expect(tools.tools.map(t => t.name)).toEqual(['ping', 'note']);
  expect(tools.tools[1].description).toContain('captures a short note');
  const shimCall = await client.callTool({ name: 'note', arguments: { text: 'from-shim' } });
  expect(shimCall.isError, JSON.stringify(shimCall.content)).not.toBe(true);
  const shimBody = JSON.parse((shimCall.content as Array<{ text: string }>)[0].text);
  expect(shimBody).toMatchObject({ ok: true, resultType: 'note', data: { received: 'from-shim' } });
  // the GET face through the shim too: THE request the entry names.
  const shimPing = await client.callTool({ name: 'ping', arguments: { name: 'shim-e2e' } });
  expect(JSON.parse((shimPing.content as Array<{ text: string }>)[0].text)).toMatchObject({
    ok: true,
    resultType: 'ping',
    data: { hello: 'shim-e2e' },
  });
  await client.close();
});
