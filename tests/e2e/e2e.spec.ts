// Integration tests against the real built app: SSR pages, client-side wa-*
// upgrades, auth, the fixture workspace tree, and the terminal round trip
// (xterm → WS → node-pty → tmux). Serial; see playwright.config.ts.
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
// Namespace import: a named `WebSocket` import would shadow the global in
// in-page evaluate closures after esbuild's CJS transform.
import * as nodeWs from 'ws';
import { expect, test, type Cookie, type Locator, type Page } from '@playwright/test';
import { WebSocket as NodeWebSocket } from 'ws';
import { setCredential } from '../../src/lib/platform/auth';
import { StateDb } from '../../src/lib/platform/db';
import {
  AGENT_MARKER,
  MARKER,
  PASSWORD,
  S3_BUCKET,
  S3_PORT,
  TMUX_SOCKET,
  USERNAME,
  WORKSPACE,
} from '../support/env';
import { UPLOAD_MAX_BODY_BYTES } from '../../src/schemas/uploads';

/** The page never scrolls, and the rendered rows fill .terminal-container
 *  to within one cell row (the terminal tracks the available space). */
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

/** Checks the buffer, not the DOM: the WebGL renderer draws to a canvas. */
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

/** The first call signs in through the form; later calls reuse the cookie,
 *  since every POST /login spends the per-IP budget the last test exhausts. */
let sessionCookie: Cookie | null = null;
async function login(page: Page): Promise<void> {
  if (sessionCookie) {
    await page.context().addCookies([sessionCookie]);
    await page.goto('/');
  } else {
    await page.goto('/login');
    await signIn(page);
    await page.waitForURL(u => u.pathname === '/');
    sessionCookie =
      (await page.context().cookies()).find(c => c.name === 'cybermole_session') ?? null;
  }
  await page.waitForSelector('workspace-sidebar .nav');
}

/** 0 = ok, nonzero = refused. */
function tmuxStatus(args: string[]): number {
  return spawnSync('tmux', ['-L', TMUX_SOCKET, ...args], { stdio: 'ignore' }).status ?? 1;
}

/** In-page fetch: Playwright's API client won't send the Secure cookie over
 *  plain http. A cwd is set via PATCH, since the create derives it. */
async function makeWorkspace(page: Page, name: string, cwd?: string): Promise<string> {
  const made = await api(page, 'POST', '/api/workspaces', { name });
  expect(made.status, JSON.stringify(made.json)).toBe(200);
  if (cwd !== undefined) {
    const patched = await api(page, 'PATCH', `/api/workspaces/${made.json.id}`, { cwd });
    expect(patched.status, JSON.stringify(patched.json)).toBe(200);
  }
  await refreshState(page);
  // select via the sidebar so its tab bar renders
  await page.click(`workspace-sidebar li[data-ws="${made.json.id}"]`);
  return made.json.id as string;
}

async function makeTerminalIn(page: Page, ws: string): Promise<string> {
  const term = await api(page, 'POST', `/api/workspaces/${ws}/terminals`, {});
  expect(term.status, JSON.stringify(term.json)).toBe(200);
  await refreshState(page);
  return term.json.id as string;
}

/** Closes the workspace's auto-opened agent tab first: these tests assume a
 *  one-tab world. The pane is created by clicking the tab. */
async function makeTerminal(
  page: Page,
  name: string,
  cwd?: string,
): Promise<{ ws: string; id: string }> {
  const ws = await makeWorkspace(page, name, cwd);
  const auto = await page.locator('terminal-tabs .tabs-bar .tab').first().getAttribute('data-term');
  expect(auto, 'the workspace auto-opened its first tab').toBeTruthy();
  const closed = await api(page, 'DELETE', `/api/terminals/${auto}`);
  expect(closed.status, JSON.stringify(closed.json)).toBe(200);
  await refreshState(page);
  return { ws, id: await makeTerminalIn(page, ws) };
}

/** Scoped to the visible pane: the auto-opened tab's hidden pane would make
 *  an unscoped locator match two. `state` is a modifier class ('.ok', …). */
const paneStatus = (page: Page, state = ''): Locator =>
  page.locator(`agent-terminal:not(.hidden) .terminal-status${state}`);

/** Forces the 15 s poll; raw in-page POSTs don't trigger it. */
async function refreshState(page: Page): Promise<void> {
  await page.evaluate(() =>
    (
      document.querySelector('console-app') as unknown as { loadState(): Promise<void> }
    ).loadState(),
  );
}

test('unauthenticated / serves the login page with upgraded wa-* controls', async ({ page }) => {
  await page.goto('/');
  // No redirect: the server renders login in place.
  expect(page.url()).toMatch(/\/$/);
  await expect(page.locator('wa-input#username input')).toHaveCount(1);
  await expect(page.locator('wa-input#password input[type=password]')).toHaveCount(1);
  await expect(page.locator('wa-button:has-text("sign in")')).toHaveCount(1);
  // The layout's SSR'd <wa-toast> must upgrade too: create() only exists after it defines.
  await page.waitForFunction(() => {
    const t = document.querySelector('wa-toast');
    return !!t && typeof (t as HTMLElement & { create?: unknown }).create === 'function';
  });
  // The password toggle's system-library icon must render from the vendored
  // library under the CSP.
  await expect(page.locator('wa-input#password wa-icon svg')).toHaveCount(1);
});

test('API routes stay guarded without a session', async ({ request }) => {
  expect((await request.get('/api/state')).status()).toBe(401);
  expect((await request.get('/api/jobs')).status()).toBe(401);
  expect(
    (await request.get('/api/files/uploads/00000000-0000-4000-8000-000000000000')).status(),
  ).toBe(401);
  expect((await request.get('/api/nope')).status()).toBe(401);
  // Partials are data routes too: an element would swap login HTML into its list.
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
  // Client-side validation: no request, so no login budget spent.
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
  // The message is in the hint slot, which describes the real (shadow) input.
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
  // Fixing a field clears its message on focus-out.
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

  // The first workspace (scratch) auto-selects, and its first tab is the
  // live fixture, so a terminal is on screen at once.
  await expect(page.locator('agent-terminal:not(.hidden) .terminal-container .xterm')).toHaveCount(
    1,
  );

  // WebGL loads on first activation and swaps DOM rows for canvases
  // (SwiftShader in headless Chromium).
  await page.waitForFunction(
    () =>
      document.querySelectorAll('agent-terminal:not(.hidden) .terminal-container canvas').length >
      0,
    null,
    { timeout: 10_000 },
  );

  // The console page teaches orchestration only: the Console group (app_id
  // NULL), no app groups, no + app (that moved to /builder — the split).
  const nav = page.locator('workspace-sidebar .nav');
  const groups = nav.locator('.ws-group');
  await expect(groups).toHaveCount(1);
  await expect(groups.first().locator('h2 .g-name')).toHaveText('console');
  await expect(groups.first().locator('li[data-ws]')).toHaveCount(2);
  await expect(groups.first()).toContainText('scratch');
  await expect(groups.first()).toContainText('deploy checklist');
  await expect(page.locator('workspace-sidebar #new-app')).toHaveCount(0);
  // One live-terminal badge per row (scratch's second tab is the dead fixture).
  await expect(groups.first().locator('li[data-ws] wa-badge')).toHaveCount(2);
  await expect(groups.first().locator('li[data-ws].active')).toHaveCount(1);

  // scratch's two tabs; no editor tab (unconfigured here).
  const tabs = page.locator('terminal-tabs .tabs-bar');
  await expect(tabs.locator('.tab')).toHaveCount(2);
  await expect(tabs.locator('.tab').first()).toHaveClass(/active/);
  await expect(tabs.locator('.tab').first().locator('.tab-dot')).toHaveClass(/live/);
  await expect(tabs.locator('.tab').nth(1).locator('.tab-dot')).not.toHaveClass(/live/);
  await expect(tabs.locator('.editor-tab')).toHaveCount(0);
  await expect(tabs.locator('.tab-new')).toHaveCount(1);
});

test('a new workspace auto-opens its first terminal running the AGENT command; other tabs run the shell', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await login(page);
  const ws = await makeWorkspace(page, 'agent slot ws');
  // The first tab exists without the + button, is live, and runs the agent command.
  await expect(page.locator('terminal-tabs .tabs-bar .tab')).toHaveCount(1);
  const id = await page.locator('terminal-tabs .tabs-bar .tab').getAttribute('data-term');
  await expect(page.locator(`terminal-tabs .tab[data-term="${id}"] .tab-dot`)).toHaveClass(/live/, {
    timeout: 10_000,
  });
  await waitForTermText(page, AGENT_MARKER, 20_000);
  await expect(page.locator('.terminal-status.ok')).toContainText(`attached: t-${id}`);
  expect(tmuxStatus(['has-session', '-t', `t-${id}`])).toBe(0);

  // A + tab runs the shell command: the settings are independent.
  const second = await makeTerminalIn(page, ws);
  await page.click(`terminal-tabs .tab[data-term="${second}"]`);
  await waitForTermText(page, MARKER, 20_000);
  expect(tmuxStatus(['has-session', '-t', `t-${second}`])).toBe(0);

  // A respawn of the agent tab must re-run the agent command. After an
  // out-of-band kill the hidden pane goes 'detached'; clicking the tab
  // replaces the ended pane with a fresh one, whose empty buffer makes the
  // banner check decisive.
  execFileSync('tmux', ['-L', TMUX_SOCKET, 'kill-session', '-t', `t-${id}`]);
  await expect(
    page.locator('agent-terminal.hidden .terminal-status', { hasText: `t-${id}` }),
  ).toContainText('detached', { timeout: 10_000 });
  await page.click(`terminal-tabs .tab[data-term="${id}"]`);
  await waitForTermText(page, AGENT_MARKER, 20_000);
  expect(tmuxStatus(['has-session', '-t', `t-${id}`])).toBe(0);

  expect((await api(page, 'DELETE', `/api/workspaces/${ws}`)).status).toBe(200);
  await expect
    .poll(() => tmuxStatus(['has-session', '-t', `t-${id}`]), { timeout: 10_000 })
    .not.toBe(0);
});

test('a paste bigger than one WebSocket frame reaches the session whole', async ({ page }) => {
  test.setTimeout(60_000);
  // Over the server's 1 MiB maxPayload: arrives only if the client chunks it.
  const size = 1_200_000;
  const out = `${WORKSPACE}/paste.out`;
  await login(page);
  const { id } = await makeTerminal(page, 'paste ws');
  await page.click(`terminal-tabs .tab[data-term="${id}"]`);
  await waitForTermText(page, MARKER, 20_000);

  // Raw mode, no echo, so head sees every byte (a canonical-mode line caps at 4 KiB).
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

  // Drop the socket like a proxy idle cut: no 'exit' from the server first.
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

  // The session ending arrives as 'exit': reported, never reconnected
  // (that would loop two tabs bumping each other).
  execFileSync('tmux', ['-L', TMUX_SOCKET, 'kill-session', '-t', `t-${id}`]);
  await expect(page.locator('.terminal-status.info')).toContainText(`detached: t-${id}`);
  await page.waitForTimeout(2500); // longer than the first reconnect backoff
  await expect(page.locator('.terminal-status.info')).toContainText(`detached: t-${id}`);
});

test('malformed requests and frames are rejected without taking the server down', async ({
  page,
}) => {
  await login(page);
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

  // A bad %-escape is a 400, not a crash.
  expect(await status('DELETE', '/api/jobs/%E0')).toBe(400);
  expect(await status('POST', '/api/jobs/%E0/run')).toBe(400);
  // JSON bodies must be objects.
  expect(await status('POST', '/api/apps', '[]')).toBe(400);
  expect(await status('POST', '/api/workspaces', '"just a string"')).toBe(400);
  // Bodies over 10 KiB are refused from Content-Length before Astro reads them.
  expect(await status('POST', '/api/apps', JSON.stringify({ name: 'x'.repeat(20_000) }))).toBe(413);
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

  // Junk frames, before and after attaching, are dropped and the socket
  // lives on. The removed live/resume modes count as junk.
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
  // A cwd distinct from the default proves the respawn uses the row's cwd.
  const cwd = `${WORKSPACE}/dead-tab-cwd`;
  fs.mkdirSync(cwd, { recursive: true });
  const { id } = await makeTerminal(page, 'dead tab ws', cwd);
  await page.click(`terminal-tabs .tab[data-term="${id}"]`);
  await waitForTermText(page, MARKER, 20_000);
  await expect(page.locator('.terminal-status.ok')).toContainText(`attached: t-${id}`);

  // Out-of-band kill: the row survives, the session is gone.
  execFileSync('tmux', ['-L', TMUX_SOCKET, 'kill-session', '-t', `t-${id}`]);
  await expect(page.locator('.terminal-status.info')).toContainText(`detached: t-${id}`);

  // The (forced) poll flips the tab's dot.
  await page.evaluate(() =>
    (
      document.querySelector('console-app') as unknown as { loadState(): Promise<void> }
    ).loadState(),
  );
  await expect(page.locator(`terminal-tabs .tab[data-term="${id}"] .tab-dot`)).not.toHaveClass(
    /live/,
  );

  // Clicking the ended tab is a fresh attach, which respawns the session.
  await page.click(`terminal-tabs .tab[data-term="${id}"]`);
  await expect(page.locator('.terminal-status.ok')).toContainText(`attached: t-${id}`, {
    timeout: 20_000,
  });
  await waitForTermText(page, MARKER, 20_000);

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
        // All 'a' (0x61), so stored and downloaded bodies are checkable.
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
  // It reached the fake S3 with body and headers intact...
  const stored = (await (
    await fetch(`http://127.0.0.1:${S3_PORT}/__fake/objects/${S3_BUCKET}/${ok.body.key}`)
  ).json()) as { body: string; contentType: string; contentDisposition: string };
  expect(Buffer.from(stored.body, 'base64').toString()).toBe('a'.repeat(12));
  expect(stored.contentType).toBe('text/plain');
  expect(stored.contentDisposition).toBe(
    "attachment; filename*=UTF-8''q1%20notes%20%28draft%29.txt",
  );
  // ...and downloads as a sandboxed attachment.
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

  // Past one 5 MiB part: multipart, streamed both ways.
  const big = await upload(12 * 1024 * 1024 + 7, 'image/png', 'big.png');
  expect(big.status).toBe(201);
  expect(big.body.size).toBe(12 * 1024 * 1024 + 7);
  expect(await download(`/api/files/${big.body.key}`)).toMatchObject({
    status: 200,
    size: 12 * 1024 * 1024 + 7,
    allA: true,
  });

  // Resume like a download manager: HEAD for the ETag, a first part, then
  // the rest with If-Range. Patterned bytes so a wrong offset can't pass.
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

  // Only uploads/<uuid> keys are served: unknown is 404, anything else 400.
  expect((await download('/api/files/uploads/00000000-0000-4000-8000-000000000000')).status).toBe(
    404,
  );
  expect((await download('/api/files/etc/passwd')).status).toBe(400);
  expect((await download('/api/files/uploads/..%2F..%2Fsecret')).status).toBe(400);

  // A rejected type answers before storage, and the server drains the body
  // so the browser gets the answer rather than a reset.
  expect(await upload(20 * 1024 * 1024, 'text/html', 'x.html')).toMatchObject({
    status: 400,
    body: { code: 'unsupported_file_type' },
  });
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

  // Raw requests from Node, for what a browser won't send.
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
  // Over the whole-body cap: refused on Content-Length alone.
  expect(
    await raw('/api/files', {
      'Content-Type': 'multipart/form-data; boundary=x',
      'Content-Length': String(UPLOAD_MAX_BODY_BYTES + 1),
    }),
  ).toBe(413);
  // Chunked bodies are refused off the upload route (the 10 KiB cap needs a length).
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

  // {attach} and {resize} arrive back-to-back; the server must carry the
  // size across its async tmux lookup and spawn the pty at it.
  const { id } = await makeTerminal(page, 'openfit ws');
  await page.click(`terminal-tabs .tab[data-term="${id}"]`);
  await expect(page.locator('.terminal-status.ok')).toContainText(`attached: t-${id}`, {
    timeout: 20_000,
  });
  await waitForTerminalFitted(page);

  const dims = await termDims(page);
  expect(dims.cols).toBeGreaterThan(100);

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
  // tmux's status line takes one row.
  expect(h).toBeGreaterThanOrEqual(dims.rows - 1);
});

test('terminal fills the available space and refits when it shrinks', async ({ page }) => {
  await login(page);

  // Attach first so the status bar is final before measuring.
  const { id } = await makeTerminal(page, 'fill ws');
  await page.click(`terminal-tabs .tab[data-term="${id}"]`);
  await expect(page.locator('.terminal-status.ok')).toContainText(`attached: t-${id}`, {
    timeout: 20_000,
  });

  await waitForTerminalFitted(page);
  const rowsBefore = await termRows(page);

  // A smaller viewport must shrink the box and refit to fewer rows.
  await page.setViewportSize({ width: 1280, height: 500 });
  await waitForTerminalFitted(page);
  expect(await termRows(page)).toBeLessThan(rowsBefore);
});

test('hidden tabs keep their WS attached: state and scrollback persist, refit on re-show', async ({
  page,
}) => {
  await login(page);
  // A hidden tab keeps its socket; re-showing refits and re-sends the size,
  // and its screen and scrollback survive.
  const ws = await makeWorkspace(page, 'hidden tabs ws');
  const first = await makeTerminalIn(page, ws);
  const second = await makeTerminalIn(page, ws);
  await page.click(`terminal-tabs .tab[data-term="${first}"]`);
  await waitForTermText(page, MARKER, 20_000);
  await page.locator('agent-terminal:not(.hidden) .terminal-container').click();
  await page.keyboard.type('echo FIRST_$((40+2))\n');
  await waitForTermText(page, 'FIRST_42', 10_000);
  // a pane exists only once its tab has been activated
  await page.click(`terminal-tabs .tab[data-term="${second}"]`);
  await waitForTermText(page, MARKER, 20_000);
  await page.locator('agent-terminal:not(.hidden) .terminal-container').click();
  await page.keyboard.type('echo SECOND_$((40+2))\n');
  await waitForTermText(page, 'SECOND_42', 10_000);

  // The first pane still holds its output: hiding never closed the socket.
  await page.click(`terminal-tabs .tab[data-term="${first}"]`);
  await waitForTermText(page, 'FIRST_42', 10_000);
  await page.locator('agent-terminal:not(.hidden) .terminal-container').click();
  await page.keyboard.type('echo AGAIN_$((40+2))\n');
  await waitForTermText(page, 'AGAIN_42', 10_000);

  // Hidden panes stay in the DOM with their sockets open.
  const sockets = await page.evaluate(() => {
    const panes = [...document.querySelectorAll('agent-terminal')] as unknown as Array<{
      websocket?: WebSocket;
    }>;
    return panes.map(p => (p.websocket === undefined ? 'closed' : `${p.websocket!.readyState}`));
  });
  expect(sockets).toEqual(['1', '1', '1']); // the auto-opened tab + the two made ones
});

test('terminal toolbar: copy output and download transcript capture the terminal buffer', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await login(page);
  const { id } = await makeTerminal(page, 'transcript ws');
  await page.click(`terminal-tabs .tab[data-term="${id}"]`);
  await waitForTermText(page, MARKER, 20_000);

  // More than a screen of output. While attached, tmux holds the client in
  // its alternate screen, so the client buffer is the visible screen; the
  // walk's scrollback half is tested against a stub below.
  await page.locator('agent-terminal:not(.hidden) .terminal-container').click();
  await page.keyboard.type('seq 1 120; echo TAIL_$((40+2))\n');
  await waitForTermText(page, 'TAIL_42', 10_000);

  const toolbar = page.locator('agent-terminal:not(.hidden) .terminal-toolbar');
  await expect(toolbar).toBeVisible();
  const copyBtn = toolbar.locator('wa-button.tb-copy-output');
  const dlBtn = toolbar.locator('wa-button.tb-download-transcript');
  await expect(copyBtn).toHaveCount(1);
  await expect(dlBtn).toHaveCount(1);
  expect(await copyBtn.getAttribute('title')).toContain('copy');
  expect(await dlBtn.getAttribute('title')).toContain('download');

  // The walk behind both buttons: the screen's content, trailing blank rows trimmed.
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

  // The scrollback + trim half, against a stub buffer with 3000 rows: a
  // scrolled-off head, content, then blank never-written rows.
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
  expect(stubbed.endsWith('\n')).toBe(false);

  // Copy goes to the real clipboard, identical to the walk.
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await copyBtn.click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(walked);
  await expect(
    page.locator('wa-toast wa-toast-item', { hasText: 'copied the terminal output' }),
  ).toBeVisible();

  // The download is named after the session and ANSI-serialized.
  const [download] = await Promise.all([page.waitForEvent('download'), dlBtn.click()]);
  expect(download.suggestedFilename()).toBe(`t-${id}-transcript.ans`);
  const saved = await download.path();
  const ans = fs.readFileSync(saved!, 'utf8');
  expect(ans).toContain('TAIL_42');
  expect(ans).toContain('120');
  expect(ans).toContain('\u001b[');
  await download.cancel();
});

// Jobs: the scheduler is in-process, so the suite runs the real thing. Runs
// land on the suite's tmux socket. Persistence and catch-up tests boot a
// second server against a copy of the state db (restarting the shared one
// would take the login cookie with it).

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
        headers: { 'Content-Type': 'application/json' },
        ...(b === undefined ? {} : { body: JSON.stringify(b) }),
      });
      return { status: r.status, json: await r.json().catch(() => null) };
    },
    [method, url, body] as const,
  );
}

// Pop-out moves the pane to a /?t=<id> tab. The server attaches with
// `tmux attach -d`, so the main page's socket must close first. The row
// stays (marked popped); the terminal returns when the popped tab closes or
// the row is clicked (which bumps the popped tab).
test("popping a tab moves the pane to a new tab: main socket down, popped tab attached, row survives; the tab click and the popped tab's close both bring it back", async ({
  page,
}) => {
  await login(page);
  const { ws, id } = await makeTerminal(page, 'pop ws');
  await makeTerminalIn(page, ws); // a second tab, never activated
  await page.click(`terminal-tabs .tab[data-term="${id}"]`);
  await waitForTermText(page, MARKER, 20_000);
  await expect(page.locator('.terminal-status.ok')).toContainText(`attached: t-${id}`);
  // Only the active pane has a toolbar (an unactivated tab has no pane).
  const popBtn = page.locator(
    'terminal-tabs agent-terminal:not(.hidden) .terminal-toolbar .tb-pop-out',
  );
  await expect(popBtn).toBeVisible();
  await expect(page.locator('terminal-tabs .tb-pop-out')).toHaveCount(1);

  const [popout] = await Promise.all([page.waitForEvent('popup'), popBtn.click()]);
  await popout.waitForSelector('workspace-sidebar .nav');
  await expect(popout.locator(`terminal-tabs .tab[data-term="${id}"]`)).toHaveClass(/active/);
  await expect(popout.locator('.terminal-status.ok')).toContainText(`attached: t-${id}`);
  await waitForTermText(popout, MARKER, 20_000);

  // The main page keeps the row (active, popped) with a notice; its pane is
  // gone but the session the popped tab owns is alive.
  await expect(page.locator(`terminal-tabs .tab[data-term="${id}"]`)).toHaveClass(/popped/);
  await expect(page.locator(`terminal-tabs .tab[data-term="${id}"]`)).toHaveClass(/active/);
  await expect(page.locator('.tabs-popped')).toBeVisible();
  await expect(page.locator('terminal-tabs .tabs-bar .tab')).toHaveCount(2);
  await expect(page.locator('terminal-tabs agent-terminal')).toHaveCount(0);
  expect(tmuxStatus(['has-session', '-t', `t-${id}`])).toBe(0);

  await popout.locator('agent-terminal:not(.hidden) .terminal-container').click();
  await popout.keyboard.type('echo POP_$((40+2))\n');
  await waitForTermText(popout, 'POP_42', 10_000);

  // Bring back by click: re-attaches here and bumps the popped tab once.
  await page.click(`terminal-tabs .tab[data-term="${id}"]`);
  await expect(page.locator('.terminal-status.ok')).toContainText(`attached: t-${id}`);
  await expect(page.locator(`terminal-tabs .tab[data-term="${id}"]`)).not.toHaveClass(/popped/);
  await expect(page.locator('.tabs-popped')).toHaveCount(0);
  await expect(popout.locator('.terminal-status.info')).toContainText(`detached: t-${id}`);
  await page.locator('agent-terminal:not(.hidden) .terminal-container').click();
  await page.keyboard.type('echo BACK_$((40+2))\n');
  await waitForTermText(page, 'BACK_42', 10_000);
  await popout.close(); // its pagehide is a no-op now

  // Pop again and close the popped tab: its pagehide re-attaches here unprompted.
  const [popout2] = await Promise.all([page.waitForEvent('popup'), popBtn.click()]);
  await popout2.waitForSelector('workspace-sidebar .nav');
  await expect(popout2.locator('.terminal-status.ok')).toContainText(`attached: t-${id}`);
  await expect(page.locator('terminal-tabs agent-terminal')).toHaveCount(0);
  await popout2.close();
  await expect(page.locator('.terminal-status.ok')).toContainText(`attached: t-${id}`, {
    timeout: 10_000,
  });
  await expect(page.locator(`terminal-tabs .tab[data-term="${id}"]`)).not.toHaveClass(/popped/);
  await page.locator('agent-terminal:not(.hidden) .terminal-container').click();
  await page.keyboard.type('echo AGAIN_$((40+2))\n');
  await waitForTermText(page, 'AGAIN_42', 10_000);

  expect((await api(page, 'DELETE', `/api/terminals/${id}`)).status).toBe(200);
  expect((await api(page, 'DELETE', `/api/workspaces/${ws}`)).status).toBe(200);
});

test('scrollback backfill: a reload restores history once — and ctrl+F finds it', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await login(page);
  const { id } = await makeTerminal(page, 'backfill ws');
  await page.click(`terminal-tabs .tab[data-term="${id}"]`);
  await waitForTermText(page, MARKER, 20_000);

  // More than a screen of history, with a unique anchor (BF_TOP_1 prefixes
  // BF_TOP_10..19, so it can't be counted).
  await page.locator('agent-terminal:not(.hidden) .terminal-container').click();
  await page.keyboard.type(
    'echo BF_ANCHOR_$((40+2)); for i in $(seq 1 80); do echo BF_TOP_$i; done; echo BF_DONE_$((40+2))\n',
  );
  await waitForTermText(page, 'BF_DONE_42', 10_000);

  // Reload via the deep link (plain / would select another workspace). The
  // backfill must restore the history exactly once; the attach redraw only
  // repaints the screen.
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

  // Ctrl+F opens the terminal's find bar, and a match scrolls into view.
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

  // 5-field cron only; other syntaxes fail with the first error.
  const good = await api(page, 'POST', '/api/jobs/validate', { schedule: '*/5 * * * *' });
  expect(good.status).toBe(200);
  expect(good.json).toMatchObject({ valid: true, validatedBy: 'cron-parser' });
  expect(typeof good.json.next).toBe('string');
  for (const bad of ['daily 08:00', '99 * * * *', '*/5 * * *']) {
    const r = await api(page, 'POST', '/api/jobs/validate', { schedule: bad });
    expect(r.json.valid, bad).toBe(false);
    expect(typeof r.json.error).toBe('string');
  }

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

  // The job card is in the server-rendered HTML itself.
  const html = await page.evaluate(async () => (await fetch('/jobs')).text());
  expect(html).toContain('itest-job');
  await page.goto('/jobs');
  await expect(page.locator('jobs-app .job')).toHaveCount(1);
  await expect(page.locator('jobs-app .job-name')).toContainText('itest-job');
  await expect(page.locator('jobs-app .job-meta')).toContainText('*/5 * * * *');

  const run = await api(page, 'POST', '/api/jobs/itest-job/run');
  expect(run.json).toMatchObject({ name: 'itest-job', session: 'cybermole-itest-job' });
  const live = () => {
    try {
      return execFileSync('tmux', ['-L', TMUX_SOCKET, 'list-sessions', '-F', '#{session_name}'], {
        encoding: 'utf8',
      });
    } catch {
      return '';
    }
  };
  await expect.poll(live, { timeout: 10_000 }).toContain('cybermole-itest-job');

  const listed = await api(page, 'GET', '/api/jobs');
  const job = listed.json.jobs.find((j: { name: string }) => j.name === 'itest-job');
  expect(job).toMatchObject({ running: true, session: 'cybermole-itest-job' });
  expect(job.last).toBeTruthy();
  await page.reload();
  await expect(page.locator('jobs-app .job wa-badge:has-text("running")')).toHaveCount(1);

  // A second run while the previous one is live is refused (409).
  expect((await api(page, 'POST', '/api/jobs/itest-job/run')).status).toBe(409);

  // Delete leaves the live run's session alone.
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
  // The schema's length cap reaches the real input as maxlength.
  await expect(page.locator('wa-input#job-name input')).toHaveAttribute('maxlength', '40');
  await page.click('#job-save');
  await expect(page.locator('#job-name-error')).toHaveText('name is required');
  await expect(page.locator('#job-schedule-error')).toHaveText('schedule is required');
  await expect(page.locator('#job-command-error')).toHaveText('command is required');
  expect(saves).toEqual([]);
  // The schema normalizes the name.
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
  // The card arrived via the partial swap: hydrated once, buttons delegated.
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

  // A db copy with the job's last fire backdated 3 minutes. The job exists
  // only in the copy, so the shared webServer can't fire it and the
  // catch-up run is the restarted server's alone.
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

  // A second server on its own port, sharing the tmux socket and command.
  const PORT2 = 3471;
  const child = spawn('node', ['dist-server/server/main.js'], {
    env: {
      ...process.env,
      CYBERMOLE_PORT: String(PORT2),
      CYBERMOLE_APPS_SOCK: '',
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
    // The job survived the restart.
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

    // The first tick (≤30 s after boot) fires one catch-up run.
    await expect.poll(sessions, { timeout: 45_000 }).toContain('cybermole-itest-persist');

    // ...recorded as catchup, newer than the backdated row.
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

test('jobs: app tag chip, persisted run logs, run history + log view', async ({ page }) => {
  test.setTimeout(150_000);
  await login(page);

  // The tag is display-only.
  const app = await api(page, 'POST', '/api/apps', { name: 'E2E Jobs App' });
  expect(app.status).toBe(200);
  const appId = app.json.id as string;

  // Guards before anything ran: a bad name is 400, an unknown job 404.
  expect(await api(page, 'GET', '/api/jobs/%E0/runs')).toMatchObject({ status: 400 });
  expect(await api(page, 'GET', '/api/jobs/none-such/runs')).toMatchObject({ status: 404 });

  // Tag through the dialog like a user; options come from the list's data-apps.
  await page.goto('/jobs');
  await page.waitForFunction(() => customElements.get('jobs-app') !== undefined);
  await page.click('#jobs-new');
  await expect(page.locator('wa-select#job-app')).toBeVisible();
  // The fixture's "alpha app" plus this test's.
  const options = page.locator('#job-app wa-option');
  await expect(options).toHaveCount(2);
  const picked = options.filter({ hasText: 'E2E Jobs App' });
  await expect(picked).toHaveCount(1);
  expect(await picked.getAttribute('value')).toBe(appId);
  expect(await picked.textContent()).toBe('E2E Jobs App');
  await page.evaluate(id => {
    (document.querySelector('#job-app') as unknown as { value: string }).value = id;
  }, appId);
  await page.fill('wa-input#job-name input', 'e2e-job');
  await page.fill('wa-input#job-schedule input', '0 0 31 12 *'); // never due: runs below are manual
  await page.fill('wa-textarea#job-command textarea', 'echo JOBS_RUN_MARKER; sleep 8');
  await page.click('#job-save');
  await expect(page.locator('jobs-app .job')).toHaveCount(1);

  // The chip renders, and the card carries the tag for re-edit.
  await expect(page.locator('jobs-app .job-app')).toHaveText('E2E Jobs App');
  expect(
    await page.locator('jobs-app wa-button[data-edit="e2e-job"]').getAttribute('data-app'),
  ).toBe(appId);
  // ...and the listing has it (LEFT JOIN).
  const listed = await api(page, 'GET', '/api/jobs');
  expect(listed.json.jobs[0]).toMatchObject({
    appId,
    appName: 'E2E Jobs App',
    lastResult: 'unknown',
  });
  // A malformed :fired_at is 400; a well-formed one naming no run is 404.
  for (const bad of ['abc', '-1', '12.5', '1234567890123456', '17600000000001234']) {
    expect(await api(page, 'GET', `/api/jobs/e2e-job/runs/${bad}/log`)).toMatchObject({
      status: 400,
      json: { code: 'invalid_fired_at' },
    });
  }
  expect(await api(page, 'GET', '/api/jobs/e2e-job/runs/1760000000000/log')).toMatchObject({
    status: 404,
  });
  expect(await api(page, 'GET', '/api/jobs/e2e-job/runs')).toMatchObject({
    status: 200,
    json: { runs: [] },
  });

  // Run now: a live session whose output is logged under CYBERMOLE_JOB_LOG_DIR.
  await page.click('jobs-app wa-button[data-run="e2e-job"]');
  await expect(page.locator('jobs-app .job-view')).toHaveAttribute(
    'href',
    /\?run=cybermole-e2e-job$/,
  );
  // expect.poll retries a bad value, not a throw, so ENOENT must read as 0.
  const logDirEntries = () => {
    try {
      return fs.readdirSync(`${WORKSPACE}/job-logs/e2e-job`).length;
    } catch {
      return 0;
    }
  };
  await expect.poll(logDirEntries, { timeout: 10_000 }).toBeGreaterThanOrEqual(1);
  // The session is up and its runs row exists, unfinished.
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

  // "view run" deep-links the console, attached in run mode.
  await page.click('jobs-app .job-view');
  await page.waitForURL(u => u.pathname === '/');
  await waitForTermText(page, 'JOBS_RUN_MARKER');

  // The run ends (~8 s) and a tick observes it (≤30 s later).
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

  // The history dialog shows the run, and the log viewer its tail.
  await page.goto('/jobs');
  await page.click('jobs-app wa-button[data-runs="e2e-job"]');
  await expect(page.locator('#runs-dialog .run-row:not(.run-head)')).toHaveCount(1);
  await expect(page.locator('#runs-dialog .run-row:not(.run-head)')).toContainText('manual');
  await expect(page.locator('#runs-dialog .run-exit.ok')).toHaveText('exit 0');
  await page.click('#runs-dialog wa-button[data-log]');
  await expect(page.locator('#run-log')).toContainText('JOBS_RUN_MARKER');

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
  // Clients name runs, never paths.
  expect(await api(page, 'GET', '/api/jobs/e2e-job/runs/1/log')).toMatchObject({ status: 404 });
  // The runs dialog is modal: close it before clicking outside.
  await page.locator('#runs-dialog wa-button[data-dialog="close"]').click();

  // A failed run reports failed with the real exit code.
  await api(page, 'POST', '/api/jobs', {
    name: 'e2e-fail',
    schedule: '0 0 31 12 *',
    command: 'echo bad; exit 7',
  });
  await api(page, 'POST', '/api/jobs/e2e-fail/run');
  await expect.poll(() => lastResult('e2e-fail'), { timeout: 45_000 }).toBe('failed');
  await page.click('jobs-app wa-button[data-runs="e2e-fail"]');
  await expect(page.locator('#runs-dialog .run-exit.failed')).toHaveText('exit 7');

  // Cleanup: both jobs, their run files, and the app.
  for (const name of ['e2e-job', 'e2e-fail']) {
    expect((await api(page, 'DELETE', `/api/jobs/${name}`)).status).toBe(200);
    fs.rmSync(`${WORKSPACE}/job-logs/${name}`, { recursive: true, force: true });
  }
  expect((await api(page, 'DELETE', '/api/apps/e2e-jobs-app')).status).toBe(200);
});

// A mutation over the internal socket (the agent path) updates an open /jobs
// page without the 15 s poll. The window is 6 s and the mutation fires ~1 s
// after load, so only the WS path can satisfy it.
test('an internal-socket mutation updates an open /jobs page without the poll', async ({
  page,
}) => {
  await login(page);
  await page.goto('/jobs');
  await expect(page.locator('jobs-app')).toBeVisible();

  // The agent transport: node:http over the internal socket.
  const internalApi = (
    method: string,
    url: string,
    body?: unknown,
  ): Promise<{ status: number; json: { name?: string; errorCode?: string } | null }> =>
    new Promise((resolve, reject) => {
      const payload = body === undefined ? null : JSON.stringify(body);
      const req = http.request(
        {
          socketPath: `${WORKSPACE}.sock`,
          path: url,
          method,
          // Chunked bodies get 411, so declare a Content-Length.
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

  // Create over the socket: the card appears well before the poll could.
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

  // Run-now over the socket flips the badge (sleep 3 ends on its own).
  const fired = await internalApi('POST', '/jobs/sock-live/run');
  expect(fired.json).toMatchObject({ name: 'sock-live' });
  await expect
    .poll(() => page.locator('jobs-app .job wa-badge:has-text("running")').count(), {
      timeout: 6_000,
    })
    .toBe(1);

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

  // A name match: one row; the app group hides.
  await search.fill('deploy');
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText('deploy checklist');
  await expect(groups).toHaveCount(1);
  await expect(groups.first().locator('h2 .g-name')).toHaveText('console');

  // Names only: a fragment of a fixture's cwd matches nothing.
  await search.fill('cybermole-itest');
  await expect(rows).toHaveCount(0);
  await expect(groups).toHaveCount(0);
  await search.fill('scratch');
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText('scratch');

  await search.fill('zzz-no-match');
  await expect(rows).toHaveCount(0);
  await expect(groups).toHaveCount(0);

  // Escape clears. Earlier specs leave workspaces behind, so count what the
  // db holds for THIS page (console workspaces only — the split).
  const state = await api(page, 'GET', '/api/state');
  const total = (state.json.workspaces as Array<{ appId: string | null }>).filter(
    w => w.appId === null,
  ).length;
  expect(total).toBeGreaterThanOrEqual(2);
  await search.press('Escape');
  await expect(rows).toHaveCount(total);

  // A poll re-render keeps the search box's value, focus and caret.
  await search.fill('checklist');
  await page.keyboard.press('ArrowLeft'); // caret mid-string
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
    // Focus in a shadow root retargets activeElement to the host; accept either.
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
  await expect(rows).toHaveCount(1);

  // The re-rendered box still handles Escape.
  await search.press('Escape');
  await expect(rows).toHaveCount(total);
});

test('signed out, any page URL serves the login page and sign-in returns to it', async ({
  page,
}) => {
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
  await expect(page.locator('app-header wa-button[href$="/settings"]')).toBeVisible();
  await page.goto('/settings');

  const cfg = page.locator('#config');
  await expect(cfg.locator('.cfg-row')).toHaveCount(11);
  const text = await cfg.innerText();
  expect(text).toContain('cybermole-itest'); // tmux socket
  expect(text).toContain('cmd.sh'); // the shell command
  expect(text).toContain('default workspace cwd');
  expect(text).toContain('/tmp/cybermole-itest/cybermole.db'); // a path, never contents
  await expect(page.locator('#pi-badge')).toContainText(/pi /);
  await expect(page.locator('#pi-declared')).toContainText('declared');

  // Dry-run only checks; nothing is installed.
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

test('terminal defaults: the /settings form validates, saves, and the override persists across a reload', async ({
  page,
}) => {
  await login(page);
  await page.goto('/settings');
  await page.waitForFunction(() => customElements.get('validation-enhancer-zod') !== undefined);
  // wa-input's value is a property, set once the element upgrades.
  await page.waitForFunction(
    () =>
      typeof (
        document.querySelector('wa-input#shell-command') as unknown as { value?: string | null }
      )?.value === 'string',
  );
  const fieldValue = (id: string): Promise<string> =>
    page.evaluate(
      i =>
        (document.querySelector(`wa-input#${i}`) as unknown as { value: string | null }).value ??
        '',
      id,
    );

  // Prefilled with the effective values (this suite pins both env vars).
  expect(await fieldValue('shell-command')).toBe(`${WORKSPACE}/cmd.sh`);
  expect(await fieldValue('agent-command')).toBe(`${WORKSPACE}/cmd.sh agent`);
  await expect(page.locator('wa-input#shell-command input')).toHaveAttribute('maxlength', '500');

  // Over 500 chars is invalid (empty is a legal clear); nothing is POSTed.
  const posts: string[] = [];
  page.on('request', r => {
    if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/settings')
      posts.push(new URL(r.url()).pathname);
  });
  await page.evaluate(() => {
    // Setting the host property bypasses the input's maxlength, like a pasting script.
    (document.querySelector('wa-input#shell-command') as unknown as { value: string }).value =
      'x'.repeat(501);
  });
  await page.click('#save-terminal-defaults');
  await expect(page.locator('#shell-command-error')).toHaveText('command is too long (max 500)');
  // The message is in the hint slot, which describes the real input.
  await expect(page.locator('wa-input#shell-command input')).toHaveAccessibleDescription(
    /command is too long/,
  );
  expect(posts).toEqual([]);

  // A save writes both fields as shown, so the agent field is pinned too.
  await page.fill('wa-input#shell-command input', '/bin/dash -l');
  await page.click('#save-terminal-defaults');
  await expect(page.locator('#terminal-defaults-result:not(.hidden)')).toContainText('saved');
  await expect(page.locator('#terminal-defaults-source')).toContainText('(override saved)');

  // A reload re-prefills from the db; the API agrees.
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
  expect(st.command).toBe('/bin/dash -l');

  // Emptying one field clears only its override.
  await page.fill('wa-input#shell-command input', '');
  await page.click('#save-terminal-defaults');
  await expect(page.locator('#terminal-defaults-result:not(.hidden)')).toContainText('saved');
  const cleared = (await api(page, 'GET', '/api/settings')).json.terminalDefaults;
  expect(cleared).toMatchObject({ shellOverridden: false, agentOverridden: true });
  expect(cleared.shellCommand).toBe(`${WORKSPACE}/cmd.sh`);

  // The server validates with the same schema.
  const tooLong = await api(page, 'POST', '/api/settings', { shellCommand: 'x'.repeat(501) });
  expect(tooLong.status).toBe(400);
  expect(tooLong.json.issues.shellCommand).toContain('too long');

  // Reset clears both overrides, leaving clean state for the rest of the suite.
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

// ---------- browser hardening ----------

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "connect-src 'self' wss:; frame-ancestors 'none'";

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
  await page.goto('/login'); // establishes the origin
  // A mismatched Origin (sibling subdomain, sandboxed "null") is 403 before auth.
  for (const origin of ['https://evil.example', 'https://console.example.com', 'null']) {
    const r = await request.post('/api/apps', { headers: { Origin: origin }, data: { name: 'x' } });
    expect(r.status(), `Origin: ${origin}`).toBe(403);
  }
  // No Origin (curl) or a matching one reaches the auth gate: 401 without a session.
  expect((await request.post('/api/apps', { data: { name: 'x' } })).status()).toBe(401);
  const origin = new URL(page.url()).origin;
  expect(
    (
      await request.post('/api/apps', { headers: { Origin: origin }, data: { name: 'x' } })
    ).status(),
  ).toBe(401);

  // A same-origin POST from an authed page works (validate has no side effects).
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
  const token =
    (await page.context().cookies()).find(c => c.name === 'cybermole_session')?.value ?? '';
  const wsOrigin = new URL(page.url()).origin;

  // Browsers can't omit or forge Origin, so test from Node.
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

  // Missing Origin: browser-only, so destroyed rather than a 4xx.
  expect(await attempt({})).toBe('rejected');
  // Foreign Origin (cross-site WebSocket hijacking) too.
  expect(await attempt({ Origin: 'https://evil.example' })).toBe('rejected');
  // Matching Origin: 401 without a session, open with one.
  expect(await attempt({ Origin: wsOrigin })).toBe('rejected');
  expect(await attempt({ Origin: wsOrigin, Cookie: `cybermole_session=${token}` })).toBe('open');

  // The hand-written 401 handshake must carry the security headers too.
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
      res.resume();
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

  // A hashed Astro asset (scripts must stay external for script-src 'self').
  const src = (await page.text()).match(/<script[^>]*\bsrc="([^"]+)"/)?.[1];
  expect(src).toBeTruthy();
  const asset = await request.get(src!);
  expect(asset.status()).toBe(200);
  expectSecurityHeaders(asset.headers());

  // An API response (the 401 is the app's too).
  const api = await request.get('/api/state');
  expect(api.status()).toBe(401);
  expectSecurityHeaders(api.headers());
});

test('console/builder/jobs/settings load nothing off-origin and glyphs render from the app itself', async ({
  page,
}) => {
  await login(page);
  const self = new URL(page.url()).origin;
  const external: string[] = [];
  // Aborting the CDN proves the page doesn't need it.
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
  for (const p of ['/builder', '/jobs', '/settings']) {
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

  // Keep the page on the console while its session dies: the poll would
  // otherwise 401 → /login. Replay the state captured while signed in (an
  // empty tree would tear down the pane under test).
  const stateBody = await page.evaluate(async () => (await fetch('/api/state')).text());
  await page.route('**/api/state', route =>
    route.fulfill({ body: stateBody, contentType: 'application/json' }),
  );

  // A second socket on the same cookie sees 'signed-out', then the close.
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

  // The terminal doesn't retry: still 'signed out' past the first backoff.
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

  // The shared cookie is dead now; make the next login() sign in fresh.
  sessionCookie = null;
});

test('log out everywhere ends every signed-in session', async ({ page, browser }) => {
  await login(page); // fresh sign-in (the previous test killed the cookie)

  // A second, independent login: another live token.
  const ctx2 = await browser.newContext();
  const page2 = await ctx2.newPage();
  await page2.goto('/login');
  await signIn(page2);
  await page2.waitForURL(u => u.pathname === '/');

  await page.goto('/settings');
  await page.click('wa-button#logout-all');
  await page.waitForURL(u => u.pathname === '/login');

  // Both tokens are rejected. page2's own signed-out navigation can abort
  // this fetch: that's caught in-page as 0 (or -1 if the context died) so
  // expect.poll retries.
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
  // Our own short-lived server, since the shared webServer is Playwright's.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cybermole-sigterm-'));
  const dbFile = path.join(dir, 'cybermole.db');
  expect(setCredential(new StateDb(dbFile), USERNAME, PASSWORD).ok).toBe(true);
  const port = 3481;
  // Per-run socket, so a leftover server can't hold a stale session name.
  const tmuxSocket = `cybermole-itest-sig-${process.pid}`;
  const child = spawn(process.execPath, ['dist-server/server/main.js'], {
    env: {
      ...process.env,
      CYBERMOLE_PORT: String(port),
      CYBERMOLE_HOST: '127.0.0.1',
      CYBERMOLE_DB_FILE: dbFile,
      CYBERMOLE_AGENT_DIR: path.join(dir, 'pi-agent'),
      CYBERMOLE_APPS_SOCK: '',
      CYBERMOLE_NEW_SESSION_CWD: dir,
      CYBERMOLE_TMUX_SOCKET: tmuxSocket,
      CYBERMOLE_COMMAND: '/bin/sh',
      // A deterministic agent command (no dependency on the vendored pi).
      CYBERMOLE_AGENT_COMMAND: '/bin/sh',
    },
    stdio: 'ignore',
  });
  let ws: nodeWs.WebSocket | null = null;
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  try {
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

    // Its own limiter, so the shared login budget is untouched.
    const login = await fetch(`http://127.0.0.1:${port}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
    });
    expect(login.status).toBe(200);
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
    // WS upgrades need a matching Origin.
    ws = new nodeWs.WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { Cookie: cookie, Origin: `http://127.0.0.1:${port}` },
    });
    const messages: string[] = [];
    ws.on('message', d => messages.push(String(d)));
    await new Promise<void>((resolve, reject) => {
      ws!.on('open', resolve);
      ws!.on('error', reject);
    });

    // A real console page too: 'restart' must be treated as reconnectable.
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
    const autoId = await page
      .locator('terminal-tabs .tabs-bar .tab')
      .first()
      .getAttribute('data-term');
    expect(autoId).toBeTruthy();
    await page.click('terminal-tabs .tab-new'); // creates + selects the terminal tab
    // Wait for the selection to leave the auto tab before reading it.
    await expect
      .poll(() => page.locator('terminal-tabs .tabs-bar .tab.active').getAttribute('data-term'))
      .not.toBe(autoId);
    const tabId = await page
      .locator('terminal-tabs .tabs-bar .tab.active')
      .getAttribute('data-term');
    expect(tabId).toBeTruthy();
    await expect(paneStatus(page, '.ok')).toContainText(`attached: t-${tabId}`, {
      timeout: 20_000,
    });

    // Listeners first: a fast drain could fire 'exit'/'close' before a
    // later registration and hang the await.
    const exited = new Promise<number | null>(resolve => child.on('exit', code => resolve(code)));
    const closed = new Promise<void>(resolve => ws!.on('close', resolve));
    child.kill('SIGTERM');
    const killed = Date.now();
    await closed;
    // 'restart' arrived before the close, as the last frame.
    expect(messages).toContain(JSON.stringify({ type: 'restart' }));
    expect(messages[messages.length - 1]).toBe(JSON.stringify({ type: 'restart' }));
    // The page announces the restart and keeps retrying (the server is gone).
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
      /* no server was started */
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('auto-update setting: default OFF, toggle persists across reload, status lines render', async ({
  page,
}) => {
  // Before the rate-limit test (last). The first auto-update check is a
  // minute after enabling, and this test turns it back off, so the shared
  // server never runs npm.
  await login(page);
  // The config rows and status lines are in the server-rendered HTML.
  const html = await page.evaluate(async () => (await fetch('/settings')).text());
  expect(html).toContain(`${WORKSPACE}/cybermole.db`);
  expect(html).toContain('not checked yet');
  await page.goto('/settings');

  // The switch upgraded client-side.
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

  // A fresh db: off in the UI and the API, never checked.
  expect(await isChecked()).toBe(false);
  await expect(page.locator('#auto-check-line')).toContainText('not checked yet');
  await expect(page.locator('#auto-update-line')).toContainText('no auto-update has run yet');
  expect((await api(page, 'GET', '/api/settings')).json.piAutoUpdate).toMatchObject({
    enabled: false,
  });

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

  // Persisted across a reload.
  await page.reload();
  await page.waitForFunction(
    () =>
      (document.querySelector('wa-switch#pi-auto-update') as unknown as { checked?: boolean })
        ?.checked === true,
  );
  await expect(page.locator('#auto-check-line')).toContainText('not checked yet');

  expect((await api(page, 'POST', '/api/auto-update-pi', { enabled: 'yes' })).status).toBe(400);
  expect((await api(page, 'POST', '/api/auto-update-pi', {})).status).toBe(400);

  // Back off: nothing scheduled for the rest of the suite.
  await control.click();
  await expect
    .poll(async () => (await api(page, 'GET', '/api/settings')).json.piAutoUpdate.enabled)
    .toBe(false);
  expect(setting()).toBe('0');
  db.close();
});

test('the editor stays absent when unconfigured', async ({ page, request }) => {
  // No CYBERMOLE_EDITOR_UPSTREAM here: no editor tab or iframe, editor:
  // false in state, and /editor/ is 404 signed in and 401 signed out (a data
  // route, never a page). The cookieless leg uses Playwright's API client,
  // which never sends the Secure cookie over plain http.
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
  // Before the rate-limit test (last). The ?t= deep link opens the
  // terminal's workspace with the tab selected.
  await login(page);
  const cwd = `${WORKSPACE}/t-deep-link`;
  fs.mkdirSync(cwd, { recursive: true });
  // set a distinct cwd via PATCH (the create derives it)
  const wsMade = await api(page, 'POST', '/api/workspaces', { name: 'deep link' });
  expect(wsMade.status).toBe(200);
  const patched = await api(page, 'PATCH', `/api/workspaces/${wsMade.json.id}`, { cwd });
  expect(patched.status, JSON.stringify(patched.json)).toBe(200);
  const made = await api(page, 'POST', `/api/workspaces/${wsMade.json.id}/terminals`, {});
  expect(made.status).toBe(200);
  expect(made.json.live).toBe(true);
  const id = made.json.id as string;

  // Sidebar row and tab both active, attached to t-<uuid>, banner shown.
  await page.goto(`/?t=${id}`);
  await expect(page.locator(`workspace-sidebar li[data-ws="${wsMade.json.id}"]`)).toHaveClass(
    /active/,
  );
  await expect(page.locator(`terminal-tabs .tab[data-term="${id}"]`)).toHaveClass(/active/);
  await expect(page.locator('.terminal-status')).toContainText(`attached: t-${id}`);
  await waitForTermText(page, MARKER);

  // An unknown uuid: a toast, the page stays up on the first fixture
  // workspace, nothing respawns. (The toast's items may be in light or shadow DOM.)
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

  expect((await api(page, 'DELETE', `/api/terminals/${id}`)).status).toBe(200);
  expect((await api(page, 'DELETE', `/api/workspaces/${wsMade.json.id}`)).status).toBe(200);
});

test('a terminal tab survives a WEB restart: tmux keeps the session, the client reconnects to it', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  // Never SIGTERM the shared webServer: boot a private one with its own db,
  // tmux socket and login limiter.
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
    CYBERMOLE_APPS_SOCK: '',
    CYBERMOLE_DB_FILE: dbFile,
    CYBERMOLE_AGENT_DIR: path.join(dir, 'pi-agent'),
    CYBERMOLE_NEW_SESSION_CWD: cwd,
    CYBERMOLE_TMUX_SOCKET: tmuxSocket,
    CYBERMOLE_COMMAND: cmd,
    // A deterministic agent command (no dependency on the vendored pi).
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

    // Sign in through the private server's form.
    await page.goto(`http://127.0.0.1:${port}/login`);
    await signIn(page);
    await page.waitForURL(u => u.pathname === '/');

    // One workspace and tab through the real UI. The cwd derives to
    // CYBERMOLE_NEW_SESSION_CWD.
    const wsMade = await api(page, 'POST', '/api/workspaces', { name: 'survive' });
    expect(wsMade.status, JSON.stringify(wsMade.json)).toBe(200);
    await refreshState(page);
    await page.click(`workspace-sidebar li[data-ws="${wsMade.json.id}"]`);
    // the auto-opened tab, to tell the tab under test apart
    const autoId = await page
      .locator('terminal-tabs .tabs-bar .tab')
      .first()
      .getAttribute('data-term');
    expect(autoId).toBeTruthy();
    await page.click('terminal-tabs .tab-new');
    // The create is async (POST → loadState → select): wait for the second
    // tab to be selected, or later assertions pin the auto tab's pane.
    await expect(page.locator('terminal-tabs .tabs-bar .tab')).toHaveCount(2);
    await expect
      .poll(() => page.locator('terminal-tabs .tabs-bar .tab.active').getAttribute('data-term'))
      .not.toBe(autoId);
    const tabId = await page
      .locator('terminal-tabs .tabs-bar .tab.active')
      .getAttribute('data-term');
    expect(tabId).toBeTruthy();
    await waitForTermText(page, MARKER, 20_000);
    await expect(paneStatus(page, '.ok')).toContainText(`attached: t-${tabId}`);
    await page.locator('agent-terminal:not(.hidden) .terminal-container').click();
    await page.keyboard.type('echo SURVIVES_$((40+2))\n');
    await waitForTermText(page, 'SURVIVES_42', 10_000);

    // Web restart: the server SIGTERMs gracefully, tmux keeps the session,
    // and a fresh process on the same db and socket serves the reconnect.
    // The "reconnecting" status can flash faster than Playwright samples,
    // so a page-side recorder captures every status text.
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

    // Same tab, same session (a respawn would be a fresh shell).
    await expect
      .poll(
        async () =>
          (
            await page.evaluate(
              () => (window as unknown as { __statusSeen?: string[] }).__statusSeen ?? [],
            )
          )
            .join(' | ')
            .includes('reconnect'),
        { timeout: 15_000 },
      )
      .toBe(true);
    await expect(paneStatus(page, '.ok')).toContainText(`attached: t-${tabId}`, {
      timeout: 30_000,
    });
    await waitForTermText(page, 'SURVIVES_42', 10_000); // the screen survived: tmux redraws it

    // Still live in the fresh server's state, and usable.
    const state = await api(page, 'GET', '/api/state');
    const row = state.json.workspaces.find((w: { id: string }) => w.id === wsMade.json.id);
    expect(row.terminals.find((t: { id: string }) => t.id === tabId).live).toBe(true);
    await page.locator('agent-terminal:not(.hidden) .terminal-container').click();
    await page.keyboard.type('echo AFTER_$((40+2))\n');
    await waitForTermText(page, 'AFTER_42', 10_000);

    // On a workspace-less db, deleting the workspace shows the no-workspace prompt.
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
  // Runs last: earlier tests spent part of the budget. Each attempt claims a
  // different client IP via X-Forwarded-For, which must be ignored with
  // CYBERMOLE_TRUST_PROXY at 0.
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
