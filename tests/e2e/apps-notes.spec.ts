// The notes reference app's use loop, on the shipped tree. Seeds
// runtime/reference-apps/notes into the hermetic apps root, re-bakes this
// checkout's install root, runs the check gate, registers and reloads, then
// walks it through the console origin: create via the island, the page's
// API and `call` (one Result JSON on every face); list via the page and
// describe/call; archive hides from the default list without deleting; and
// an empty title answers the same error code on every face, the MCP shim
// included.
//
// Apps-spec discipline: one login() via the shared cookie file (env.ts); no
// afterAll (rows die with the per-run db, trees with the per-run WORKSPACE
// rm); the entry sweep is marker-gated once per run; per-test preconditions
// are re-established idempotently (ensureRegisteredAndMounted).
import { expect, test } from '@playwright/test';
import type { Cookie, Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
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
import { checkApp } from '../../dist-server/src/lib/apps/apps-gate.js';
import { runChild } from '../../dist-server/src/lib/apps/apps-child.js';

const REPO = path.resolve(__dirname, '..', '..');
const SLUG = 'notes';
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

/** Copy the sources (never dist/ or a db), re-bake this checkout's install
 *  root, link the core stack, and git init (as the scaffold does). */
function seedReferenceTree(): string {
  const tree = path.join(APPS_ROOT, SLUG);
  fs.rmSync(tree, { recursive: true, force: true });
  fs.cpSync(path.join(REPO, 'runtime', 'reference-apps', 'notes'), tree, { recursive: true });
  const bake = (rel: string, from: string, to: string): void => {
    const file = path.join(tree, rel);
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').split(from).join(to));
  };
  bake(
    path.join('scripts', 'setup-node-modules.mjs'),
    "const BAKED_INSTALL_ROOT = '/opt/cybermole';",
    `const BAKED_INSTALL_ROOT = '${REPO}';`,
  );
  bake(
    path.join('.pi', 'mcp.json'),
    '/opt/cybermole/dist-server/server/app-mcp-shim.js',
    path.join(REPO, 'dist-server', 'server', 'app-mcp-shim.js'),
  );
  execFileSync('node', ['scripts/setup-node-modules.mjs'], { cwd: tree });
  execFileSync('git', ['init', '-b', 'main', '-q'], { cwd: tree });
  execFileSync('git', ['add', '-A'], { cwd: tree });
  execFileSync(
    'git',
    [
      '-c',
      'user.name=cybermole-apps',
      '-c',
      'user.email=cybermole-apps@localhost',
      'commit',
      '-q',
      '-m',
      'seed the notes reference app from the shipped tree',
    ],
    { cwd: tree },
  );
  return tree;
}

test('the shipped reference tree: seed → check green → register + reload → mounted', async ({
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- the fixture is the point: a uniform signature per file (one worker)
  page: _page,
}) => {
  test.setTimeout(240_000);

  // seed, as the image's entrypoint does
  const tree = seedReferenceTree();
  expect(fs.existsSync(path.join(tree, 'app.json'))).toBe(true);
  expect(fs.existsSync(path.join(tree, 'data', 'app.db'))).toBe(false); // never a db in the seed

  // Before registration, status shows an unregistered tree.
  const pre = await tool(statusTool(deps, SLUG));
  expect(pre.isError, JSON.stringify(pre.body)).toBe(false);
  expect(pre.body.unregisteredTrees).toEqual([SLUG]);

  // The gate: typecheck, the tree's unit tests, and the build.
  const checked: Json = await checkApp({ appsRoot: APPS_ROOT, run: runChild }, SLUG);
  expect(checked.ok, JSON.stringify(checked)).toBe(true);
  if (!checked.ok) return;
  expect(checked.data.envelope.passed, checked.data.envelope.output).toBe(true);
  expect(checked.data.envelope.counts.tests).toEqual({ pass: 33, fail: 0, skipped: 0 });
  expect(checked.data.envelope.output).toContain('all green');

  // register, then reload (the sync point)
  const registered = await tool(registerTool(deps, SLUG));
  expect(registered.isError, JSON.stringify(registered.body)).toBe(false);
  expect(registered.body).toMatchObject({
    slug: SLUG,
    name: 'Notes',
    cwd: path.join(APPS_ROOT, SLUG),
  });
  const reloaded = await tool(reloadTool(deps, SLUG));
  expect(reloaded.isError, JSON.stringify(reloaded.body)).toBe(false);
  expect(
    [...(reloaded.body.mounted ?? []), ...(reloaded.body.reimported ?? [])],
    JSON.stringify(reloaded.body),
  ).toContain(SLUG);
});

/** Registered and mounted, established idempotently (no file-order
 *  assumptions). One status round trip when already right. */
async function ensureRegisteredAndMounted(): Promise<void> {
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
  const reloaded = await tool(reloadTool(deps, SLUG));
  expect(reloaded.isError, JSON.stringify(reloaded.body)).toBe(false);
  expect(
    [...(reloaded.body.mounted ?? []), ...(reloaded.body.reimported ?? [])],
    JSON.stringify(reloaded.body),
  ).toContain(SLUG);
}

test('the use loop through the console origin: list, capture on every face, find, archive', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await ensureRegisteredAndMounted();
  await login(page);

  // The list page renders through the console origin, behind the session gate.
  await page.goto(`/apps/${SLUG}/`);
  await expect(page.locator('wa-card h1')).toHaveText('Notes');
  await expect(page.locator('.note-editor wa-button')).toHaveText('save note');

  // ---- note_create via the UI island ----
  await page.locator('.note-editor wa-input').nth(0).locator('input').fill('UI-created note');
  await page
    .locator('.note-editor wa-textarea textarea')
    .fill('captured through the island in a real browser');
  await page.locator('.note-editor wa-input').nth(1).locator('input').fill('standup, journal');
  await page.locator('.note-editor wa-button').click();
  await expect(page.locator('.note-editor p[aria-live="polite"]')).toHaveText(
    /saved: UI-created note \(#\d+\)/,
  );

  // ---- note_create via the page's API ----
  const viaPage = await api(page, 'POST', `/apps/${SLUG}/api/notes`, {
    title: 'from-the-page',
    body: 'created through the page API face',
    tags: ['ui'],
  });
  expect(viaPage.status, JSON.stringify(viaPage.json)).toBe(201);
  expect(viaPage.json).toMatchObject({
    ok: true,
    resultType: 'note_create',
    data: { note: { title: 'from-the-page', tags: ['ui'], archived: false } },
  });

  // ---- note_create via `call`: the same Result JSON (only timestamps differ) ----
  const viaCall = await tool(
    callActionTool(deps, {
      slug: SLUG,
      action: 'note_create',
      params: { title: 'from-call', body: 'created through call', tags: ['call'] },
    }),
  );
  expect(viaCall.isError, JSON.stringify(viaCall.body)).toBe(false);
  expect(viaCall.body.ok).toBe(viaPage.json.ok);
  expect(viaCall.body.resultType).toBe(viaPage.json.resultType);
  expect(Object.keys(viaCall.body)).toEqual(['ok', 'resultType', 'data']);
  expect(Object.keys(viaCall.body.data.note)).toEqual(Object.keys(viaPage.json.data.note));
  expect(viaCall.body.data.note.title).toBe('from-call');
  const callNoteId = viaCall.body.data.note.id as number;
  expect(typeof callNoteId).toBe('number');

  // ---- note_list: describe, call, and the page ----
  const described = await tool(describeTool(deps, SLUG));
  expect(described.isError).toBe(false);
  const table = described.body as Array<{ name: string; method: string; path: string }>;
  expect(table.map(e => [e.name, e.method, e.path])).toEqual([
    ['ping', 'GET', '/api/ping'],
    ['note_create', 'POST', '/api/notes'],
    ['note_list', 'GET', '/api/notes'],
    ['note_get', 'GET', '/api/notes/:id'],
    ['note_edit', 'PATCH', '/api/notes/:id'],
    ['note_archive', 'POST', '/api/notes/:id/archive'],
  ]);
  const listEntry = (described.body as Array<{ name: string; input: Json }>)[2]!;
  expect(listEntry.input.required ?? []).toEqual([]);
  const listed = await tool(
    callActionTool(deps, { slug: SLUG, action: 'note_list', params: { search: 'from-' } }),
  );
  expect(listed.isError, JSON.stringify(listed.body)).toBe(false);
  expect(listed.body.data.count).toBe(2);
  expect((listed.body.data.notes as Array<{ title: string }>).map(n => n.title).sort()).toEqual([
    'from-call',
    'from-the-page',
  ]);

  // Reload shows all three; the no-JS search form narrows to one.
  await page.goto(`/apps/${SLUG}/`);
  await expect(page.locator('.notes a')).toHaveCount(3);
  await page.locator('form.find input[name="search"]').fill('from-call');
  await page.locator('form.find button[type="submit"]').click();
  await expect(page.locator('.notes a')).toHaveCount(1);
  await expect(page.locator('.notes a')).toHaveText('from-call');

  // ---- an empty title answers the same error code on every face ----
  const badViaPage = await api(page, 'POST', `/apps/${SLUG}/api/notes`, { title: '   ' });
  expect(badViaPage.status).toBe(400);
  expect(badViaPage.json).toMatchObject({
    ok: false,
    resultType: 'note_create',
    errorCode: 'invalid_title',
    errorMessage: 'title is required',
  });
  const badViaCall = await tool(
    callActionTool(deps, { slug: SLUG, action: 'note_create', params: { title: '   ' } }),
  );
  expect(badViaCall.isError).toBe(false);
  expect(badViaCall.body).toMatchObject({
    ok: false,
    resultType: 'note_create',
    errorCode: 'invalid_title',
  });
  // …including the island's own line.
  await page.locator('.note-editor wa-input').nth(0).locator('input').fill('   ');
  await page.locator('.note-editor wa-button').click();
  await expect(page.locator('.note-editor p[aria-live="polite"]')).toHaveText(
    'error: title is required',
  );

  // ---- note_edit through the island on the note page ----
  const toEdit = listed.body.data.notes.find((n: { title: string }) => n.title === 'from-call') as {
    id: number;
  };
  await page.goto(`/apps/${SLUG}/notes/${toEdit.id}`);
  await expect(page.locator('wa-card h1')).toHaveText('from-call');
  await page.locator('.note-editor wa-input').nth(0).locator('input').fill('from-call, edited');
  await page.locator('.note-editor wa-button').first().click();
  await expect(page.locator('.note-editor p[aria-live="polite"]')).toHaveText(
    'saved: from-call, edited',
  );
  const reread = await tool(
    callActionTool(deps, { slug: SLUG, action: 'note_get', params: { id: toEdit.id } }),
  );
  expect(reread.body.data.note.title).toBe('from-call, edited');

  // ---- note_archive: gone from the default list, still findable archived ----
  const archived = await tool(
    callActionTool(deps, { slug: SLUG, action: 'note_archive', params: { id: toEdit.id } }),
  );
  expect(archived.isError).toBe(false);
  expect(archived.body.data.note).toMatchObject({ id: toEdit.id, archived: true });
  await page.goto(`/apps/${SLUG}/`);
  await expect(page.locator('.notes a')).toHaveCount(2); // the archived one is hidden
  await expect(page.locator('.notes a', { hasText: 'edited' })).toHaveCount(0);
  await page.goto(`/apps/${SLUG}/?archived=true`);
  await expect(page.locator('.notes a')).toHaveCount(1);
  await expect(page.locator('.notes a')).toHaveText('from-call, edited');
  await expect(page.locator('.notes wa-badge').first()).toHaveText('archived');
  // Hidden from the list only: note_get and the note page still serve it.
  const stillThere = await tool(
    callActionTool(deps, { slug: SLUG, action: 'note_list', params: { search: 'edited' } }),
  );
  expect(stillThere.body.data.count).toBe(0);
  const gotArchived = await tool(
    callActionTool(deps, { slug: SLUG, action: 'note_get', params: { id: toEdit.id } }),
  );
  expect(gotArchived.body.data.note.archived).toBe(true);
});

test('the app MCP shim: the table\u2019s tools over stdio, note_get by id, the same closed codes', async ({
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- the fixture is the point: a uniform signature per file (one worker)
  page: _page,
}) => {
  test.setTimeout(60_000);
  await ensureRegisteredAndMounted();

  // One stdio spawn of the per-app shim, as .pi/mcp.json registers it: its
  // tools are the route table and calls answer the app's JSON verbatim.
  const client = new Client({ name: 'apps-notes-e2e', version: '0' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(REPO, 'dist-server', 'server', 'app-mcp-shim.js'), SLUG],
      env: { CYBERMOLE_APPS_ROOT: APPS_ROOT, CYBERMOLE_APPS_SOCK: APPS_SOCKET },
    }),
  );
  const tools = await client.listTools();
  expect(tools.tools.map(t => t.name)).toEqual([
    'ping',
    'note_create',
    'note_list',
    'note_get',
    'note_edit',
    'note_archive',
  ]);
  expect(tools.tools[2]!.description).toContain('list notes');

  // Create via call, then note_get by id through the shim: the same note.
  const created = await tool(
    callActionTool(deps, {
      slug: SLUG,
      action: 'note_create',
      params: { title: 'shim round-trip', tags: ['shim'] },
    }),
  );
  expect(created.body.ok).toBe(true);
  const id = created.body.data.note.id as number;
  const got = await client.callTool({ name: 'note_get', arguments: { id } });
  expect(got.isError, JSON.stringify(got.content)).not.toBe(true);
  expect(JSON.parse((got.content as Array<{ text: string }>)[0].text)).toMatchObject({
    ok: true,
    resultType: 'note_get',
    data: { note: { id, title: 'shim round-trip', tags: ['shim'] } },
  });

  // The empty-title failure through the shim too: the same code.
  const bad = await client.callTool({ name: 'note_create', arguments: { title: '   ' } });
  expect(JSON.parse((bad.content as Array<{ text: string }>)[0].text)).toMatchObject({
    ok: false,
    resultType: 'note_create',
    errorCode: 'invalid_title',
    errorMessage: 'title is required',
  });
  await client.close();
});

test("the WS example: a write in one tab updates another tab's list without a reload", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await ensureRegisteredAndMounted();
  await login(page);
  await page.goto(`/apps/${SLUG}/`);

  // A second tab of the same list (the shared context carries the cookie).
  const p2 = await page.context().newPage();
  await p2.goto(`/apps/${SLUG}/`);
  await p2.evaluate(() => (document.body.dataset.liveSentinel = 'alive'));
  const before = await page.locator('.notes a').count();
  await expect(p2.locator('.notes a')).toHaveCount(before);

  // Any writer — here the page API — broadcasts notes_changed; both tabs'
  // lists refresh on their own (the capturing tab's own list included,
  // which the island's save used to leave stale until a manual reload).
  const made = await api(page, 'POST', `/apps/${SLUG}/api/notes`, {
    title: 'live-list note',
    body: 'created from another tab',
    tags: ['ws'],
  });
  expect(made.status, JSON.stringify(made.json)).toBe(201);
  await expect(p2.locator('.notes a', { hasText: 'live-list note' })).toHaveCount(1);
  await expect(p2.locator('.notes a')).toHaveCount(before + 1);
  await expect(page.locator('.notes a', { hasText: 'live-list note' })).toHaveCount(1);
  // And it really was push: neither tab reloaded.
  expect(await p2.evaluate(() => document.body.dataset.liveSentinel ?? '')).toBe('alive');

  // The walkthrough asserts exact list counts later in the run only through
  // its own notes; still, keep this test's world as it found it: archive
  // the note out of the live list (both tabs see that signal too).
  const id = made.json.data.note.id as number;
  const archived = await api(page, 'POST', `/apps/${SLUG}/api/notes/${id}/archive`);
  expect(archived.status, JSON.stringify(archived.json)).toBe(200);
  await expect(p2.locator('.notes a')).toHaveCount(before);
  await p2.close();
});
