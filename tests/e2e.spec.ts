// e2e.spec.ts — integration tests against the real built app:
// Astro SSR pages, wa-* components upgraded client-side, auth, the
// workspace/terminal fixture tree (tests/global-setup.ts), and the full
// terminal round trip (xterm → WS → node-pty → tmux → back).
// Runs serially (workers: 1) — see playwright.config.ts.
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
// Namespace import on purpose: a named `WebSocket` import would shadow the
// global for the WHOLE module after esbuild's CJS transform — every
// `WebSocket` inside in-page evaluate closures would be rewritten to the
// node binding (…ReferenceError: _ws2 is not defined… in the browser).
import * as nodeWs from 'ws';
import { expect, test, type Cookie, type Locator, type Page } from '@playwright/test';
import { WebSocket as NodeWebSocket } from 'ws';
import { setCredential } from '../src/lib/auth';
import { StateDb } from '../src/lib/db';
import { AGENT_MARKER, MARKER, PASSWORD, S3_BUCKET, S3_PORT, TMUX_SOCKET, USERNAME, WORKSPACE } from './env';
import { UPLOAD_MAX_BODY_BYTES } from '../src/schemas/uploads';

/** Terminal sizing invariants, evaluated in the page:
 *  - the app shell is viewport-locked: the terminal never makes the page
 *    taller than the viewport (no page scrollbar);
 *  - the rendered rows fill .terminal-container (the xterm screen reaches the bottom
 *    of the box within one cell row) — i.e. the terminal tracks the
 *    available space, not its own previously rendered size. */
async function waitForTerminalFitted(page: Page, timeout = 5000): Promise<void> {
  await page.waitForFunction(
    () => {
      const el = document.querySelector('agent-terminal:not(.hidden)');
      const box = document.querySelector('agent-terminal:not(.hidden) .terminal-container');
      const screen = document.querySelector(
        'agent-terminal:not(.hidden) .terminal-container .xterm-screen',
      );
      if (!el || !box || !screen) return false;
      const rows = (el as unknown as { terminal?: { rows: number } }).terminal?.rows ?? 0;
      if (rows <= 0) return false;
      const b = box.getBoundingClientRect();
      const s = screen.getBoundingClientRect();
      const cellH = s.height / rows;
      return (
        document.documentElement.scrollHeight <= window.innerHeight + 1 &&
        b.height - s.height <= cellH + 1
      );
    },
    null,
    { timeout },
  );
}

/** The browser terminal's current cols/rows. */
async function termDims(page: Page): Promise<{ cols: number; rows: number }> {
  return page.evaluate(() => {
    const t = (
      document.querySelector('agent-terminal:not(.hidden)') as unknown as {
        terminal: { cols: number; rows: number };
      }
    ).terminal;
    return { cols: t.cols, rows: t.rows };
  });
}

/** Wait until the terminal's buffer contains `text`.
 *  Asserts on the buffer, not the DOM: the WebGL renderer draws rows to a
 *  canvas, so .terminal-container has no text nodes to assert on. */
async function waitForTermText(page: Page, text: string, timeout = 10_000): Promise<void> {
  await page.waitForFunction(
    marker => {
      const el = document.querySelector('agent-terminal:not(.hidden)') as unknown as {
        terminal?: {
          buffer: {
            active: {
              length: number;
              getLine(i: number): { translateToString(trimRight?: boolean): string } | undefined;
            };
          };
        };
      } | null;
      const buf = el?.terminal?.buffer.active;
      if (!buf) return false;
      for (let i = 0; i < buf.length; i++) {
        if (buf.getLine(i)?.translateToString(true).includes(marker)) return true;
      }
      return false;
    },
    text,
    { timeout },
  );
}

async function termRows(page: Page): Promise<number> {
  return (await termDims(page)).rows;
}

async function signIn(page: Page): Promise<void> {
  await page.fill('wa-input#username input', USERNAME);
  await page.fill('wa-input#password input', PASSWORD);
  await page.click('wa-button:has-text("sign in")');
}

/** Lands on the signed-in console. The first call signs in through the
 *  real login form; later calls reuse that session cookie — every
 *  POST /login spends the per-IP budget (10 / 15 min) that the last test
 *  exhausts on purpose. */
let sessionCookie: Cookie | null = null;
async function login(page: Page): Promise<void> {
  if (sessionCookie) {
    await page.context().addCookies([sessionCookie]);
    await page.goto('/');
  } else {
    await page.goto('/login');
    await signIn(page);
    await page.waitForURL(u => u.pathname === '/');
    sessionCookie = (await page.context().cookies()).find(c => c.name === 'cybermole_session') ?? null;
  }
  await page.waitForSelector('workspace-sidebar .nav');
}

/** tmux CLI against the suite socket: status 0 = ok, nonzero = refused. */
function tmuxStatus(args: string[]): number {
  return spawnSync('tmux', ['-L', TMUX_SOCKET, ...args], { stdio: 'ignore' }).status ?? 1;
}

/** Make a workspace through the real API (in-page fetch — Playwright's
 *  API client doesn't send the Secure session cookie over this suite's
 *  plain-http origin), refresh the console's state, return its id. A
 *  distinct cwd (when the caller needs one) is set through the PATCH
 *  route — the create DERIVES it now (task/app-cwd: the parent app's
 *  cwd, else CYBERMOLE_NEW_SESSION_CWD — WORKSPACE in this suite). */
async function makeWorkspace(page: Page, name: string, cwd?: string): Promise<string> {
  const made = await api(page, 'POST', '/api/workspaces', { name });
  expect(made.status, JSON.stringify(made.json)).toBe(200);
  if (cwd !== undefined) {
    const patched = await api(page, 'PATCH', `/api/workspaces/${made.json.id}`, { cwd });
    expect(patched.status, JSON.stringify(patched.json)).toBe(200);
  }
  await refreshState(page);
  // select it through the sidebar (the real UI path) so its tab bar renders
  await page.click(`workspace-sidebar li[data-ws="${made.json.id}"]`);
  return made.json.id as string;
}

/** Open one more terminal tab in an existing workspace; refresh state. */
async function makeTerminalIn(page: Page, ws: string): Promise<string> {
  const term = await api(page, 'POST', `/api/workspaces/${ws}/terminals`, {});
  expect(term.status, JSON.stringify(term.json)).toBe(200);
  await refreshState(page);
  return term.json.id as string;
}

/** Make a workspace + one terminal tab; return both ids. The tab's pane is
 *  created by CLICKING the tab (first activation). The workspace's
 *  AUTO-OPENED agent tab (task/defaults-settings) is closed first: these
 *  tests predate the agent slot and assert a one-tab world (pane counts,
 *  empty-state prompts, single .terminal-status locators) — the slot
 *  itself has its own spec (the auto-open test) and the console flow. */
async function makeTerminal(
  page: Page,
  name: string,
  cwd?: string,
): Promise<{ ws: string; id: string }> {
  const ws = await makeWorkspace(page, name, cwd);
  const auto = await page
    .locator('terminal-tabs .tabs-bar .tab')
    .first()
    .getAttribute('data-term');
  expect(auto, 'the workspace auto-opened its first tab').toBeTruthy();
  const closed = await api(page, 'DELETE', `/api/terminals/${auto}`);
  expect(closed.status, JSON.stringify(closed.json)).toBe(200);
  await refreshState(page);
  return { ws, id: await makeTerminalIn(page, ws) };
}

/** The VISIBLE pane's status line — scoped to the not-hidden pane: a
 *  workspace's auto-opened tab keeps its (hidden, attached) pane in the
 *  DOM next to the tab under test (task/defaults-settings), so an
 *  unscoped .terminal-status locator goes strict-mode on two panes.
 *  `state` picks the modifier class ('.ok', '.info', …). */
const paneStatus = (page: Page, state = ''): Locator =>
  page.locator(`agent-terminal:not(.hidden) .terminal-status${state}`);

/** Pull a fresh /api/state into the console's sidebar + tabs (the 15 s
 *  poll, forced — raw in-page POSTs don't trigger it). */
async function refreshState(page: Page): Promise<void> {
  await page.evaluate(() =>
    (
      document.querySelector('console-app') as unknown as { loadState(): Promise<void> }
    ).loadState(),
  );
}

test('unauthenticated / serves the login page with upgraded wa-* controls', async ({ page }) => {
  await page.goto('/');
  // No redirect for unauthenticated / — the server rewrites to login SSR.
  expect(page.url()).toMatch(/\/$/);
  await expect(page.locator('wa-input#username input')).toHaveCount(1);
  await expect(page.locator('wa-input#password input[type=password]')).toHaveCount(1);
  await expect(page.locator('wa-button:has-text("sign in")')).toHaveCount(1);
  // The layout's SSR'd <wa-toast> must also upgrade client-side (AGENTS.md:
  // SSR ≠ client) — its create() only exists after the component defines.
  await page.waitForFunction(() => {
    const t = document.querySelector('wa-toast');
    return !!t && typeof (t as HTMLElement & { create?: unknown }).create === 'function';
  });
  // The password-eye toggle is a system-library icon inside wa-input's
  // shadow DOM — the only default system icon in the UI. The glyph must
  // render from the vendored system library (src/icons.ts) under the CSP
  // (Playwright locators pierce open shadow roots, wa-input's and
  // wa-icon's alike).
  await expect(page.locator('wa-input#password wa-icon svg')).toHaveCount(1);
});

test('API routes stay guarded without a session', async ({ request }) => {
  expect((await request.get('/api/state')).status()).toBe(401);
  expect((await request.get('/api/jobs')).status()).toBe(401);
  expect(
    (await request.get('/api/files/uploads/00000000-0000-4000-8000-000000000000')).status(),
  ).toBe(401);
  // Unknown API paths are 401 too — never the login page.
  expect((await request.get('/api/nope')).status()).toBe(401);
  // Server-rendered partials are data routes too — never the login page
  // (an element would swap login HTML into its list).
  expect((await request.get('/partials/jobs-list')).status()).toBe(401);
  expect((await request.get('/partials/settings')).status()).toBe(401);
  expect((await request.post('/api/workspaces', { data: { name: 'x' } })).status()).toBe(401);
  expect((await request.post('/api/apps', { data: { name: 'x' } })).status()).toBe(401);
  expect(
    (await request.delete('/api/terminals/123e4567-e89b-42d3-a456-426614174000')).status(),
  ).toBe(401);
});

test('bad credentials show the danger callout', async ({ page }) => {
  await page.goto('/login');
  await page.fill('wa-input#username input', USERNAME);
  await page.fill('wa-input#password input', 'wrong-password');
  await page.click('wa-button:has-text("sign in")');
  await expect(page.locator('wa-callout#error:not(.hidden)')).toContainText('invalid credentials');
});

test('the login form validates in the browser: empty fields show their messages, nothing is POSTed', async ({
  page,
}) => {
  // Client-side validation (validation-enhancer-zod + the loginForm schema)
  // — an empty field never costs a request, so this spends nothing from the
  // suite's login budget.
  const posts: string[] = [];
  page.on('request', r => {
    if (r.method() === 'POST') posts.push(r.url());
  });
  await page.goto('/login');
  await page.waitForFunction(() => customElements.get('validation-enhancer-zod') !== undefined);
  await page.click('wa-button:has-text("sign in")');
  await expect(page.locator('#username-error')).toHaveText('enter your username');
  await expect(page.locator('#password-error')).toHaveText('enter your password');
  expect(posts).toEqual([]);
  // The message lives in the wa-input's hint slot: the REAL input inside
  // the shadow DOM is described by it (aria-errormessage on the host would
  // never reach it), and the hint is not aria-hidden.
  await expect(page.locator('wa-input#username input')).toHaveAccessibleDescription(
    'enter your username',
  );
  const hint = await page.evaluate(() => {
    const host = document.getElementById('username')!;
    const input = host.shadowRoot!.querySelector('input')!;
    const slot = host.shadowRoot!.getElementById(input.getAttribute('aria-describedby') ?? '');
    return slot?.getAttribute('aria-hidden') ?? 'missing';
  });
  expect(hint).toBe('false');
  // Correcting a field clears its message (validated on focus-out).
  await page.fill('wa-input#username input', USERNAME);
  await page.locator('wa-input#password input').focus();
  await expect(page.locator('#username-error')).toHaveText('');
  expect(posts).toEqual([]);
});

test('login lands on the console with the fixture workspace tree in the sidebar', async ({
  page,
}) => {
  await login(page);
  await expect(page.locator('console-app wa-page')).toHaveCount(1);

  // The first workspace auto-selects (global-setup seeds three, ordered):
  // the console group's "scratch", whose untitled first tab is the LIVE
  // fixture (a live auto-selection attaches without respawning) — so a
  // terminal pane (and its xterm) is on screen at once.
  await expect(page.locator('agent-terminal:not(.hidden) .terminal-container .xterm')).toHaveCount(
    1,
  );

  // The WebGL renderer is lazy-loaded on a tab's FIRST activation (plan
  // §8); once it loads, xterm swaps its DOM rows for canvas rendering (the
  // addon mounts >1 canvas, so assert presence, not an exact count).
  // Headless Chromium has SwiftShader WebGL, so the renderer should engage.
  await page.waitForFunction(
    () =>
      document.querySelectorAll('agent-terminal:not(.hidden) .terminal-container canvas').length >
      0,
    null,
    { timeout: 10_000 },
  );

  // The sidebar groups (plan §8): the Console group first, then each app
  // by sort_order — one fixture app ("alpha app") with its one workspace.
  const nav = page.locator('workspace-sidebar .nav');
  const groups = nav.locator('.ws-group');
  await expect(groups).toHaveCount(2);
  await expect(groups.first().locator('h2 .g-name')).toHaveText('console');
  await expect(groups.nth(1).locator('h2 .g-name')).toHaveText('alpha app');
  // rows: console group carries scratch + deploy checklist, the app carries proj
  await expect(groups.first().locator('li[data-ws]')).toHaveCount(2);
  await expect(groups.first()).toContainText('scratch');
  await expect(groups.first()).toContainText('deploy checklist');
  await expect(groups.nth(1).locator('li[data-ws]')).toHaveCount(1);
  await expect(groups.nth(1)).toContainText('proj');
  // live-terminal badges (plan §5's diff): every fixture workspace has one
  // live tab (scratch's second tab is the dead fixture), except scratch's
  // dead tab which shows no badge of its own — one badge per row.
  await expect(groups.first().locator('li[data-ws] wa-badge')).toHaveCount(2);
  // the selected row is highlighted
  await expect(groups.first().locator('li[data-ws].active')).toHaveCount(1);

  // the selected workspace's tab bar: scratch's two tabs, in order, the
  // first one active and live, no editor tab (unconfigured in this suite).
  const tabs = page.locator('terminal-tabs .tabs-bar');
  await expect(tabs.locator('.tab')).toHaveCount(2);
  await expect(tabs.locator('.tab').first()).toHaveClass(/active/);
  await expect(tabs.locator('.tab').first().locator('.tab-dot')).toHaveClass(/live/);
  await expect(tabs.locator('.tab').nth(1).locator('.tab-dot')).not.toHaveClass(/live/);
  await expect(tabs.locator('.editor-tab')).toHaveCount(0);
  // the [+] sits last
  await expect(tabs.locator('.tab-new')).toHaveCount(1);
});

test("console flow: create app (with a cwd) → workspace (starts at the app's cwd) → new terminal → live tab → input round-trips; close kills the session", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await login(page);
  await page.waitForFunction(() => customElements.get('validation-enhancer-zod') !== undefined);

  // Every POST this test makes through the UI (the empty-name attempts
  // below must spend none).
  const posts: string[] = [];
  page.on('request', r => {
    if (r.method() === 'POST') posts.push(new URL(r.url()).pathname);
  });

  // --- new app through the dialog: an empty name is blocked in the browser
  await page.click('workspace-sidebar #new-app');
  await page.click('#app-save');
  await expect(page.locator('#app-name-error')).toHaveText('name is required');
  expect(posts).toEqual([]);
  // the optional cwd (task/app-cwd — "no folder setting when creating
  // workspace: the app does that"): this app's workspaces start at its dir
  const appDir = `${WORKSPACE}/flow-app-dir`;
  fs.mkdirSync(appDir, { recursive: true });
  await page.fill('wa-input#app-name input', 'Flow App');
  await page.fill('wa-input#app-cwd input', appDir);
  await page.click('#app-save');
  const group = page.locator('workspace-sidebar .ws-group[data-group="flow-app"]');
  await expect(group.locator('h2 .g-name')).toHaveText('Flow App');

  // --- new workspace under it: NO folder setting in this dialog
  //     (task/app-cwd — the app carries it): the hint says where it starts
  await group.locator('[data-new-ws]').click();
  await expect(page.locator('#workspace-dialog wa-input[name="cwd"]')).toHaveCount(0);
  await expect(page.locator('#workspace-start')).toHaveText(`starts at ${appDir}`);
  await page.click('#workspace-save');
  await expect(page.locator('#workspace-name-error')).toHaveText('name is required');
  // blocked in the browser: no workspace POST yet — only the app POST so far
  expect(posts.filter(p => p === '/api/workspaces')).toEqual([]);
  await page.fill('wa-input#workspace-name input', 'flow ws');
  await page.click('#workspace-save');
  // Selected — and NOT empty: the workspace auto-opened its first terminal
  // (task/defaults-settings — the agent slot) running CYBERMOLE_AGENT_COMMAND
  // (this suite's cmd.sh in agent mode: a distinct banner), live and
  // attached. The no-terminals prompt only appears once its last tab is
  // closed below.
  // The workspace's cwd IS the app's (the server derived it — the row's
  // title carries w.cwd) — not the suite default (CYBERMOLE_NEW_SESSION_CWD).
  const flowRow = page.locator('workspace-sidebar li[data-ws].active');
  await expect(flowRow).toContainText('flow ws');
  await expect(flowRow).toHaveAttribute('title', appDir);
  await expect(page.locator('terminal-tabs .tabs-bar .tab')).toHaveCount(1);
  const agentTab = await page
    .locator('terminal-tabs .tabs-bar .tab')
    .getAttribute('data-term');
  await expect(page.locator(`terminal-tabs .tab[data-term="${agentTab}"] .tab-dot`)).toHaveClass(
    /live/,
    { timeout: 10_000 },
  );
  await waitForTermText(page, AGENT_MARKER, 20_000);
  await expect(paneStatus(page, '.ok')).toContainText(`attached: t-${agentTab}`);

  // --- new terminal via the tab bar's + : a SECOND tab, live, running the
  //     SHELL command (CYBERMOLE_COMMAND — cmd.sh's default banner)
  await page.click('terminal-tabs .tab-new');
  await expect(page.locator('terminal-tabs .tabs-bar .tab')).toHaveCount(2);
  const tabId = await page
    .locator('terminal-tabs .tabs-bar .tab.active')
    .getAttribute('data-term');
  expect(tabId).toMatch(/^[0-9a-f-]{36}$/);
  expect(tabId).not.toBe(agentTab);
  await expect(page.locator(`terminal-tabs .tab[data-term="${tabId}"] .tab-dot`)).toHaveClass(
    /live/,
    { timeout: 10_000 },
  );
  await waitForTermText(page, MARKER, 20_000);
  // two panes exist now (the agent slot's + this one) — the scoped locator
  await expect(paneStatus(page, '.ok')).toContainText(`attached: t-${tabId}`);

  // Full loop: keystrokes in xterm → WS → pty → tmux → output rendered.
  // $((41+1)) distinguishes the shell's evaluated output (TYPIST_42) from
  // the locally echoed command line (which contains the expression).
  await page.locator('agent-terminal:not(.hidden) .terminal-container').click();
  await page.keyboard.type('echo TYPIST_$((41+1))\n');
  await waitForTermText(page, 'TYPIST_42', 10_000);

  // the spawn really ran on the suite's socket, at the workspace cwd —
  // the app's dir (derived at the create), not the suite default. The cwd
  // is verified by asking the session's own shell (a `pwd` round-trip
  // through the UI): tmux's #{pane_current_path} side-channel resolves
  // empty under gVisor (TIOCGSID/tcgetpgrp on a pty master → ENOTTY), and
  // the round-trip asserts the same fact end-to-end in every environment.
  expect(tmuxStatus(['has-session', '-t', `t-${tabId}`])).toBe(0);
  await page.locator('agent-terminal:not(.hidden) .terminal-container').click();
  await page.keyboard.type('pwd\n');
  await waitForTermText(page, appDir, 10_000);

  // --- close the tab: confirm dialog → row + tmux session both gone
  await page.click(`terminal-tabs .tab[data-term="${tabId}"] .tab-close`);
  // a title-less tab is confirmed by its uuid prefix
  await expect(page.locator('#confirm-delete-text')).toContainText('terminal');
  await expect(page.locator('#confirm-delete-text')).toContainText(tabId!.slice(0, 8));
  await page.click('#confirm-delete-ok');
  // the SHELL tab is gone — the workspace's auto-opened agent tab remains
  // (its session too: only the closed tab's was killed)
  await expect(page.locator('terminal-tabs .tabs-bar .tab')).toHaveCount(1);
  await expect
    .poll(() => tmuxStatus(['has-session', '-t', `t-${tabId}`]), { timeout: 10_000 })
    .not.toBe(0);
  expect(tmuxStatus(['has-session', '-t', `t-${agentTab}`])).toBe(0);
  // ...and closing THAT one empties the workspace (the prompt's own path)
  await page.click(`terminal-tabs .tab[data-term="${agentTab}"] .tab-close`);
  await page.click('#confirm-delete-ok');
  await expect(page.locator('terminal-tabs .tabs-bar .tab')).toHaveCount(0);
  await expect(page.locator('.tabs-empty-terminals')).toBeVisible();

  // --- delete the workspace (its delete button → confirm) → row gone;
  //     the selection falls back to the FIRST remaining workspace
  await page.locator('workspace-sidebar li[data-ws].active [data-del-ws]').click();
  await page.click('#confirm-delete-ok');
  await expect(
    page.locator('workspace-sidebar li[data-ws]').filter({ hasText: 'flow ws' }),
  ).toHaveCount(0);
  await expect(page.locator('workspace-sidebar li[data-ws].active')).toContainText('scratch');

  // --- delete the app → the whole group goes; the fixture groups remain
  await page.locator('workspace-sidebar .ws-group[data-group="flow-app"] [data-del-app]').click();
  await expect(page.locator('#confirm-delete-text')).toContainText('Flow App');
  await page.click('#confirm-delete-ok');
  await expect(page.locator('workspace-sidebar .ws-group[data-group="flow-app"]')).toHaveCount(0);
  await expect(page.locator('workspace-sidebar .ws-group')).toHaveCount(2);
  // (the empty state — zero workspaces — is covered on the restart-survival
  //  spec's private server, where the fixture tree isn't in the way)
});

test('a new workspace auto-opens its first terminal running the AGENT command; other tabs run the shell (task/defaults-settings)', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await login(page);
  const ws = await makeWorkspace(page, 'agent slot ws');
  // The FIRST tab exists without ever touching the + button, is live, and
  // attaches on the workspace's selection — running the AGENT command
  // (CYBERMOLE_AGENT_COMMAND = the suite's cmd.sh in agent mode).
  await expect(page.locator('terminal-tabs .tabs-bar .tab')).toHaveCount(1);
  const id = await page.locator('terminal-tabs .tabs-bar .tab').getAttribute('data-term');
  await expect(page.locator(`terminal-tabs .tab[data-term="${id}"] .tab-dot`)).toHaveClass(
    /live/,
    { timeout: 10_000 },
  );
  await waitForTermText(page, AGENT_MARKER, 20_000);
  await expect(page.locator('.terminal-status.ok')).toContainText(`attached: t-${id}`);
  // the spawn really ran on the suite's socket
  expect(tmuxStatus(['has-session', '-t', `t-${id}`])).toBe(0);

  // A second tab (the + button) runs the SHELL command — the default
  // marker, not the agent one: the two settings are independent.
  const second = await makeTerminalIn(page, ws);
  await page.click(`terminal-tabs .tab[data-term="${second}"]`);
  await waitForTermText(page, MARKER, 20_000);
  expect(tmuxStatus(['has-session', '-t', `t-${second}`])).toBe(0);

  // Cleanup: the workspace takes both tabs (rows + best-effort kills).
  expect((await api(page, 'DELETE', `/api/workspaces/${ws}`)).status).toBe(200);
  await expect
    .poll(() => tmuxStatus(['has-session', '-t', `t-${id}`]), { timeout: 10_000 })
    .not.toBe(0);
});

test('a paste bigger than one WebSocket frame reaches the session whole', async ({ page }) => {
  test.setTimeout(60_000);
  // > the server's 1 MiB maxPayload: only arrives if the client chunks it.
  const size = 1_200_000;
  const out = `${WORKSPACE}/paste.out`;
  await login(page);
  const { id } = await makeTerminal(page, 'paste ws');
  await page.click(`terminal-tabs .tab[data-term="${id}"]`);
  await waitForTermText(page, MARKER, 20_000);

  // Raw mode + no echo on the pane's tty so head sees the paste byte for
  // byte (a canonical-mode line is capped at 4 KiB by the kernel, which
  // would make this a test of the tty rather than of cybermole).
  await page.locator('agent-terminal:not(.hidden) .terminal-container').click();
  await page.keyboard.type(
    `stty raw -echo; echo RAW_$((40+2)); head -c ${size} > ${out}; stty sane\n`,
  );
  await waitForTermText(page, 'RAW_42');
  await page.evaluate(n => {
    const el = document.querySelector('agent-terminal:not(.hidden)') as unknown as {
      terminal: { paste(d: string): void };
    };
    el.terminal.paste('x'.repeat(n));
  }, size);

  await expect
    .poll(
      () => {
        try {
          return fs.statSync(out).size;
        } catch {
          return -1;
        }
      },
      { timeout: 30_000 },
    )
    .toBe(size);
  await expect(page.locator('.terminal-status.ok')).toContainText(`attached: t-${id}`);
});

test('a dropped socket reconnects to the same session; a session that ends is not retried', async ({
  page,
}) => {
  await login(page);
  const { id } = await makeTerminal(page, 'reconnect ws');
  await page.click(`terminal-tabs .tab[data-term="${id}"]`);
  await waitForTermText(page, MARKER, 20_000);
  await expect(page.locator('.terminal-status.ok')).toContainText(`attached: t-${id}`);

  // Drop the socket the way a proxy idle cut does: closed under the
  // component, with no 'exit' from the server first.
  await page.evaluate(() =>
    (
      document.querySelector('agent-terminal:not(.hidden)') as unknown as { websocket: WebSocket }
    ).websocket.close(),
  );
  await expect(page.locator('.terminal-status')).toContainText('reconnecting');
  await expect(page.locator('.terminal-status.ok')).toContainText(`attached: t-${id}`, {
    timeout: 10_000,
  });
  await page.locator('agent-terminal:not(.hidden) .terminal-container').click();
  await page.keyboard.type('echo BACK_$((40+2))\n');
  await waitForTermText(page, 'BACK_42');

  // The session itself ending arrives as the server's 'exit': reported,
  // never reconnected (that would also loop two tabs bumping each other).
  execFileSync('tmux', ['-L', TMUX_SOCKET, 'kill-session', '-t', `t-${id}`]);
  await expect(page.locator('.terminal-status.info')).toContainText(`detached: t-${id}`);
  await page.waitForTimeout(2500); // longer than the first reconnect backoff
  await expect(page.locator('.terminal-status.info')).toContainText(`detached: t-${id}`);
});

test('malformed requests and frames are rejected without taking the server down', async ({
  page,
}) => {
  await login(page);
  // In-page fetch, not page.request: Playwright's API client doesn't send
  // the Secure session cookie over the suite's plain-http origin.
  const status = (method: string, url: string, body?: string): Promise<number> =>
    page.evaluate(
      async ([m, u, b]) =>
        (
          await fetch(u!, {
            method: m!,
            headers: { 'Content-Type': 'application/json' },
            ...(b === undefined ? {} : { body: b }),
          })
        ).status,
      [method, url, body] as const,
    );

  // A bad %-escape in a path segment threw out of the request handler and
  // killed the process; now it's a 400.
  expect(await status('DELETE', '/api/jobs/%E0')).toBe(400);
  expect(await status('POST', '/api/jobs/%E0/run')).toBe(400);
  // JSON bodies must be objects.
  expect(await status('POST', '/api/apps', '[]')).toBe(400);
  expect(await status('POST', '/api/workspaces', '"just a string"')).toBe(400);
  // Bodies are capped at 10 KiB off the upload route: server/main.ts
  // refuses an oversized one from its Content-Length before Astro reads it.
  expect(await status('POST', '/api/apps', JSON.stringify({ name: 'x'.repeat(20_000) }))).toBe(413);
  // The JSON API only parses JSON (or form) bodies.
  expect(
    await page.evaluate(
      async () =>
        (
          await fetch('/api/workspaces', {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain' },
            body: '{"name":"x"}',
          })
        ).status,
    ),
  ).toBe(415);
  // API answers are per-user state: never cached.
  expect(
    await page.evaluate(async () => (await fetch('/api/state')).headers.get('cache-control')),
  ).toBe('no-store');

  // Junk WS frames — before and after attaching (`null` and a data-less
  // input each used to crash the server) — are dropped; the socket lives
  // on. The deleted live/resume modes (plan §7/§11) are junk frames now.
  const { id } = await makeTerminal(page, 'junk ws');
  const junk = [
    'null',
    '[]',
    '"x"',
    'not json',
    '{"type":"input"}',
    '{"type":"input","data":5}',
    '{"type":"resize","cols":"wide"}',
    '{"type":"attach","mode":"live"}',
    '{"type":"attach","mode":"live","target":"x"}',
    '{"type":"attach","mode":"resume","id":7}',
    // the workspace-model modes reject a missing/mistyped id/target the same way
    '{"type":"attach","mode":"terminal"}',
    '{"type":"attach","mode":"run"}',
  ];
  const stillOpen = await page.evaluate(
    async ([frames, termId]) => {
      const ws = new WebSocket(`ws://${location.host}/ws`);
      await new Promise((resolve, reject) => {
        ws.onopen = resolve;
        ws.onerror = reject;
      });
      for (const f of frames) ws.send(f);
      ws.send(JSON.stringify({ type: 'attach', mode: 'terminal', id: termId }));
      await new Promise<void>(resolve => {
        ws.onmessage = ev => {
          if ((JSON.parse(ev.data as string) as { type: string }).type === 'attached') resolve();
        };
      });
      for (const f of frames) ws.send(f);
      await new Promise(r => setTimeout(r, 300));
      const open = ws.readyState === WebSocket.OPEN;
      ws.close();
      return open;
    },
    [junk, id] as const,
  );
  expect(stillOpen).toBe(true);
  expect(await status('GET', '/api/state')).toBe(200);
});

test('dead tab: an out-of-band kill shows not-live in the poll; clicking the tab respawns at the workspace cwd', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await login(page);
  // The workspace cwd is deliberately NOT CYBERMOLE_NEW_SESSION_CWD's default
  // (both are WORKSPACE here) — a distinct dir proves the respawn targets
  // the workspace row's cwd, not the configured default.
  const cwd = `${WORKSPACE}/dead-tab-cwd`;
  fs.mkdirSync(cwd, { recursive: true });
  const { id } = await makeTerminal(page, 'dead tab ws', cwd);
  await page.click(`terminal-tabs .tab[data-term="${id}"]`);
  await waitForTermText(page, MARKER, 20_000);
  await expect(page.locator('.terminal-status.ok')).toContainText(`attached: t-${id}`);

  // Out-of-band kill (the workspace-container-loss story, plan §4): the
  // row is the structure; the session is the content.
  execFileSync('tmux', ['-L', TMUX_SOCKET, 'kill-session', '-t', `t-${id}`]);
  await expect(page.locator('.terminal-status.info')).toContainText(`detached: t-${id}`);

  // The 15 s poll (forced here) flips the tab's dot and the row's badge.
  await page.evaluate(() =>
    (
      document.querySelector('console-app') as unknown as { loadState(): Promise<void> }
    ).loadState(),
  );
  await expect(page.locator(`terminal-tabs .tab[data-term="${id}"] .tab-dot`)).not.toHaveClass(
    /live/,
  );

  // Clicking the ended pane's tab is a FRESH attach: the server respawns
  // the session at the workspace cwd and the banner shows again.
  await page.click(`terminal-tabs .tab[data-term="${id}"]`);
  await expect(page.locator('.terminal-status.ok')).toContainText(`attached: t-${id}`, {
    timeout: 20_000,
  });
  await waitForTermText(page, MARKER, 20_000);

  // The respawn ran AT the workspace cwd (t-<uuid> name, fresh content).
  const proof = `${cwd}/respawn-pwd.txt`;
  await page.locator('agent-terminal:not(.hidden) .terminal-container').click();
  await page.keyboard.type(`pwd > ${JSON.stringify(proof)}\n`);
  await expect
    .poll(() => (fs.existsSync(proof) ? fs.readFileSync(proof, 'utf8').trim() : ''), {
      timeout: 10_000,
    })
    .toBe(cwd);
});

test('files: upload streams into object storage; downloads come back as resumable attachments', async ({
  page,
}) => {
  await login(page);
  type Upload = {
    status: number;
    body: { key?: string; name?: string; size?: number; contentType?: string; code?: string };
  };
  const upload = (size: number, type: string, name = 'notes.txt'): Promise<Upload> =>
    page.evaluate(
      async ([n, t, f]) => {
        const form = new FormData();
        // Bytes of 'a' (0x61), so stored and downloaded bodies are checkable.
        form.append('file', new File([new Uint8Array(n!).fill(0x61)], f!, { type: t! }));
        const r = await fetch('/api/files', { method: 'POST', body: form });
        return { status: r.status, body: await r.json().catch(() => ({})) };
      },
      [size, type, name] as const,
    );
  type Download = { status: number; headers: Record<string, string>; size: number; allA: boolean };
  const download = (path: string): Promise<Download> =>
    page.evaluate(async p => {
      const r = await fetch(p);
      const bytes = new Uint8Array(await r.arrayBuffer());
      return {
        status: r.status,
        headers: Object.fromEntries(r.headers.entries()),
        size: bytes.length,
        allA: bytes.every(b => b === 0x61),
      };
    }, path);

  const ok = await upload(12, 'text/plain', 'q1 notes (draft).txt');
  expect(ok.status).toBe(201);
  expect(ok.body).toMatchObject({
    name: 'q1 notes (draft).txt',
    size: 12,
    contentType: 'text/plain',
  });
  expect(ok.body.key).toMatch(/^uploads\/[0-9a-f-]{36}$/);
  // It reached the S3 server (tests/fake-s3.mjs), body and headers intact...
  const stored = (await (
    await fetch(`http://127.0.0.1:${S3_PORT}/__fake/objects/${S3_BUCKET}/${ok.body.key}`)
  ).json()) as { body: string; contentType: string; contentDisposition: string };
  expect(Buffer.from(stored.body, 'base64').toString()).toBe('a'.repeat(12));
  expect(stored.contentType).toBe('text/plain');
  expect(stored.contentDisposition).toBe(
    "attachment; filename*=UTF-8''q1%20notes%20%28draft%29.txt",
  );
  // ...and comes back from GET /api/files/<key> as a sandboxed attachment.
  const back = await download(`/api/files/${ok.body.key}`);
  expect(back).toMatchObject({ status: 200, size: 12, allA: true });
  expect(back.headers).toMatchObject({
    'content-type': 'text/plain',
    'content-disposition': "attachment; filename*=UTF-8''q1%20notes%20%28draft%29.txt",
    'content-security-policy': "sandbox; default-src 'none'",
    'x-content-type-options': 'nosniff',
    'cache-control': 'private, no-store',
    'content-length': '12',
    'accept-ranges': 'bytes',
  });

  // Past one 5 MiB part: a multipart upload, streamed both ways.
  const big = await upload(12 * 1024 * 1024 + 7, 'image/png', 'big.png');
  expect(big.status).toBe(201);
  expect(big.body.size).toBe(12 * 1024 * 1024 + 7);
  expect(await download(`/api/files/${big.body.key}`)).toMatchObject({
    status: 200,
    size: 12 * 1024 * 1024 + 7,
    allA: true,
  });

  // Resumable, the way a download manager does it: HEAD for the ETag, a
  // first part, then the rest from where it stopped with If-Range. A
  // patterned file, so a wrong offset can't pass.
  const resume = await page.evaluate(async () => {
    const n = 6 * 1024 * 1024 + 5;
    const pattern = new Uint8Array(n).map((_, i) => i % 251);
    const form = new FormData();
    form.append('file', new File([pattern], 'pattern.pdf', { type: 'application/pdf' }));
    const { key } = (await (await fetch('/api/files', { method: 'POST', body: form })).json()) as {
      key: string;
    };
    const url = `/api/files/${key}`;
    const head = await fetch(url, { method: 'HEAD' });
    const etag = head.headers.get('etag')!;
    const first = await fetch(url, { headers: { Range: 'bytes=0-999999' } });
    const rest = await fetch(url, { headers: { Range: 'bytes=1000000-', 'If-Range': etag } });
    const a = new Uint8Array(await first.arrayBuffer());
    const b = new Uint8Array(await rest.arrayBuffer());
    const joined = new Uint8Array(a.length + b.length);
    joined.set(a);
    joined.set(b, a.length);
    const stale = await fetch(url, {
      headers: { Range: 'bytes=1000000-', 'If-Range': '"not-this-version"' },
    });
    const pastEnd = await fetch(url, { headers: { Range: `bytes=${n}-` } });
    const multi = await fetch(url, { headers: { Range: 'bytes=0-1,5-6' } });
    return {
      n,
      head: {
        status: head.status,
        length: head.headers.get('content-length'),
        ranges: head.headers.get('accept-ranges'),
        body: (await head.arrayBuffer()).byteLength,
      },
      first: { status: first.status, range: first.headers.get('content-range'), length: a.length },
      rest: { status: rest.status, range: rest.headers.get('content-range'), length: b.length },
      intact: joined.length === n && joined.every((v, i) => v === i % 251),
      stale: { status: stale.status, length: (await stale.arrayBuffer()).byteLength },
      pastEnd: { status: pastEnd.status, range: pastEnd.headers.get('content-range') },
      multi: { status: multi.status, length: (await multi.arrayBuffer()).byteLength },
    };
  });
  const n = resume.n;
  expect(resume.head).toEqual({ status: 200, length: String(n), ranges: 'bytes', body: 0 });
  expect(resume.first).toEqual({ status: 206, range: `bytes 0-999999/${n}`, length: 1_000_000 });
  expect(resume.rest).toEqual({
    status: 206,
    range: `bytes 1000000-${n - 1}/${n}`,
    length: n - 1_000_000,
  });
  expect(resume.intact).toBe(true);
  // A changed validator gets the whole file, not a part of another version.
  expect(resume.stale).toEqual({ status: 200, length: n });
  expect(resume.pastEnd).toEqual({ status: 416, range: `bytes */${n}` });
  // More than one range: ignored, the whole file.
  expect(resume.multi).toEqual({ status: 200, length: n });

  // Keys: unknown is 404; anything that isn't uploads/<uuid> is 400 — the
  // route serves nothing else from the bucket.
  expect((await download('/api/files/uploads/00000000-0000-4000-8000-000000000000')).status).toBe(
    404,
  );
  expect((await download('/api/files/etc/passwd')).status).toBe(400);
  expect((await download('/api/files/uploads/..%2F..%2Fsecret')).status).toBe(400);

  // A rejected type answers before storage even on a big body — which the
  // server drains rather than cutting, so the browser gets the answer, not
  // a reset connection.
  expect(await upload(20 * 1024 * 1024, 'text/html', 'x.html')).toMatchObject({
    status: 400,
    body: { code: 'unsupported_file_type' },
  });
  // Not multipart: 415.
  expect(
    await page.evaluate(
      async () =>
        (
          await fetch('/api/files', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
          })
        ).status,
    ),
  ).toBe(415);

  // Raw requests from Node with the session cookie, for what a browser won't send.
  const cookie = (await page.context().cookies()).find(c => c.name === 'cybermole_session')!;
  const port = new URL(page.url()).port;
  const raw = (path: string, headers: Record<string, string>, body?: string[]): Promise<number> =>
    new Promise((resolve, reject) => {
      const req = http.request(
        `http://127.0.0.1:${port}${path}`,
        {
          method: 'POST',
          headers: { Cookie: `cybermole_session=${cookie.value}`, ...headers },
        },
        res => {
          res.resume();
          resolve(res.statusCode ?? 0);
          req.destroy();
        },
      );
      req.on('error', err => {
        if (!req.destroyed) reject(err);
      });
      if (body) {
        for (const chunk of body) req.write(chunk);
        req.end();
      } else req.flushHeaders();
    });
  // Over the whole-body cap (5 GiB + envelope): refused on Content-Length
  // alone — nothing is sent, and nothing needs to be.
  expect(
    await raw('/api/files', {
      'Content-Type': 'multipart/form-data; boundary=x',
      'Content-Length': String(UPLOAD_MAX_BODY_BYTES + 1),
    }),
  ).toBe(413);
  // A body with no Content-Length (chunked) is refused off the upload
  // route — the 10 KiB cap can't be checked up front.
  expect(
    await raw(
      '/api/workspaces',
      { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' },
      ['{"name":', '"itest-chunked"}'],
    ),
  ).toBe(411);
});

test("attached session opens at the browser terminal's size, not 80x24", async ({ page }) => {
  await login(page);

  // The client sends {attach} then {resize} back-to-back on WS open; the
  // server must carry that size across its async tmux lookup and spawn the
  // pty at it (regression: resize was dropped pre-spawn, so the session
  // opened 80x24 in the corner of a larger browser terminal).
  const { id } = await makeTerminal(page, 'openfit ws');
  await page.click(`terminal-tabs .tab[data-term="${id}"]`);
  await expect(page.locator('.terminal-status.ok')).toContainText(`attached: t-${id}`, {
    timeout: 20_000,
  });
  await waitForTerminalFitted(page);

  const dims = await termDims(page);
  expect(dims.cols).toBeGreaterThan(100); // default viewport is far wider than 80

  const pane = execFileSync(
    'tmux',
    [
      '-L',
      TMUX_SOCKET,
      'display-message',
      '-p',
      '-t',
      `t-${id}:0.0`,
      '#{pane_width}x#{pane_height}',
    ],
    { encoding: 'utf8' },
  ).trim();
  const [w, h] = pane.split('x').map(Number) as [number, number];
  expect(w).toBe(dims.cols);
  // tmux's status line takes one row of the attached client.
  expect(h).toBeGreaterThanOrEqual(dims.rows - 1);
});

test('terminal fills the available space and refits when it shrinks', async ({ page }) => {
  await login(page);

  // Attach so the status bar is in its final state before measuring.
  const { id } = await makeTerminal(page, 'fill ws');
  await page.click(`terminal-tabs .tab[data-term="${id}"]`);
  await expect(page.locator('.terminal-status.ok')).toContainText(`attached: t-${id}`, {
    timeout: 20_000,
  });

  // At load the terminal must fill the viewport-height box without
  // pushing the page past the viewport.
  await waitForTerminalFitted(page);
  const rowsBefore = await termRows(page);

  // Shrink the viewport: the available space drops, so the box must shrink
  // and the terminal must refit to fewer rows — still filling the box.
  await page.setViewportSize({ width: 1280, height: 500 });
  await waitForTerminalFitted(page);
  expect(await termRows(page)).toBeLessThan(rowsBefore);
});

test('hidden tabs keep their WS attached: state and scrollback persist, refit on re-show', async ({
  page,
}) => {
  await login(page);
  // The multi-instance costs (plan §8): a hidden tab (display:none) must
  // keep its socket, and re-showing it must refit + re-send the size — the
  // pane's screen (tmux redraws it) and its scrollback both survive.
  const ws = await makeWorkspace(page, 'hidden tabs ws');
  const first = await makeTerminalIn(page, ws);
  const second = await makeTerminalIn(page, ws);
  await page.click(`terminal-tabs .tab[data-term="${first}"]`);
  await waitForTermText(page, MARKER, 20_000);
  await page.locator('agent-terminal:not(.hidden) .terminal-container').click();
  await page.keyboard.type('echo FIRST_$((40+2))\n');
  await waitForTermText(page, 'FIRST_42', 10_000);
  // a second pane exists only after its tab is activated once
  await page.click(`terminal-tabs .tab[data-term="${second}"]`);
  await waitForTermText(page, MARKER, 20_000);
  await page.locator('agent-terminal:not(.hidden) .terminal-container').click();
  await page.keyboard.type('echo SECOND_$((40+2))\n');
  await waitForTermText(page, 'SECOND_42', 10_000);

  // back to the first tab: its pane still holds the earlier output (the
  // socket was never closed by hiding) and is usable again
  await page.click(`terminal-tabs .tab[data-term="${first}"]`);
  await waitForTermText(page, 'FIRST_42', 10_000);
  await page.locator('agent-terminal:not(.hidden) .terminal-container').click();
  await page.keyboard.type('echo AGAIN_$((40+2))\n');
  await waitForTermText(page, 'AGAIN_42', 10_000);

  // only the shown pane holds a live xterm render; the hidden one is
  // display:none but still in the DOM with its socket attached
  const sockets = await page.evaluate(() => {
    const panes = [...document.querySelectorAll('agent-terminal')] as unknown as Array<{
      websocket?: WebSocket;
    }>;
    return panes.map(p => (p.websocket === undefined ? 'closed' : `${p.websocket!.readyState}`));
  });
  expect(sockets).toEqual(['1', '1', '1']); // all three panes (the auto-opened tab + the two made ones): OPEN
});

test('terminal toolbar: copy output and download transcript capture the terminal buffer', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await login(page);
  const { id } = await makeTerminal(page, 'transcript ws');
  await page.click(`terminal-tabs .tab[data-term="${id}"]`);
  await waitForTermText(page, MARKER, 20_000);

  // More output than one screen (the default viewport holds ~30 rows) —
  // the head of the seq ends up scrolled off the pane. While a pane is
  // attached, tmux holds the client terminal in its ALTERNATE screen, so
  // the client's buffer IS the visible screen (tmux's history is
  // server-side — the task/terminal-search backfill TODO); the walk's
  // scrollback half is exercised against a stub buffer below.
  await page.locator('agent-terminal:not(.hidden) .terminal-container').click();
  await page.keyboard.type('seq 1 120; echo TAIL_$((40+2))\n');
  await waitForTermText(page, 'TAIL_42', 10_000);

  // The toolbar: two independent buttons with tooltips, overlaid on the
  // pane (the fit tests around this one keep proving the ResizeObserver
  // sizing is untouched).
  const toolbar = page.locator('agent-terminal:not(.hidden) .terminal-toolbar');
  await expect(toolbar).toBeVisible();
  const copyBtn = toolbar.locator('wa-button.tb-copy-output');
  const dlBtn = toolbar.locator('wa-button.tb-download-transcript');
  await expect(copyBtn).toHaveCount(1);
  await expect(dlBtn).toHaveCount(1);
  expect(await copyBtn.getAttribute('title')).toContain('copy');
  expect(await dlBtn.getAttribute('title')).toContain('download');

  // The buffer walk behind both buttons: the screen's content — the seq
  // tail, the fresh output — with trailing blank rows trimmed (the last
  // line is non-empty).
  const walked = await page.evaluate(() =>
    (
      document.querySelector('agent-terminal:not(.hidden)') as unknown as {
        transcriptText(): string;
      }
    ).transcriptText(),
  );
  expect(walked).toContain('118\n119\n120');
  expect(walked).toContain('TAIL_42');
  const lines = walked.split('\n');
  expect(lines[lines.length - 1]!.trim()).not.toBe('');

  // The walk's scrollback + trim half, deterministically: swap in a stub
  // buffer shaped like one WITH scrollback (3000 rows: a scrolled-off
  // head, content, then the never-written blank rows a fresh pane has).
  const stubbed = await page.evaluate(() => {
    const el = document.querySelector('agent-terminal:not(.hidden)') as unknown as {
      terminal: unknown;
      transcriptText(): string;
    };
    const real = el.terminal;
    const rows = Array.from({ length: 3000 }, (_, i) =>
      i < 2500 ? `scroll-line-${i}` : i === 2500 ? 'last-content-row' : '',
    );
    el.terminal = {
      buffer: {
        active: {
          length: rows.length,
          getLine: (i: number) => ({ translateToString: () => rows[i] ?? '' }),
        },
      },
    };
    const text = el.transcriptText();
    el.terminal = real;
    return text;
  });
  expect(stubbed.startsWith('scroll-line-0\nscroll-line-1\n')).toBe(true);
  expect(stubbed).toContain('\nlast-content-row');
  expect(stubbed.endsWith('\n')).toBe(false); // 499 trailing blanks trimmed

  // copy output → the REAL clipboard (permissions granted for this
  // test's context), byte-identical with the walk above.
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await copyBtn.click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(walked);
  await expect(
    page.locator('wa-toast wa-toast-item', { hasText: 'copied the terminal output' }),
  ).toBeVisible();

  // download transcript → a blob download named after the attached
  // session, ANSI-serialized (the SGR escapes that make it an .ans).
  const [download] = await Promise.all([page.waitForEvent('download'), dlBtn.click()]);
  expect(download.suggestedFilename()).toBe(`t-${id}-transcript.ans`);
  const saved = await download.path();
  const ans = fs.readFileSync(saved!, 'utf8');
  expect(ans).toContain('TAIL_42');
  expect(ans).toContain('120');
  expect(ans).toContain('\u001b[');
  await download.cancel();
});

// jobs (in-process scheduler): the backend is inside the server, so the
// suite exercises the real thing everywhere — no degraded mode, no
// systemctl dependency. Runs land on the suite's tmux socket like any
// session; persistence and missed-run catch-up boot a second server on
// another port against a copy of the state db (rebooting the shared
// webServer mid-suite would take the login cookie down with it).

/** Authed in-page JSON fetch (Playwright's API client doesn't send the
 *  Secure session cookie over the suite's plain-http origin). */
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
        headers: { 'Content-Type': 'application/json' },
        ...(b === undefined ? {} : { body: JSON.stringify(b) }),
      });
      return { status: r.status, json: await r.json().catch(() => null) };
    },
    [method, url, body] as const,
  );
}

// Pop-out (task/pop-tab-window): the active tab's arrow button MOVES the
// pane to a /?t=<id> window — the server's attach runs `tmux attach -d`,
// so the main page's socket must be gone before the popup attaches. The
// row survives (marked popped); the terminal returns on the popup's
// pagehide or on the tab's next click (which bumps the popup, by design).
test("popping a tab moves the pane to a window: main socket down, popup attached, row survives; the tab click and the popup's close both bring it back", async ({
  page,
}) => {
  await login(page);
  const { ws, id } = await makeTerminal(page, 'pop ws');
  const other = await makeTerminalIn(page, ws); // a second, never-activated tab
  await page.click(`terminal-tabs .tab[data-term="${id}"]`);
  await waitForTermText(page, MARKER, 20_000);
  await expect(page.locator('.terminal-status.ok')).toContainText(`attached: t-${id}`);
  // the pop button is the ACTIVE tab's only (the other tab's is display:none)
  await expect(page.locator(`terminal-tabs .tab[data-term="${id}"] .tab-pop`)).toBeVisible();
  await expect(page.locator(`terminal-tabs .tab[data-term="${other}"] .tab-pop`)).toBeHidden();

  // --- pop: the pane MOVES to the popup (the ?t= deep-link path)
  const [popup] = await Promise.all([
    page.waitForEvent('popup'),
    page.click(`terminal-tabs .tab[data-term="${id}"] .tab-pop`),
  ]);
  await popup.waitForSelector('workspace-sidebar .nav');
  await expect(popup.locator(`terminal-tabs .tab[data-term="${id}"]`)).toHaveClass(/active/);
  await expect(popup.locator('.terminal-status.ok')).toContainText(`attached: t-${id}`);
  await waitForTermText(popup, MARKER, 20_000);

  // the main page: row kept (active + popped, dimmed) with a notice where
  // the pane was, the pane itself GONE (socket torn down — not killed:
  // the tmux session the popup now owns is still alive)
  await expect(page.locator(`terminal-tabs .tab[data-term="${id}"]`)).toHaveClass(/popped/);
  await expect(page.locator(`terminal-tabs .tab[data-term="${id}"]`)).toHaveClass(/active/);
  await expect(page.locator('.tabs-popped')).toBeVisible();
  // two tabs now (the popped row still among them) — makeTerminal closed
  // the workspace's auto-opened agent tab first (task/defaults-settings)
  await expect(page.locator('terminal-tabs .tabs-bar .tab')).toHaveCount(2);
  await expect(page.locator('terminal-tabs agent-terminal')).toHaveCount(0);
  expect(tmuxStatus(['has-session', '-t', `t-${id}`])).toBe(0);

  // the popped terminal is LIVE in the popup: input round-trips there
  await popup.locator('agent-terminal:not(.hidden) .terminal-container').click();
  await popup.keyboard.type('echo POP_$((40+2))\n');
  await waitForTermText(popup, 'POP_42', 10_000);

  // --- bring-back by CLICK: the tab re-attaches here; the popup's client
  //     is bumped (detached — once, no reconnect loop)
  await page.click(`terminal-tabs .tab[data-term="${id}"]`);
  await expect(page.locator('.terminal-status.ok')).toContainText(`attached: t-${id}`);
  await expect(page.locator(`terminal-tabs .tab[data-term="${id}"]`)).not.toHaveClass(/popped/);
  await expect(page.locator('.tabs-popped')).toHaveCount(0);
  await expect(popup.locator('.terminal-status.info')).toContainText(`detached: t-${id}`);
  await page.locator('agent-terminal:not(.hidden) .terminal-container').click();
  await page.keyboard.type('echo BACK_$((40+2))\n');
  await waitForTermText(page, 'BACK_42', 10_000);
  await popup.close(); // its pagehide is a no-op now (the mark is gone)

  // --- pop again, then CLOSE the popup: the pagehide (the held handle,
  //     same origin) re-attaches the active tab with no click at all
  const [popup2] = await Promise.all([
    page.waitForEvent('popup'),
    page.click(`terminal-tabs .tab[data-term="${id}"] .tab-pop`),
  ]);
  await popup2.waitForSelector('workspace-sidebar .nav');
  await expect(popup2.locator('.terminal-status.ok')).toContainText(`attached: t-${id}`);
  await expect(page.locator('terminal-tabs agent-terminal')).toHaveCount(0);
  await popup2.close();
  await expect(page.locator('.terminal-status.ok')).toContainText(`attached: t-${id}`, {
    timeout: 10_000,
  });
  await expect(page.locator(`terminal-tabs .tab[data-term="${id}"]`)).not.toHaveClass(/popped/);
  await page.locator('agent-terminal:not(.hidden) .terminal-container').click();
  await page.keyboard.type('echo AGAIN_$((40+2))\n');
  await waitForTermText(page, 'AGAIN_42', 10_000);

  // cleanup: the terminal row + workspace, so later state reads are unchanged
  expect((await api(page, 'DELETE', `/api/terminals/${id}`)).status).toBe(200);
  expect((await api(page, 'DELETE', `/api/workspaces/${ws}`)).status).toBe(200);
});

test('scrollback backfill: a reload restores history once — and ctrl+F finds it (task/terminal-search)', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await login(page);
  const { id } = await makeTerminal(page, 'backfill ws');
  await page.click(`terminal-tabs .tab[data-term="${id}"]`);
  await waitForTermText(page, MARKER, 20_000);

  // More than a screen of history, a unique anchor at the very top of it
  // (BF_TOP_1 is a prefix of BF_TOP_10..19 — counting it would lie).
  await page.locator('agent-terminal:not(.hidden) .terminal-container').click();
  await page.keyboard.type(
    'echo BF_ANCHOR_$((40+2)); for i in $(seq 1 80); do echo BF_TOP_$i; done; echo BF_DONE_$((40+2))\n',
  );
  await waitForTermText(page, 'BF_DONE_42', 10_000);

  // Reload through the tab's deep link (a plain / reload would select
  // the first fixture workspace, not this one): the fresh page reattaches —
  // the server's backfill frame must
  // restore the HISTORY (tmux's attach redraw repaints the screen only)
  // exactly once: a doubled write would show BF_TOP_1 twice.
  await page.goto(`/?t=${id}`);
  await waitForTermText(page, 'BF_DONE_42', 20_000);
  const bufferText = await page.evaluate(() => {
    const el = document.querySelector('agent-terminal:not(.hidden)') as unknown as {
      terminal?: {
        buffer: {
          active: {
            length: number;
            getLine(i: number): { translateToString(trimRight?: boolean): string } | undefined;
          };
        };
      };
    } | null;
    const t = el?.terminal;
    if (!t) return '';
    let s = '';
    for (let i = 0; i < t.buffer.active.length; i++)
      s += t.buffer.active.getLine(i)?.translateToString(true) + '\n';
    return s;
  });
  expect(bufferText).toContain('BF_ANCHOR_42');
  expect(bufferText.split('BF_ANCHOR_42').length - 1).toBe(1);

  // ctrl+F with the terminal focused opens the find bar (not the
  // browser's); the query scrolls the viewport up to the topmost match.
  await page.locator('agent-terminal:not(.hidden) .terminal-container').click();
  await page.keyboard.press('Control+f');
  const find = page.locator('agent-terminal:not(.hidden) .terminal-find');
  await expect(find).toBeVisible();
  await find.locator('wa-input.terminal-find-input input').fill('BF_ANCHOR_42');
  await expect
    .poll(
      async () =>
        await page.evaluate(() => {
          const el = document.querySelector('agent-terminal:not(.hidden)') as unknown as {
            terminal?: {
              rows: number;
              buffer: {
                active: {
                  viewportY: number;
                  getLine(
                    i: number,
                  ): { translateToString(trimRight?: boolean): string } | undefined;
                };
              };
            };
          } | null;
          const t = el?.terminal;
          if (!t) return '';
          let s = '';
          for (let i = t.buffer.active.viewportY; i < t.buffer.active.viewportY + t.rows; i++)
            s += t.buffer.active.getLine(i)?.translateToString(true) + '\n';
          return s;
        }),
      { timeout: 5_000 },
    )
    .toContain('BF_ANCHOR_42');
});

test('jobs: validate, save, run now, delete', async ({ page }) => {
  await login(page);
  expect((await api(page, 'GET', '/api/jobs')).json).toMatchObject({ available: true, jobs: [] });

  // Cron validation: 5 fields accepted, other syntaxes rejected with the
  // first error (the old OnCalendar spec no longer parses).
  const good = await api(page, 'POST', '/api/jobs/validate', { schedule: '*/5 * * * *' });
  expect(good.status).toBe(200);
  expect(good.json).toMatchObject({ valid: true, validatedBy: 'cron-parser' });
  expect(typeof good.json.next).toBe('string');
  for (const bad of ['daily 08:00', '99 * * * *', '*/5 * * *']) {
    const r = await api(page, 'POST', '/api/jobs/validate', { schedule: bad });
    expect(r.json.valid, bad).toBe(false);
    expect(typeof r.json.error).toBe('string');
  }

  // Save (bad schedule rejected with 400, not a save).
  expect(
    (
      await api(page, 'POST', '/api/jobs', {
        name: 'itest-job',
        schedule: 'daily 08:00',
        command: 'true',
      })
    ).status,
  ).toBe(400);
  const saved = await api(page, 'POST', '/api/jobs', {
    name: 'itest-job',
    schedule: '*/5 * * * *',
    command: 'sleep 300',
  });
  expect(saved.json).toMatchObject({ name: 'itest-job' });

  // The /jobs page arrives with the job card server-rendered (the HTML
  // itself, before any script runs) — and shows it.
  const html = await page.evaluate(async () => (await fetch('/jobs')).text());
  expect(html).toContain('itest-job');
  await page.goto('/jobs');
  await expect(page.locator('jobs-app .job')).toHaveCount(1);
  await expect(page.locator('jobs-app .job-name')).toContainText('itest-job');
  await expect(page.locator('jobs-app .job-meta')).toContainText('*/5 * * * *');

  // Run now: a live cybermole-<name> tmux session on the suite's socket.
  const run = await api(page, 'POST', '/api/jobs/itest-job/run');
  expect(run.json).toMatchObject({ name: 'itest-job', session: 'cybermole-itest-job' });
  const live = () => {
    try {
      return execFileSync('tmux', ['-L', TMUX_SOCKET, 'list-sessions', '-F', '#{session_name}'], {
        encoding: 'utf8',
      });
    } catch {
      return '';
    } // no tmux server yet
  };
  await expect.poll(live, { timeout: 10_000 }).toContain('cybermole-itest-job');

  // The run is live in the listing and the card says so.
  const listed = await api(page, 'GET', '/api/jobs');
  const job = listed.json.jobs.find((j: { name: string }) => j.name === 'itest-job');
  expect(job).toMatchObject({ running: true, session: 'cybermole-itest-job' });
  expect(job.last).toBeTruthy();
  await page.reload();
  await expect(page.locator('jobs-app .job wa-badge:has-text("running")')).toHaveCount(1);

  // A second run while the previous one is live is refused (409).
  expect((await api(page, 'POST', '/api/jobs/itest-job/run')).status).toBe(409);

  // Delete: definition gone, the live run's session is left alone.
  expect((await api(page, 'DELETE', '/api/jobs/itest-job')).status).toBe(200);
  expect((await api(page, 'DELETE', '/api/jobs/itest-job')).status).toBe(404);
  expect((await api(page, 'GET', '/api/jobs')).json.jobs).toEqual([]);
  expect(live()).toContain('cybermole-itest-job');
  execFileSync('tmux', ['-L', TMUX_SOCKET, 'kill-session', '-t', 'cybermole-itest-job']);
});

test('the jobs dialog validates against the shared schema: per-field errors, no request until valid', async ({
  page,
}) => {
  await login(page);
  await page.goto('/jobs');
  await page.waitForFunction(() => customElements.get('validation-enhancer-zod') !== undefined);
  const saves: string[] = [];
  page.on('request', r => {
    if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/jobs') saves.push(r.url());
  });
  await page.click('#jobs-new');
  await expect(page.locator('wa-input#job-name input')).toBeVisible();
  // The schema's typed-length cap reaches the real input (zod → maxlength).
  await expect(page.locator('wa-input#job-name input')).toHaveAttribute('maxlength', '40');
  await page.click('#job-save');
  await expect(page.locator('#job-name-error')).toHaveText('name is required');
  await expect(page.locator('#job-schedule-error')).toHaveText('schedule is required');
  await expect(page.locator('#job-command-error')).toHaveText('command is required');
  expect(saves).toEqual([]);
  // The name is normalized by the schema, client and server alike.
  await page.fill('wa-input#job-name input', 'Form Check');
  await page.fill('wa-input#job-schedule input', '*/5 * * * *');
  await page.fill('wa-textarea#job-command textarea', 'true');
  await page.click('#job-save');
  await expect(page.locator('jobs-app .job-name')).toContainText('form-check');
  expect(saves.length).toBe(1);
  // Re-opening the dialog starts clean.
  await page.click('#jobs-new');
  await expect(page.locator('#job-name-error')).toHaveText('');
  await page.locator('#job-dialog wa-button[data-dialog="close"]').click();
  // The card came in through the /partials/jobs-list swap: its wa-* parts
  // hydrated once (no doubled render) and its buttons work (delegation).
  await expect(page.locator('jobs-app .job')).toHaveCount(1);
  expect(
    await page
      .locator('jobs-app .job wa-button[data-del="form-check"]')
      .evaluate(el => el.shadowRoot?.querySelectorAll('[part~="base"]').length),
  ).toBe(1);
  await page.locator('jobs-app .job wa-button[data-del="form-check"]').click();
  await page.click('#job-delete-confirm');
  await expect(page.locator('jobs-app .job')).toHaveCount(0);
  await expect(page.locator('jobs-app .jobs-empty')).toContainText('no jobs yet');
});

test('jobs persist across a server restart; missed runs catch up', async () => {
  test.setTimeout(120_000);

  // Restart simulation: a copy of the state db carrying the job with its
  // last fire backdated 3 minutes — the schedule missed windows while the
  // (new) server was "down". The job lives ONLY in the copy: the webServer's
  // own ticking scheduler must not be able to fire it, so the catch-up run
  // is attributable to the restarted server alone.
  const dbCopy = `${WORKSPACE}/cybermole-restart.db`;
  fs.copyFileSync(`${WORKSPACE}/cybermole.db`, dbCopy);
  const backdate = Date.now() - 3 * 60_000;
  const w = new DatabaseSync(dbCopy);
  w.prepare(
    "INSERT INTO jobs (name, schedule, command, created_at) VALUES ('itest-persist', '* * * * *', 'sleep 60', ?)",
  ).run(backdate - 2 * 60_000);
  w.prepare(
    "INSERT INTO job_runs (job, fired_at, origin) VALUES ('itest-persist', ?, 'schedule')",
  ).run(backdate);
  w.close();

  // Second server, same workspace shape as the suite webServer (its own
  // port; the tmux socket and session command are shared).
  const PORT2 = 3471;
  const child = spawn('node', ['dist-server/server/main.js'], {
    env: {
      ...process.env,
      CYBERMOLE_PORT: String(PORT2),
      CYBERMOLE_HOST: '127.0.0.1',
      CYBERMOLE_DB_FILE: dbCopy,
      CYBERMOLE_AGENT_DIR: `${WORKSPACE}/pi-agent`,
      CYBERMOLE_NEW_SESSION_CWD: WORKSPACE,
      CYBERMOLE_TMUX_SOCKET: TMUX_SOCKET,
      CYBERMOLE_COMMAND: `${WORKSPACE}/cmd.sh`,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let bootLog = '';
  child.stderr!.setEncoding('utf8').on('data', (d: string) => {
    bootLog += d;
  });

  const sessions = () => {
    try {
      return execFileSync('tmux', ['-L', TMUX_SOCKET, 'list-sessions', '-F', '#{session_name}'], {
        encoding: 'utf8',
      });
    } catch {
      return '';
    }
  };
  try {
    // Booted: the job survived the restart — listed by the new server.
    await expect
      .poll(
        async () => {
          try {
            return (await fetch(`http://127.0.0.1:${PORT2}/login`)).status;
          } catch {
            return 0;
          }
        },
        { timeout: 20_000 },
      )
      .toBe(200);
    const login2 = await fetch(`http://127.0.0.1:${PORT2}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
    });
    const cookie = (login2.headers.get('set-cookie') ?? '').split(';')[0];
    const listed = await fetch(`http://127.0.0.1:${PORT2}/api/jobs`, {
      headers: { Cookie: cookie },
    });
    const state = (await listed.json()) as { jobs: Array<{ name: string }> };
    expect(state.jobs.map(j => j.name)).toContain('itest-persist');

    // Catch-up: the first scheduler tick (≤30s after boot) sees the missed
    // window and fires ONE run — a live cybermole-<name> session on the socket.
    await expect.poll(sessions, { timeout: 45_000 }).toContain('cybermole-itest-persist');

    // ...and the fire is recorded (newer than the backdated row, as catchup).
    const r = new DatabaseSync(dbCopy);
    const last = r
      .prepare("SELECT MAX(fired_at) AS last FROM job_runs WHERE job = 'itest-persist'")
      .get() as { last: number };
    const origins = r
      .prepare("SELECT DISTINCT origin FROM job_runs WHERE job = 'itest-persist'")
      .all() as Array<{ origin: string }>;
    r.close();
    expect(last.last!).toBeGreaterThan(backdate);
    expect(origins.map(o => o.origin)).toContain('catchup');
  } finally {
    child.kill('SIGKILL');
    await new Promise<void>(resolve => child.once('exit', () => resolve()));
    if (sessions().includes('cybermole-itest-persist')) {
      execFileSync('tmux', ['-L', TMUX_SOCKET, 'kill-session', '-t', 'cybermole-itest-persist']);
    }
    fs.rmSync(dbCopy, { force: true });
    if (bootLog && !/ExperimentalWarning/.test(bootLog))
      console.log(`restart-server stderr:\n${bootLog}`);
  }
});

test('jobs: app tag chip, persisted run logs, run history + log view (task/ws-jobs)', async ({
  page,
}) => {
  test.setTimeout(150_000);
  await login(page);

  // An app to tag with (the tag is display-only — no behavioral coupling).
  const app = await api(page, 'POST', '/api/apps', { name: 'E2E Jobs App' });
  expect(app.status).toBe(200);
  const appId = app.json.id as string;

  // The runs routes' guards, before anything ran: a bad job name or a
  // malformed :fired_at is a 400, an unknown job a 404.
  expect(await api(page, 'GET', '/api/jobs/%E0/runs')).toMatchObject({ status: 400 });
  expect(await api(page, 'GET', '/api/jobs/none-such/runs')).toMatchObject({ status: 404 });

  // Save with the app tag through the dialog the way a user would: the
  // picker's options come from the same server render (data-apps), and
  // the save carries the picked id.
  await page.goto('/jobs');
  await page.waitForFunction(() => customElements.get('jobs-app') !== undefined);
  await page.click('#jobs-new');
  await expect(page.locator('wa-select#job-app')).toBeVisible();
  // Options are (re)populated on open from the swapped-in list's data-apps:
  // the fixture's "alpha app" (global-setup) plus this test's app.
  const options = page.locator('#job-app wa-option');
  await expect(options).toHaveCount(2);
  const picked = options.filter({ hasText: 'E2E Jobs App' });
  await expect(picked).toHaveCount(1);
  expect(await picked.getAttribute('value')).toBe(appId);
  expect(await picked.textContent()).toBe('E2E Jobs App');
  // Select the app (the value the save reads), then fill the rest.
  await page.evaluate(id => {
    (document.querySelector('#job-app') as unknown as { value: string }).value = id;
  }, appId);
  await page.fill('wa-input#job-name input', 'e2e-job');
  await page.fill('wa-input#job-schedule input', '0 0 31 12 *'); // never due — runs below are manual
  await page.fill('wa-textarea#job-command textarea', 'echo JOBS_RUN_MARKER; sleep 8');
  await page.click('#job-save');
  await expect(page.locator('jobs-app .job')).toHaveCount(1);

  // The tag chip renders (the card also carries the tag for re-edit).
  await expect(page.locator('jobs-app .job-app')).toHaveText('E2E Jobs App');
  expect(
    await page.locator('jobs-app wa-button[data-edit="e2e-job"]').getAttribute('data-app'),
  ).toBe(appId);
  // ...and the listing answers it (LEFT JOIN — no second fetch).
  const listed = await api(page, 'GET', '/api/jobs');
  expect(listed.json.jobs[0]).toMatchObject({
    appId,
    appName: 'E2E Jobs App',
    lastResult: 'unknown',
  });
  // The runs routes' param guards, now that the job exists: a malformed
  // :fired_at (not an integer epoch-ms value) is a 400; a well-formed
  // one that names no run is a 404 — as is a run whose log was never
  // written (none exists yet).
  for (const bad of ['abc', '-1', '12.5', '1234567890123456', '17600000000001234']) {
    expect(await api(page, 'GET', `/api/jobs/e2e-job/runs/${bad}/log`)).toMatchObject({
      status: 400,
      json: { code: 'invalid_fired_at' },
    });
  }
  expect(await api(page, 'GET', '/api/jobs/e2e-job/runs/1760000000000/log')).toMatchObject({
    status: 404,
  });
  // An empty history still answers its shape.
  expect(await api(page, 'GET', '/api/jobs/e2e-job/runs')).toMatchObject({
    status: 200,
    json: { runs: [] },
  });

  // Run now (the card's button): a live cybermole-<name> session whose
  // wrapper tees output to a durable log under CYBERMOLE_JOB_LOG_DIR.
  await page.click('jobs-app wa-button[data-run="e2e-job"]');
  await expect(page.locator('jobs-app .job-view')).toHaveAttribute('href', /\?run=cybermole-e2e-job$/);
  // expect.poll retries a bad VALUE, not a thrown callback — ENOENT while
  // the pane's mkdir -p lands must read as 0 so the window keeps polling.
  const logDirEntries = () => {
    try {
      return fs.readdirSync(`${WORKSPACE}/job-logs/e2e-job`).length;
    } catch {
      return 0;
    }
  };
  await expect.poll(logDirEntries, { timeout: 10_000 }).toBeGreaterThanOrEqual(1);
  // The live run's session really is up, and its runs row exists (no
  // exit/finish yet — the run is still going).
  const live = () => {
    try {
      return execFileSync('tmux', ['-L', TMUX_SOCKET, 'list-sessions', '-F', '#{session_name}'], {
        encoding: 'utf8',
      });
    } catch {
      return '';
    }
  };
  await expect.poll(live, { timeout: 10_000 }).toContain('cybermole-e2e-job');
  const runsLive = await api(page, 'GET', '/api/jobs/e2e-job/runs');
  expect(runsLive.json.runs[0]).toMatchObject({
    origin: 'manual',
    exitCode: null,
    finishedAt: null,
    hasLog: true,
  });

  // The "view run" link is the console deep link (plan §9): the terminal
  // attaches in run mode and shows the run's output.
  await page.click('jobs-app .job-view');
  await page.waitForURL(u => u.pathname === '/');
  await waitForTermText(page, 'JOBS_RUN_MARKER');

  // The run ends (~8s) and the tick observes it (≤30s later): exit_code
  // + finished_at fill in, lastResult finally reports an outcome.
  const lastResult = async (name: string): Promise<string | null> => {
    try {
      return (
        (await api(page, 'GET', '/api/jobs')).json.jobs.find(
          (j: { name: string }) => j.name === name,
        )?.lastResult ?? null
      );
    } catch {
      return null;
    }
  };
  await expect.poll(() => lastResult('e2e-job'), { timeout: 45_000 }).toBe('success');
  const after = await api(page, 'GET', '/api/jobs/e2e-job/runs');
  expect(after.json.runs[0]).toMatchObject({ exitCode: 0 });
  expect(typeof after.json.runs[0].finishedAt).toBe('number');

  // The history dialog renders the run (fired/origin/duration/exit) and
  // the log viewer shows the wrapper's appended tail.
  await page.goto('/jobs');
  await page.click('jobs-app wa-button[data-runs="e2e-job"]');
  await expect(page.locator('#runs-dialog .run-row:not(.run-head)')).toHaveCount(1);
  await expect(page.locator('#runs-dialog .run-row:not(.run-head)')).toContainText('manual');
  await expect(page.locator('#runs-dialog .run-exit.ok')).toHaveText('exit 0');
  await page.click('#runs-dialog wa-button[data-log]');
  await expect(page.locator('#run-log')).toContainText('JOBS_RUN_MARKER');

  // The log route itself: text/plain, the same tail, no-store.
  const firedAt = after.json.runs[0].firedAt as number;
  const log = await page.evaluate(async at => {
    const r = await fetch(`/api/jobs/e2e-job/runs/${at}/log`);
    return {
      status: r.status,
      type: r.headers.get('content-type'),
      cache: r.headers.get('cache-control'),
      text: await r.text(),
    };
  }, firedAt);
  expect(log.status).toBe(200);
  expect(log.type).toContain('text/plain');
  expect(log.cache).toBe('no-store');
  expect(log.text).toContain('JOBS_RUN_MARKER');
  // The run's own log path answers 404 (a client never names a path).
  expect(await api(page, 'GET', '/api/jobs/e2e-job/runs/1/log')).toMatchObject({ status: 404 });
  // The runs dialog is a MODAL (showModal + backdrop): close it before
  // anything outside it is clicked, like the job dialog above.
  await page.locator('#runs-dialog wa-button[data-dialog="close"]').click();

  // A failed run reports failed (the exit file carries the real code).
  await api(page, 'POST', '/api/jobs', {
    name: 'e2e-fail',
    schedule: '0 0 31 12 *',
    command: 'echo bad; exit 7',
  });
  await api(page, 'POST', '/api/jobs/e2e-fail/run');
  await expect.poll(() => lastResult('e2e-fail'), { timeout: 45_000 }).toBe('failed');
  await page.click('jobs-app wa-button[data-runs="e2e-fail"]');
  await expect(page.locator('#runs-dialog .run-exit.failed')).toHaveText('exit 7');

  // Cleanup: both jobs (and their run files) go, and the app with them —
  // the live sessions die with the jobs' commands.
  for (const name of ['e2e-job', 'e2e-fail']) {
    expect((await api(page, 'DELETE', `/api/jobs/${name}`)).status).toBe(200);
    fs.rmSync(`${WORKSPACE}/job-logs/${name}`, { recursive: true, force: true });
  }
  expect((await api(page, 'DELETE', '/api/apps/e2e-jobs-app')).status).toBe(200);
});

// The jobs-agent-plan §4+§7 acceptance line (docs/jobs-agent-plan.md):
// a mutation over the INTERNAL SOCKET — the agent path — updates an
// OPEN /jobs page without waiting for the 15 s poll. The chain is
// service-layer events → /ws/events → the page's partial refresh; one
// source of truth, evented. The window is 6 s and the mutation fires
// ~1 s after load, so the poll (ticks at 15 s from load) can never be
// what satisfies it — only the WS path can.
test('an internal-socket mutation updates an open /jobs page without the poll (jobs-agent-plan §4+§7 acceptance)', async ({
  page,
}) => {
  await login(page);
  await page.goto('/jobs');
  await expect(page.locator('jobs-app')).toBeVisible();

  // The agent transport: plain node:http over the suite webServer's
  // internal socket (CYBERMOLE_SOCK in playwright.config — the file mode is
  // the gate). Same Result JSON shapes as the browser API (plan §4).
  const internalApi = (
    method: string,
    url: string,
    body?: unknown,
  ): Promise<{ status: number; json: { name?: string; errorCode?: string } | null }> =>
    new Promise((resolve, reject) => {
      const payload = body === undefined ? null : JSON.stringify(body);
      const req = http.request(
        {
          socketPath: `${WORKSPACE}.sock`, // sibling of WORKSPACE — see playwright.config
          path: url,
          method,
          // Chunked bodies are refused (411) — the internal API demands a
          // Content-Length exactly like the CLI (plan §4) does.
          headers:
            payload === null
              ? { 'Content-Type': 'application/json' }
              : {
                  'Content-Type': 'application/json',
                  'Content-Length': String(Buffer.byteLength(payload)),
                },
        },
        res => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString();
            let json: { name?: string; errorCode?: string } | null = null;
            try {
              json = text ? JSON.parse(text) : null;
            } catch {
              json = null;
            }
            resolve({ status: res.statusCode ?? 0, json });
          });
        },
      );
      req.setTimeout(5_000, () => req.destroy(new Error('internal API timeout')));
      req.on('error', reject);
      if (payload !== null) req.write(payload);
      req.end();
    });

  // Create over the socket (the agent's jobs_create): the card appears
  // on the open page well inside the poll's shadow.
  const created = await internalApi('POST', '/jobs', {
    name: 'sock-live',
    schedule: '*/5 * * * *',
    command: 'sleep 3',
  });
  expect(created.json).toMatchObject({ name: 'sock-live' });
  await expect
    .poll(() => page.locator('jobs-app .job-name', { hasText: 'sock-live' }).count(), {
      timeout: 6_000,
    })
    .toBe(1);

  // Run-now over the socket (jobs_run_now): run_started → the badge
  // flips on the open page. sleep 3 ends on its own — nothing to clean.
  const fired = await internalApi('POST', '/jobs/sock-live/run');
  expect(fired.json).toMatchObject({ name: 'sock-live' });
  await expect
    .poll(() => page.locator('jobs-app .job wa-badge:has-text("running")').count(), {
      timeout: 6_000,
    })
    .toBe(1);

  // Delete over the socket (jobs_delete): the card leaves the open page.
  const deleted = await internalApi('DELETE', '/jobs/sock-live');
  expect(deleted.json).toMatchObject({ name: 'sock-live' });
  await expect
    .poll(() => page.locator('jobs-app .job-name', { hasText: 'sock-live' }).count(), {
      timeout: 6_000,
    })
    .toBe(0);
});

test('the workspace filter matches names, hides empty groups, and survives the poll re-render', async ({
  page,
}) => {
  await login(page);
  const search = page.locator('wa-input#workspace-search input');
  const rows = page.locator('workspace-sidebar li[data-ws]');
  const groups = page.locator('workspace-sidebar .ws-group');

  // Name match: one row, one group (the app group hides — no match in it).
  await search.fill('deploy');
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText('deploy checklist');
  await expect(groups).toHaveCount(1);
  await expect(groups.first().locator('h2 .g-name')).toHaveText('console');

  // Name-only match (the plan's locked shape): a cwd fragment of a
  // fixture workspace's directory matches nothing.
  await search.fill('cybermole-itest');
  await expect(rows).toHaveCount(0);
  await expect(groups).toHaveCount(0);
  await search.fill('scratch');
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText('scratch');

  // No match: every group hides.
  await search.fill('zzz-no-match');
  await expect(rows).toHaveCount(0);
  await expect(groups).toHaveCount(0);

  // Escape clears. Rows are permanent in the workspace model (unlike the
  // old live sessions): count whatever the shared db holds at this point —
  // the fixtures plus the workspaces earlier specs left behind.
  const total = (await api(page, 'GET', '/api/state')).json.workspaces.length;
  expect(total).toBeGreaterThanOrEqual(3); // the three fixtures
  await search.press('Escape');
  await expect(rows).toHaveCount(total);

  // A state poll re-render (the 15s interval, forced here) must not eat
  // the search box: value, focus and caret are restored.
  await search.fill('checklist');
  await page.keyboard.press('ArrowLeft'); // caret mid-string, not at the end
  const caretBefore = await page.evaluate(() => {
    const wa = document.querySelector('#workspace-search') as HTMLElement & {
      shadowRoot: ShadowRoot | null;
    };
    return wa.shadowRoot?.querySelector('input')?.selectionStart ?? null;
  });
  expect(caretBefore).toBe(8);
  await refreshState(page);
  await page.waitForFunction(() => {
    const wa = document.querySelector('#workspace-search') as HTMLElement & {
      shadowRoot: ShadowRoot | null;
    };
    const native = wa.shadowRoot?.querySelector('input') ?? null;
    // Focus inside an open shadow root retargets document.activeElement to
    // the host, so accept either the host or the inner input being focused.
    return (
      native != null &&
      native.value === 'checklist' &&
      (document.activeElement === wa || wa.shadowRoot?.activeElement === native)
    );
  });
  const caretAfter = await page.evaluate(() => {
    const wa = document.querySelector('#workspace-search') as HTMLElement & {
      shadowRoot: ShadowRoot | null;
    };
    return wa.shadowRoot?.querySelector('input')?.selectionStart ?? null;
  });
  expect(caretAfter).toBe(caretBefore);
  // The filter is still applied after the re-render.
  await expect(rows).toHaveCount(1);

  // Escape clears again (a re-rendered search box still wires its events).
  await search.press('Escape');
  await expect(rows).toHaveCount(total);
});

test('nav groups collapse per app: rows hide, state survives poll re-render + reload, aria-expanded tracks it (task/collapsible-apps)', async ({
  page,
}) => {
  await login(page);
  // Fixture order (global-setup): the console group first, then "alpha app".
  const groups = page.locator('workspace-sidebar .ws-group');
  const app = page.locator('workspace-sidebar .ws-group[data-group="alpha-app"]');
  const toggle = app.locator('h2 .g-collapse');
  const rows = app.locator('.ws-group-rows');

  // Both groups start expanded.
  await expect(groups.first().locator('h2 .g-collapse')).toHaveAttribute('aria-expanded', 'true');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(rows).toBeVisible();
  await expect(rows.locator('li[data-ws]')).toBeVisible();

  // Collapse the app group: its rows hide, the header stays (name +
  // the + workspace affordance), the console group is untouched.
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(rows).toBeHidden();
  await expect(rows.locator('li[data-ws]')).toBeHidden();
  await expect(app.locator('h2 .g-name')).toHaveText('alpha app');
  await expect(groups.first().locator('.ws-group-rows')).toBeVisible();
  // The toggle is a real <button> flipped in place — focus survives the click.
  await expect(toggle).toBeFocused();

  // Persisted under the app's stable slug in the namespaced localStorage key.
  const stored = await page.evaluate(() => localStorage.getItem('cybermole:nav-collapsed'));
  expect(JSON.parse(stored ?? '{}')).toEqual({ 'alpha-app': true });

  // The 15s poll re-render keeps the group collapsed (no flicker open).
  await refreshState(page);
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(rows).toBeHidden();

  // The collapsed header's + workspace affordance still works.
  await app.locator('[data-new-ws]').click();
  await expect(page.locator('wa-input#workspace-name input')).toBeVisible();
  await page.locator('#workspace-dialog wa-button[data-dialog="close"]').click();

  // Reload: the collapse persists from localStorage (same context).
  await page.reload();
  await page.waitForSelector('workspace-sidebar .nav');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(rows).toBeHidden();

  // A non-empty filter forces groups open (matches visible) without
  // touching the stored state; clearing it restores the collapse.
  const search = page.locator('wa-input#workspace-search input');
  await search.fill('proj');
  await expect(app.locator('li[data-ws]')).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await search.fill('');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(rows).toBeHidden();

  // Expanding again works and persists (keyboard path — it's a real button).
  await toggle.focus();
  await page.keyboard.press('Enter');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(rows).toBeVisible();
  const storedAfterExpand =
    (await page.evaluate(() => localStorage.getItem('cybermole:nav-collapsed'))) ?? '{}';
  expect(JSON.parse(storedAfterExpand)).toEqual({});
});

test('signed out, any page URL serves the login page and sign-in returns to it', async ({
  page,
}) => {
  // Regression: /jobs answered a bare "unauthorized" while / and /settings
  // rendered the login page.
  await page.goto('/jobs');
  await expect(page.locator('wa-input#username input')).toHaveCount(1);
  await signIn(page);
  await expect(page.locator('jobs-app .jobs-main')).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/jobs');
});

test('unauthenticated /settings serves the login page; settings APIs stay guarded', async ({
  page,
  request,
}) => {
  await page.goto('/settings');
  await expect(page.locator('wa-input#username input')).toHaveCount(1);
  expect((await request.get('/api/settings')).status()).toBe(401);
  expect((await request.post('/api/update-pi', { data: {} })).status()).toBe(401);
  expect((await request.post('/api/auto-update-pi', { data: { enabled: true } })).status()).toBe(
    401,
  );
});

test('settings dashboard shows effective config; update dry-run is check-only', async ({
  page,
}) => {
  await login(page);
  // The global header bar's settings link is the way in.
  await expect(page.locator('app-header wa-button[href$="/settings"]')).toBeVisible();
  await page.goto('/settings');

  const cfg = page.locator('#config');
  await expect(cfg.locator('.cfg-row')).toHaveCount(11);
  const text = await cfg.innerText();
  expect(text).toContain('cybermole-itest'); // tmux socket (config env)
  expect(text).toContain('cmd.sh'); // the shell a new terminal tab runs
  expect(text).toContain('default workspace cwd'); // relabeled (plan §10)
  expect(text).toContain('/tmp/cybermole-itest/cybermole.db'); // state db path — path only, never contents
  await expect(page.locator('#pi-badge')).toContainText(/pi /);
  await expect(page.locator('#pi-declared')).toContainText('declared');

  // Check-only dry-run through the authed page — installs nothing.
  const dry = await page.evaluate(async () => {
    const r = await fetch('/api/update-pi', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"dryRun":true}',
    });
    return { status: r.status, body: await r.json() };
  });
  expect(dry.status).toBe(200);
  expect(dry.body.ok).toBe(true);
  expect(dry.body.dryRun).toBe(true);
  expect(dry.body.output).toContain('would run');
});

test('terminal defaults: the /settings form validates, saves, and the override persists across a reload (task/defaults-settings)', async ({
  page,
}) => {
  await login(page);
  await page.goto('/settings');
  await page.waitForFunction(() => customElements.get('validation-enhancer-zod') !== undefined);
  // The fields prefill once upgraded (wa-input's value is a property —
  // settings-app sets it from the server-rendered source region).
  await page.waitForFunction(
    () =>
      typeof (
        document.querySelector('wa-input#shell-command') as unknown as { value?: string | null }
      )?.value === 'string',
  );
  const fieldValue = (id: string): Promise<string> =>
    page.evaluate(
      i => (document.querySelector(`wa-input#${i}`) as unknown as { value: string | null }).value ?? '',
      id,
    );

  // Prefilled with the EFFECTIVE values — what a new tab would actually
  // run: this suite pins both env vars (cmd.sh, with the agent marker arg).
  expect(await fieldValue('shell-command')).toBe(`${WORKSPACE}/cmd.sh`);
  expect(await fieldValue('agent-command')).toBe(`${WORKSPACE}/cmd.sh agent`);
  // The schema's typed cap reaches the real input (zod → maxlength).
  await expect(page.locator('wa-input#shell-command input')).toHaveAttribute('maxlength', '500');

  // Client-side validation (the shared schema): whitespace-only is the
  // invalid case (an EMPTY field is a legal clear — its value is null),
  // and nothing is POSTed while invalid.
  const posts: string[] = [];
  page.on('request', r => {
    if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/settings')
      posts.push(new URL(r.url()).pathname);
  });
  await page.fill('wa-input#shell-command input', '   ');
  await page.click('#save-terminal-defaults');
  await expect(page.locator('#shell-command-error')).toHaveText('command is required');
  // The message lives in the wa-input's hint slot: the REAL input is
  // described by it (AGENTS.md — the login-form precedent).
  await expect(page.locator('wa-input#shell-command input')).toHaveAccessibleDescription(
    /command is required/,
  );
  expect(posts).toEqual([]);

  // Save a shell override — and the agent field rides along as its shown
  // (effective) value: a save pins both fields (the form never lies about
  // what it saves; the status line says which side each value came from).
  await page.fill('wa-input#shell-command input', '/bin/dash -l');
  await page.click('#save-terminal-defaults');
  await expect(page.locator('#terminal-defaults-result:not(.hidden)')).toContainText('saved');
  await expect(page.locator('#terminal-defaults-source')).toContainText('(override saved)');

  // Persisted: a reload re-prefills from the db overrides, and the API
  // carries the same effective pair + flags.
  await page.reload();
  await page.waitForFunction(
    () =>
      typeof (
        document.querySelector('wa-input#shell-command') as unknown as { value?: string | null }
      )?.value === 'string',
  );
  expect(await fieldValue('shell-command')).toBe('/bin/dash -l');
  const st = (await api(page, 'GET', '/api/settings')).json;
  expect(st.terminalDefaults).toMatchObject({
    agentCommand: `${WORKSPACE}/cmd.sh agent`,
    shellCommand: '/bin/dash -l',
    agentOverridden: true,
    shellOverridden: true,
  });
  expect(st.command).toBe('/bin/dash -l'); // the config row follows the override

  // The server validates with the same schema: a >500-char string is a 400
  // with the field's issue.
  const tooLong = await api(page, 'POST', '/api/settings', { shellCommand: 'x'.repeat(501) });
  expect(tooLong.status).toBe(400);
  expect(tooLong.json.issues.shellCommand).toContain('too long');

  // Reset to defaults: both overrides clear (the rows are gone, the env
  // chain answers again) — clean state for the rest of the suite.
  await page.click('#reset-terminal-defaults');
  await expect(page.locator('#terminal-defaults-result:not(.hidden)')).toContainText('defaults');
  await expect(page.locator('#terminal-defaults-source')).toContainText('(default)');
  const after = (await api(page, 'GET', '/api/settings')).json.terminalDefaults;
  expect(after).toMatchObject({ agentOverridden: false, shellOverridden: false });
  expect(after.shellCommand).toBe(`${WORKSPACE}/cmd.sh`);
  const db = new DatabaseSync(`${WORKSPACE}/cybermole.db`);
  expect(
    db.prepare("SELECT count(*) c FROM settings WHERE key LIKE 'terminalDefaults.%'").get(),
  ).toMatchObject({ c: 0 });
  db.close();
});

// ---------- browser hardening (DESIGN_REVIEW §1.2) ----------

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "connect-src 'self' wss:; frame-ancestors 'none'";

/** The four security headers every app-sent response carries. */
function expectSecurityHeaders(headers: Record<string, string>): void {
  expect(headers['content-security-policy']).toBe(CSP);
  expect(headers['x-frame-options']).toBe('DENY');
  expect(headers['x-content-type-options']).toBe('nosniff');
  expect(headers['referrer-policy']).toBe('same-origin');
}

test('non-GET requests with a foreign Origin are rejected; no Origin behaves normally', async ({
  page,
  request,
}) => {
  await page.goto('/login'); // establish the suite origin for the page below
  // A present-but-mismatched Origin (sibling subdomain, sandboxed "null")
  // is 403 before auth is even consulted.
  for (const origin of ['https://evil.example', 'https://console.example.com', 'null']) {
    const r = await request.post('/api/apps', { headers: { Origin: origin }, data: { name: 'x' } });
    expect(r.status(), `Origin: ${origin}`).toBe(403);
  }
  // No Origin header at all (curl, API clients) and a matching Origin both
  // reach the normal auth gate — 401 here, this context has no session.
  expect((await request.post('/api/apps', { data: { name: 'x' } })).status()).toBe(401);
  const origin = new URL(page.url()).origin;
  expect(
    (
      await request.post('/api/apps', { headers: { Origin: origin }, data: { name: 'x' } })
    ).status(),
  ).toBe(401);

  // The browser path — a same-origin POST from an authed page — keeps
  // working (the browser attaches the page's own Origin). The schedule
  // validator is the side-effect-free POST.
  await login(page);
  expect(
    await page.evaluate(
      async () =>
        (
          await fetch('/api/jobs/validate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{"schedule":""}',
          })
        ).status,
    ),
  ).toBe(200);
});

test('WS upgrades demand a matching Origin — missing or foreign destroys the socket', async ({
  page,
}) => {
  await login(page);
  const token = (await page.context().cookies()).find(c => c.name === 'cybermole_session')?.value ?? '';
  const wsOrigin = new URL(page.url()).origin;

  // Raw ws client from the test process: browsers can't omit or forge
  // Origin, so the gate is only observable from Node.
  const attempt = (headers: Record<string, string>): Promise<'open' | 'rejected'> =>
    new Promise(resolve => {
      const ws = new NodeWebSocket(`${wsOrigin.replace(/^http/, 'ws')}/ws`, { headers });
      let settled = false;
      const settle = (v: 'open' | 'rejected'): void => {
        if (settled) return;
        settled = true;
        try {
          ws.close();
        } catch {
          /* never opened */
        }
        resolve(v);
      };
      ws.on('open', () => settle('open'));
      ws.on('error', () => settle('rejected'));
      ws.on('unexpected-response', () => settle('rejected'));
      ws.on('close', () => settle('rejected'));
    });

  // Missing Origin: the endpoint is browser-only — no curl/websocat
  // terminals — so the socket is destroyed, not a polite 4xx.
  expect(await attempt({})).toBe('rejected');
  // Foreign Origin (cross-site WebSocket hijacking) is destroyed too.
  expect(await attempt({ Origin: 'https://evil.example' })).toBe('rejected');
  // A matching Origin without a session gets the 401 handshake, and with
  // the session cookie the upgrade completes.
  expect(await attempt({ Origin: wsOrigin })).toBe('rejected');
  expect(await attempt({ Origin: wsOrigin, Cookie: `cybermole_session=${token}` })).toBe('open');

  // The 401 handshake is written by hand on the raw socket (the upgrade
  // path has no ServerResponse helpers) — pin that the security-header
  // block rides on it too, not just on ordinary responses.
  const handshake = await new Promise<Record<string, string>>(resolve => {
    let settled = false;
    const done = (h: Record<string, string>): void => {
      if (settled) return;
      settled = true;
      resolve(h);
    };
    const ws = new NodeWebSocket(`${wsOrigin.replace(/^http/, 'ws')}/ws`, {
      headers: { Origin: wsOrigin },
    });
    ws.on('unexpected-response', (_req, res) => {
      done(res.headers as Record<string, string>);
      res.resume(); // drain so the rejected socket can close
    });
    ws.on('error', () => done({}));
    ws.on('close', () => done({}));
  });
  expectSecurityHeaders(handshake);
});

test('security headers ride on page, asset and API responses', async ({ request }) => {
  const page = await request.get('/login');
  expect(page.status()).toBe(200);
  expectSecurityHeaders(page.headers());

  // A hashed Astro asset referenced by that page (external module — the
  // CSP's script-src 'self' depends on Astro never inlining scripts).
  const src = (await page.text()).match(/<script[^>]*\bsrc="([^"]+)"/)?.[1];
  expect(src).toBeTruthy();
  const asset = await request.get(src!);
  expect(asset.status()).toBe(200);
  expectSecurityHeaders(asset.headers());

  // An API response (this 401 is itself sent by the app, headers and all).
  const api = await request.get('/api/state');
  expect(api.status()).toBe(401);
  expectSecurityHeaders(api.headers());
});

test('console/jobs/settings load requests nothing off-origin and glyphs render from the app itself', async ({
  page,
}) => {
  await login(page);
  const self = new URL(page.url()).origin;
  const external: string[] = [];
  // Aborting (not just observing) proves the page works without them:
  // under the CSP a CDN icon fetch would fail and the glyph would vanish.
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== self) {
      external.push(url.href);
      return route.abort();
    }
    return route.continue();
  });

  const glyphsRender = (): Promise<boolean> =>
    page
      .waitForFunction(
        () => {
          const icons = [...document.querySelectorAll('wa-icon')];
          return icons.length > 0 && icons.every(i => i.shadowRoot?.querySelector('svg') != null);
        },
        null,
        { timeout: 8000 },
      )
      .then(
        () => true,
        () => false,
      );

  await page.goto('/');
  await page.waitForSelector('workspace-sidebar .nav');
  expect(await glyphsRender()).toBe(true);
  for (const p of ['/jobs', '/settings']) {
    await page.goto(p);
    expect(await glyphsRender(), `${p} glyphs`).toBe(true);
  }
  expect(external).toEqual([]);
});

test('logout ends live terminal sockets: signed-out message, no reconnect', async ({ page }) => {
  await login(page);
  const { id } = await makeTerminal(page, 'signout ws');
  await page.click(`terminal-tabs .tab[data-term="${id}"]`);
  await waitForTermText(page, MARKER, 20_000);
  await expect(page.locator('.terminal-status.ok')).toContainText(`attached: t-${id}`);

  // Keep the page on the console while its session dies: the sidebar poll
  // (and the terminal-closed re-poll) would otherwise 401 → /login. The
  // mock replays the §5-shaped state captured while still signed in — an
  // EMPTY tree would re-render the console to the no-workspace state and
  // tear the pane under test down with it.
  const stateBody = await page.evaluate(async () => (await fetch('/api/state')).text());
  await page.route('**/api/state', route =>
    route.fulfill({ body: stateBody, contentType: 'application/json' }),
  );

  // Protocol: a second socket on the same cookie sees 'signed-out' and
  // then the close — in that order.
  const events = page.evaluate(async () => {
    const ws = new WebSocket(`ws://${location.host}/ws`);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = reject;
    });
    const seen = new Promise<string[]>(resolve => {
      const log: string[] = [];
      ws.onmessage = ev =>
        log.push('msg:' + (JSON.parse(ev.data as string) as { type: string }).type);
      ws.onclose = () => {
        log.push('close');
        resolve(log);
      };
    });
    await fetch('/logout', { method: 'POST' });
    return await Promise.race([
      seen,
      new Promise<string[]>(resolve => setTimeout(() => resolve(['timeout']), 5000)),
    ]);
  });
  expect(await events).toEqual(['msg:signed-out', 'close']);

  // The terminal renders it and does not retry: status stays 'signed out'
  // past the first reconnect backoff (which would show 'reconnecting').
  await expect(page.locator('.terminal-status.info')).toContainText('signed out');
  await waitForTermText(page, 'signed out');
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            document.querySelector('agent-terminal:not(.hidden)') as unknown as {
              websocket?: WebSocket;
            }
          ).websocket === undefined,
      ),
    )
    .toBe(true);
  await page.waitForTimeout(2600);
  await expect(page.locator('.terminal-status.info')).toContainText('signed out');

  // The killed cookie is the suite's shared one — drop the cache so the
  // next login() signs in fresh instead of replaying a dead token.
  sessionCookie = null;
});

test('log out everywhere ends every signed-in session', async ({ page, browser }) => {
  await login(page); // fresh sign-in (the previous test killed the cookie)

  // A second, independent login in its own context: another live token.
  const ctx2 = await browser.newContext();
  const page2 = await ctx2.newPage();
  await page2.goto('/login');
  await signIn(page2);
  await page2.waitForURL(u => u.pathname === '/');

  // /settings owns the button; clicking it clears every token.
  await page.goto('/settings');
  await page.click('wa-button#logout-all');
  await page.waitForURL(u => u.pathname === '/login');

  // Both tokens are rejected — the token this browser used and the second
  // context's independent one (in-page fetch: the cookie is Secure).
  // page2 races its own signed-out navigation, and that navigation can
  // abort the very fetch this poll issues: the TypeError is caught
  // INSIDE the page (Failed to fetch → 0, "not 401 yet") so expect.poll
  // retries instead of dying on the throw (it retries a bad value, not a
  // thrown callback — the churn probe's flake). An evaluate whose
  // execution context dies before the script runs still throws out
  // here and reads -1 — same retry. Either side of the navigation, a
  // dead token answers 401.
  const state = async (p: Page): Promise<number> => {
    try {
      return await p.evaluate(async () => {
        try {
          return (await fetch('/api/state')).status;
        } catch {
          return 0; // aborted by the racing navigation — retried, not failed
        }
      });
    } catch (e) {
      if (/destroyed/.test(String((e as Error).message))) return -1;
      throw e;
    }
  };
  await expect.poll(() => state(page)).toBe(401);
  await expect.poll(() => state(page2)).toBe(401);
  await ctx2.close();

  sessionCookie = null; // both tokens are dead
});

test('SIGTERM: every socket gets restart, closes, and the process exits 0', async ({ browser }) => {
  test.setTimeout(60_000); // boots its own server + browser session before the signal
  // The suite's webServer is managed by Playwright — spawn our own
  // short-lived server instead (suite env pattern from playwright.config,
  // own port + tmp dir so nothing collides with the shared instance).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cybermole-sigterm-'));
  const dbFile = path.join(dir, 'cybermole.db');
  expect(setCredential(new StateDb(dbFile), USERNAME, PASSWORD).ok).toBe(true);
  const port = 3481;
  // Per-run socket: a server left over from an interrupted run would
  // hold the derived t-<uuid> session name of a leftover row.
  const tmuxSocket = `cybermole-itest-sig-${process.pid}`;
  const child = spawn(process.execPath, ['dist-server/server/main.js'], {
    env: {
      ...process.env,
      CYBERMOLE_PORT: String(port),
      CYBERMOLE_HOST: '127.0.0.1',
      CYBERMOLE_DB_FILE: dbFile,
      CYBERMOLE_AGENT_DIR: path.join(dir, 'pi-agent'),
      CYBERMOLE_NEW_SESSION_CWD: dir,
      CYBERMOLE_TMUX_SOCKET: tmuxSocket,
      CYBERMOLE_COMMAND: '/bin/sh',
      // task/defaults-settings: the auto-opened first tab is deterministic
      // here too (sh — no dependency on the checkout's vendored pi).
      CYBERMOLE_AGENT_COMMAND: '/bin/sh',
    },
    stdio: 'ignore',
  });
  let ws: nodeWs.WebSocket | null = null;
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  try {
    // Boot: /login answers (any status) once the server is up.
    const up = Date.now() + 15_000;
    for (;;) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/login`);
        if (r.status === 200) break;
      } catch {
        /* not listening yet */
      }
      if (Date.now() > up) throw new Error('spawned server did not come up');
      await new Promise(r => setTimeout(r, 100));
    }

    // Login on the spawned server (its own limiter — the shared budget
    // is untouched) and open one authenticated socket.
    const login = await fetch(`http://127.0.0.1:${port}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
    });
    expect(login.status).toBe(200);
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
    // Origin is mandatory on WS upgrades (browser hardening): a raw Node
    // client must claim the same origin the server derives from Host.
    ws = new nodeWs.WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { Cookie: cookie, Origin: `http://127.0.0.1:${port}` },
    });
    const messages: string[] = [];
    ws.on('message', d => messages.push(String(d)));
    await new Promise<void>((resolve, reject) => {
      ws!.on('open', resolve);
      ws!.on('error', reject);
    });

    // And one real console page attached to a terminal tab: the client must
    // treat 'restart' as reconnectable (unlike 'exit'/'error') — it says
    // so and starts its backoff instead of going dark.
    await page.goto(`http://127.0.0.1:${port}/login`);
    await signIn(page);
    await page.waitForURL(u => u.pathname === '/');
    const wsMade = await page.evaluate(async () => {
      const w = await fetch('/api/workspaces', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'sig ws' }), // cwd derived: this server's CYBERMOLE_NEW_SESSION_CWD is dir
      });
      return (await w.json()) as { id: string };
    });
    await page.evaluate(() =>
      (
        document.querySelector('console-app') as unknown as { loadState(): Promise<void> }
      ).loadState(),
    );
    await page.click(`workspace-sidebar li[data-ws="${wsMade.id}"]`);
    await page.click('terminal-tabs .tab-new'); // creates + selects the terminal tab
    // the ACTIVE tab — the one just created; the workspace's first tab
    // (auto-opened, task/defaults-settings) is a different row
    const tabId = await page
      .locator('terminal-tabs .tabs-bar .tab.active')
      .getAttribute('data-term');
    expect(tabId).toBeTruthy();
    // two panes exist (the auto-opened agent tab's + this one) — scoped
    await expect(paneStatus(page, '.ok')).toContainText(`attached: t-${tabId}`, {
      timeout: 20_000,
    });

    // Listeners armed BEFORE the signal: if the drain ever completes fast
    // (no keep-alive straggler), 'exit'/'close' can fire before a
    // post-kill registration would attach, and the await would hang to
    // the test timeout.
    const exited = new Promise<number | null>(resolve => child.on('exit', code => resolve(code)));
    const closed = new Promise<void>(resolve => ws!.on('close', resolve));
    child.kill('SIGTERM');
    const killed = Date.now();
    await closed;
    // The restart notice arrived before the close, and was the last thing.
    expect(messages).toContain(JSON.stringify({ type: 'restart' }));
    expect(messages[messages.length - 1]).toBe(JSON.stringify({ type: 'restart' }));
    // The browser terminal announces the restart and reconnects (the
    // server is gone, so the backoff keeps retrying — that's the point).
    await expect(paneStatus(page)).toContainText('server restarting', {
      timeout: 5000,
    });
    await expect(paneStatus(page)).toContainText('reconnecting in', {
      timeout: 5000,
    });

    expect(await exited).toBe(0);
    expect(Date.now() - killed).toBeLessThan(7000); // ~5s drain deadline + slack
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    try {
      ws?.close();
    } catch {
      /* already gone */
    }
    await ctx.close();
    try {
      execFileSync('tmux', ['-L', tmuxSocket, 'kill-server'], { stdio: 'ignore' });
    } catch {
      /* no server was started — fine */
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('auto-update setting: default OFF, toggle persists across reload, status lines render', async ({
  page,
}) => {
  // Runs after the SIGTERM test and before the rate-limit test (last).
  // The e2e server must never actually run npm through the scheduler: the
  // first check is 1 min after the setting turns ON (FIRST_CHECK_DELAY_MS,
  // src/lib/auto-update.ts), and this test ends by toggling the setting
  // back OFF — which cancels even that — so the shared webServer finishes
  // with nothing armed.
  await login(page);
  // The dashboard arrives server-rendered: the config rows and the status
  // lines are in the HTML itself, not filled in by a script.
  const html = await page.evaluate(async () => (await fetch('/settings')).text());
  expect(html).toContain(`${WORKSPACE}/cybermole.db`);
  expect(html).toContain('not checked yet');
  await page.goto('/settings');

  // The switch upgraded client-side (SSR ≠ client imports — AGENTS.md).
  await page.waitForFunction(
    () =>
      typeof (
        document.querySelector('wa-switch#pi-auto-update') as unknown as { checked?: boolean }
      )?.checked === 'boolean',
  );
  const isChecked = (): Promise<boolean> =>
    page.evaluate(
      () =>
        (document.querySelector('wa-switch#pi-auto-update') as unknown as { checked: boolean })
          .checked,
    );
  const control = page.locator('wa-switch#pi-auto-update [part="control"]');

  // Fresh db (global-setup recreated the workspace): default OFF, both in
  // the UI and on the API, with the never-checked status lines rendered.
  expect(await isChecked()).toBe(false);
  await expect(page.locator('#auto-check-line')).toContainText('not checked yet');
  await expect(page.locator('#auto-update-line')).toContainText('no auto-update has run yet');
  expect((await api(page, 'GET', '/api/settings')).json.piAutoUpdate).toMatchObject({
    enabled: false,
  });

  // Toggle ON through the real control.
  await control.click();
  await expect
    .poll(async () => (await api(page, 'GET', '/api/settings')).json.piAutoUpdate.enabled)
    .toBe(true);
  const db = new DatabaseSync(`${WORKSPACE}/cybermole.db`);
  const setting = () =>
    (
      db.prepare("SELECT value FROM settings WHERE key = 'piAutoUpdate.enabled'").get() as {
        value: string;
      }
    ).value;
  expect(setting()).toBe('1');

  // Persisted across a reload: the switch renders ON from /api/settings.
  await page.reload();
  await page.waitForFunction(
    () =>
      (document.querySelector('wa-switch#pi-auto-update') as unknown as { checked?: boolean })
        ?.checked === true,
  );
  await expect(page.locator('#auto-check-line')).toContainText('not checked yet');

  // The API validates its (deliberately trivial) body.
  expect((await api(page, 'POST', '/api/auto-update-pi', { enabled: 'yes' })).status).toBe(400);
  expect((await api(page, 'POST', '/api/auto-update-pi', {})).status).toBe(400);

  // Toggle back OFF — clean state, nothing scheduled for the rest of
  // the suite.
  await control.click();
  await expect
    .poll(async () => (await api(page, 'GET', '/api/settings')).json.piAutoUpdate.enabled)
    .toBe(false);
  expect(setting()).toBe('0');
  db.close();
});

test('the editor stays absent when unconfigured (task/ws-editor)', async ({ page, request }) => {
  // This suite never sets CYBERMOLE_EDITOR_UPSTREAM, so the selected
  // workspace's tab bar renders no editor tab (the only editor
  // affordance now — the sidebar's ⌷ buttons died with the Live/past
  // lists), no editor iframe is ever built, /api/state reports editor:
  // false, and the same-origin proxy fails closed: /editor/ answers 404
  // signed in (the editor profile isn't deployed) and 401 unsigned in —
  // it is a data route, never a page, so no login shell either. The
  // cookieless leg uses Playwright's API client, which never sends the
  // Secure session cookie over this plain-http origin (AGENTS.md).
  await login(page);
  await expect(page.locator('terminal-tabs .editor-tab')).toHaveCount(0);
  await expect(page.locator('terminal-tabs .editor-frame')).toHaveCount(0);
  expect((await api(page, 'GET', '/api/state')).json.editor).toBe(false);

  expect((await page.goto('/editor/'))?.status()).toBe(404);
  expect(
    (await page.goto('/editor/stable-abc/out/vs/code/browser/workbench/workbench.js'))?.status(),
  ).toBe(404);

  expect((await request.get('/editor/')).status()).toBe(401);
});

test("deep link ?t=<uuid> opens the terminal's workspace with its tab selected; an unknown uuid degrades to a toast", async ({
  page,
}) => {
  // Runs before the rate-limit test (last). The shared webServer spawns
  // the suite's cmd.sh on the cybermole-itest socket; the terminal-mode WS
  // attach (plan §4/§7) is exercised through the real page wiring:
  // console-app's pendingTerminal → the workspace opens → the tab gets
  // its pane.
  await login(page);
  const cwd = `${WORKSPACE}/t-deep-link`;
  fs.mkdirSync(cwd, { recursive: true });
  // no cwd on the create (task/app-cwd): set the distinct dir through PATCH
  const wsMade = await api(page, 'POST', '/api/workspaces', { name: 'deep link' });
  expect(wsMade.status).toBe(200);
  const patched = await api(page, 'PATCH', `/api/workspaces/${wsMade.json.id}`, { cwd });
  expect(patched.status, JSON.stringify(patched.json)).toBe(200);
  const made = await api(page, 'POST', `/api/workspaces/${wsMade.json.id}/terminals`, {});
  expect(made.status).toBe(200);
  expect(made.json.live).toBe(true);
  const id = made.json.id as string;

  // The deep link opens the terminal's workspace with that tab selected:
  // sidebar row + tab both active, attached to the derived t-<uuid>
  // session, banner shown.
  await page.goto(`/?t=${id}`);
  await expect(page.locator(`workspace-sidebar li[data-ws="${wsMade.json.id}"]`)).toHaveClass(
    /active/,
  );
  await expect(page.locator(`terminal-tabs .tab[data-term="${id}"]`)).toHaveClass(/active/);
  await expect(page.locator('.terminal-status')).toContainText(`attached: t-${id}`);
  await waitForTermText(page, MARKER);

  // Graceful degradation: a well-formed uuid that is not ours is a toast,
  // the page stays up, the first fixture workspace re-selected, nothing
  // respawns. (The toast's text is read from the host's light OR shadow
  // DOM — wherever the component renders its items.)
  await page.goto('/?t=99999999-9999-4999-8999-999999999999');
  await page.waitForFunction(
    () => {
      const host = document.querySelector('wa-toast');
      if (!host) return false;
      const text = (host.textContent ?? '') + (host.shadowRoot?.textContent ?? '');
      return text.includes('no such terminal');
    },
    null,
    { timeout: 10_000 },
  );
  await expect(page.locator('workspace-sidebar li[data-ws].active')).toHaveCount(1);
  expect(tmuxStatus(['has-session', '-t', 't-99999999-9999-4999-8999-999999999999'])).not.toBe(0);

  // Cleanup: close the tab (row + best-effort session kill) and the
  // workspace, so later state reads are unchanged.
  expect((await api(page, 'DELETE', `/api/terminals/${id}`)).status).toBe(200);
  expect((await api(page, 'DELETE', `/api/workspaces/${wsMade.json.id}`)).status).toBe(200);
});

test('a terminal tab survives a WEB restart: tmux keeps the session, the client reconnects to it (plan §4/§12)', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  // The spawned-child pattern (jobs-persist precedent): the suite's shared
  // webServer is NEVER SIGTERMed — this spec boots its own server on a
  // spare port with its own db + tmux socket, so the shared login budget
  // and the shared socket are untouched (the private server's limiter is
  // its own; sign-in goes through its login form, in-page).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cybermole-restart-survive-'));
  const dbFile = path.join(dir, 'cybermole.db');
  expect(setCredential(new StateDb(dbFile), USERNAME, PASSWORD).ok).toBe(true);
  const cwd = path.join(dir, 'work');
  fs.mkdirSync(cwd, { recursive: true });
  const cmd = path.join(dir, 'cmd.sh');
  fs.writeFileSync(cmd, `#!/bin/sh\necho '${MARKER}'\nexec /bin/sh\n`);
  fs.chmodSync(cmd, 0o755);
  const port = 3482; // clear of the shared :3470 and the specs' 3471–3485
  const tmuxSocket = `cybermole-itest-survive-${process.pid}`;
  const env = {
    ...process.env,
    CYBERMOLE_PORT: String(port),
    CYBERMOLE_HOST: '127.0.0.1',
    CYBERMOLE_DB_FILE: dbFile,
    CYBERMOLE_AGENT_DIR: path.join(dir, 'pi-agent'),
    CYBERMOLE_NEW_SESSION_CWD: cwd,
    CYBERMOLE_TMUX_SOCKET: tmuxSocket,
    CYBERMOLE_COMMAND: cmd,
    // task/defaults-settings: the auto-opened first tab is deterministic
    // here too (the vendored-pi default would depend on this checkout's
    // node_modules — never on a test's environment).
    CYBERMOLE_AGENT_COMMAND: cmd,
  };
  const boot = (): ChildProcess =>
    spawn(process.execPath, ['dist-server/server/main.js'], {
      env,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  const stop = async (child: ChildProcess): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    await new Promise<void>(resolve => {
      child.once('exit', () => resolve());
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
    });
  };
  let child = boot();
  let bootLog = '';
  child.stderr!.setEncoding('utf8').on('data', (d: string) => {
    bootLog += d;
  });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  try {
    await expect
      .poll(
        async () => {
          try {
            return (await fetch(`http://127.0.0.1:${port}/login`)).status;
          } catch {
            return 0;
          }
        },
        { timeout: 20_000 },
      )
      .toBe(200);

    // Sign in through the private server's own form (its own budget).
    await page.goto(`http://127.0.0.1:${port}/login`);
    await signIn(page);
    await page.waitForURL(u => u.pathname === '/');

    // One workspace + terminal tab, attached through the real UI. No cwd on
    // the create (task/app-cwd): this server's CYBERMOLE_NEW_SESSION_CWD is the
    // same dir, so the derivation lands there.
    const wsMade = await api(page, 'POST', '/api/workspaces', { name: 'survive' });
    expect(wsMade.status, JSON.stringify(wsMade.json)).toBe(200);
    await refreshState(page);
    await page.click(`workspace-sidebar li[data-ws="${wsMade.json.id}"]`);
    await page.click('terminal-tabs .tab-new');
    // the ACTIVE tab — the one just created (+ selected). The workspace's
    // FIRST tab (auto-opened, task/defaults-settings) is a different row.
    const tabId = await page
      .locator('terminal-tabs .tabs-bar .tab.active')
      .getAttribute('data-term');
    expect(tabId).toBeTruthy();
    await waitForTermText(page, MARKER, 20_000);
    // two panes exist (the auto-opened agent tab's + this one) — scoped
    await expect(paneStatus(page, '.ok')).toContainText(`attached: t-${tabId}`);
    await page.locator('agent-terminal:not(.hidden) .terminal-container').click();
    await page.keyboard.type('echo SURVIVES_$((40+2))\n');
    await waitForTermText(page, 'SURVIVES_42', 10_000);

    // The WEB restart (the common case, plan §4): the server SIGTERMs
    // itself gracefully (restart frames), tmux keeps the session, and a
    // fresh process on the same db + socket serves the reconnect. Before
    // the kill, install a page-side recorder of every .terminal-status
    // text: the transient "reconnecting …" flash can come and go faster
    // than Playwright can sample it (a fast-booting reboot server answers
    // /login after the client's 1s-min backoff has already reconnected —
    // deterministic under gVisor), so the proof of the said-reconnecting →
    // reconnected path reads the recorded history, not a live poll.
    await page.evaluate(() => {
      const seen: string[] = [];
      (window as unknown as { __statusSeen?: string[] }).__statusSeen = seen;
      const record = (): void => {
        document.querySelectorAll('.terminal-status').forEach(el => {
          const text = (el.textContent ?? '').trim();
          if (text && seen[seen.length - 1] !== text) seen.push(text);
        });
      };
      record();
      new MutationObserver(record).observe(document.body, {
        subtree: true,
        childList: true,
        characterData: true,
      });
    });
    await stop(child);
    child = boot();
    child.stderr!.setEncoding('utf8').on('data', (d: string) => {
      bootLog += d;
    });
    await expect
      .poll(
        async () => {
          try {
            return (await fetch(`http://127.0.0.1:${port}/login`)).status;
          } catch {
            return 0;
          }
        },
        { timeout: 20_000 },
      )
      .toBe(200);

    // The client said "restarting" and reconnected on its backoff — same
    // tab, same session (no respawn: a respawn would be a fresh shell).
    // The recorder above caught the transient reconnect status race-free;
    // the attached/survival assertions below carry the real proof.
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => (window as unknown as { __statusSeen?: string[] }).__statusSeen ?? []))
            .join(' | ')
            .includes('reconnect'),
        { timeout: 15_000 },
      )
      .toBe(true);
    await expect(paneStatus(page, '.ok')).toContainText(`attached: t-${tabId}`, {
      timeout: 30_000,
    });
    await waitForTermText(page, 'SURVIVES_42', 10_000); // the screen survived: tmux redraws it

    // The tab is still live in the fresh server's state (tmux-derived) and
    // the terminal is still usable.
    const state = await api(page, 'GET', '/api/state');
    const row = state.json.workspaces.find((w: { id: string }) => w.id === wsMade.json.id);
    expect(row.terminals.find((t: { id: string }) => t.id === tabId).live).toBe(true);
    await page.locator('agent-terminal:not(.hidden) .terminal-container').click();
    await page.keyboard.type('echo AFTER_$((40+2))\n');
    await waitForTermText(page, 'AFTER_42', 10_000);

    // And the empty state on a workspace-less db (the fixture tree isn't
    // here to get in the way): delete the workspace, the selection falls
    // back to the no-workspace prompt.
    expect((await api(page, 'DELETE', `/api/workspaces/${wsMade.json.id}`)).status).toBe(200);
    await refreshState(page);
    await expect(page.locator('.tabs-empty p')).toContainText('no workspace selected');
    await expect(page.locator('.tabs-empty .empty-new-workspace')).toBeVisible();
  } finally {
    await stop(child);
    await ctx.close();
    try {
      execFileSync('tmux', ['-L', tmuxSocket, 'kill-server'], { stdio: 'ignore' });
    } catch {
      /* gone */
    }
    fs.rmSync(dir, { recursive: true, force: true });
    if (bootLog && !/ExperimentalWarning/.test(bootLog))
      console.log(`restart-survive stderr:\n${bootLog}`);
  }
});

test('login rate limit kicks in (10 per 15 min per IP) and ignores a spoofed X-Forwarded-For', async ({
  request,
}) => {
  // Runs last: earlier tests already spent part of the shared budget.
  // Every attempt claims a different client IP. The server runs with
  // CYBERMOLE_TRUST_PROXY unset (0), so the header must be ignored and every
  // attempt counted against the real peer — regression: the leftmost XFF
  // entry was trusted, so rotating it never hit 429.
  let saw429 = false;
  for (let i = 0; i < 15 && !saw429; i++) {
    const r = await request.post('/login', {
      data: { username: USERNAME, password: 'nope' },
      headers: { 'X-Forwarded-For': `203.0.113.${i + 1}` },
    });
    if (r.status() === 429) saw429 = true;
  }
  expect(saw429).toBe(true);
});
