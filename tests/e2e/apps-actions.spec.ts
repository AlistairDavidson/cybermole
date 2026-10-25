// The build loop plus the generator: scaffold an app, add_action a 'note'
// action, check green (grown tests, a two-action route table), register and
// reload, then every face answers the same Result JSON: describe, the UI
// island in a real browser, `call` in-process, and one stdio spawn of the
// per-app MCP shim.
//
// Apps-spec discipline: see apps-notes.spec.ts.
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
} from '../support/env';
import {
  callActionTool,
  describeTool,
  registerTool,
  reloadTool,
  statusTool,
  unregisterTool,
} from '../../dist-server/server/apps-mcp.js';
import { addAction } from '../../dist-server/src/lib/apps/apps-actions.js';
import { checkApp } from '../../dist-server/src/lib/apps/apps-gate.js';
import { runChild } from '../../dist-server/src/lib/apps/apps-child.js';

const REPO = path.resolve(__dirname, '..', '..');
const SLUG = 'actions-probe';
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

test('the extended loop: scaffold → add_action → check green → register + reload → serving', async () => {
  test.setTimeout(300_000);

  // scaffold: the real template, baked, linked, committed
  const { scaffoldApp } = await import('../../dist-server/src/lib/apps/apps-scaffold.js');
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

  // add_action's default shape is this spec's example: POST, one `text` field.
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
  // AGENTS.md grew with the table.
  const agents = fs.readFileSync(path.join(tree, 'AGENTS.md'), 'utf8');
  expect(agents.match(/### note[\s\S]*?POST \/apps\/actions-probe\/api\/note/)).toBeTruthy();

  // The gate: the grown unit tests (3 ping + 3 note) and a two-action route table.
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

  // register, then reload (the sync point)
  const registered = await tool(registerTool(deps, SLUG));
  expect(registered.isError, JSON.stringify(registered.body)).toBe(false);
  const reloaded = await tool(reloadTool(deps, SLUG));
  expect(reloaded.isError, JSON.stringify(reloaded.body)).toBe(false);
  expect(
    [...(reloaded.body.mounted ?? []), ...(reloaded.body.reimported ?? [])],
    JSON.stringify(reloaded.body),
  ).toContain(SLUG);
});

/** Registered and mounted, re-established per test. One status round trip
 *  when already right. */
async function ensureRegisteredAndMounted(): Promise<void> {
  const status = await tool(statusTool(deps, SLUG));
  expect(status.isError, JSON.stringify(status)).toBe(false);
  const app = status.body.apps[0] as { registered: boolean } | undefined;
  if (!app?.registered) {
    const registered = await tool(registerTool(deps, SLUG));
    // duplicate_slug: another worker just registered it, which is fine.
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

  // The page serves the new island; driving it in the browser works end to end.
  await page.goto(`/apps/${SLUG}/`);
  await expect(page.locator('.note-island p[aria-live="polite"]')).toHaveText('— not sent yet —');
  await page.fill('.note-island wa-input input', 'from-the-ui');
  await page.click('.note-island wa-button');
  await expect(page.locator('.note-island p[aria-live="polite"]')).toHaveText(
    'ok: received from-the-ui',
  );

  // The page's own API.
  const viaPage = await api(page, 'POST', `/apps/${SLUG}/api/note`, { text: 'from-page' });
  expect(viaPage.status, JSON.stringify(viaPage.json)).toBe(200);
  expect(viaPage.json).toMatchObject({
    ok: true,
    resultType: 'note',
    data: { received: 'from-page' },
  });

  // `call`, in-process: the same Result JSON.
  const viaCall = await tool(
    callActionTool(deps, { slug: SLUG, action: 'note', params: { text: 'from-call' } }),
  );
  expect(viaCall.isError, JSON.stringify(viaCall.body)).toBe(false);
  expect(viaCall.body.resultType).toBe('note');
  expect(viaCall.body.data.received).toBe('from-call');
  expect(typeof viaCall.body.data.at).toBe('number');
  // Only the input values and the epoch-ms `at` differ.
  expect(Object.keys(viaCall.body)).toEqual(['ok', 'resultType', 'data']);
  expect(viaCall.body.ok).toBe(viaPage.json.ok);
  expect(viaCall.body.resultType).toBe(viaPage.json.resultType);
  expect(Object.keys(viaCall.body.data)).toEqual(Object.keys(viaPage.json.data));

  // One shim round trip, spawned as pi spawns it (<shim.js> <slug>): its
  // tools are the route table and calls answer verbatim.
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
  // the GET face through the shim too
  const shimPing = await client.callTool({ name: 'ping', arguments: { name: 'shim-e2e' } });
  expect(JSON.parse((shimPing.content as Array<{ text: string }>)[0].text)).toMatchObject({
    ok: true,
    resultType: 'ping',
    data: { hello: 'shim-e2e' },
  });
  await client.close();
});
