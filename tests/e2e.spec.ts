// e2e.spec.ts — integration tests against the real built app:
// Astro SSR pages, wa-* components upgraded client-side, auth, the
// sidebar's pi-session fixtures, and the full terminal round trip
// (xterm → WS → node-pty → tmux → back).
// Runs serially (workers: 1) — see playwright.config.ts.
import { execFileSync, spawn } from 'node:child_process';
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
import { expect, test, type Cookie, type Page } from '@playwright/test';
import { WebSocket as NodeWebSocket } from 'ws';
import { setCredential } from '../src/lib/auth';
import { StateDb } from '../src/lib/db';
import { MARKER, PASSWORD, S3_BUCKET, S3_PORT, TMUX_SOCKET, USERNAME, UUIDV7_SIBLINGS, WORKSPACE } from './env';
import { UPLOAD_MAX_BODY_BYTES } from '../src/schemas/uploads';

const FIXTURE_A = '11111111-1111-1111-1111-111111111111';
const FIXTURE_B = '22222222-2222-2222-2222-222222222222';

/** Terminal sizing invariants, evaluated in the page:
 *  - the app shell is viewport-locked: the terminal never makes the page
 *    taller than the viewport (no page scrollbar);
 *  - the rendered rows fill .terminal-container (the xterm screen reaches the bottom
 *    of the box within one cell row) — i.e. the terminal tracks the
 *    available space, not its own previously rendered size. */
async function waitForTerminalFitted(page: Page, timeout = 5000): Promise<void> {
  await page.waitForFunction(() => {
    const el = document.querySelector('agent-terminal');
    const box = document.querySelector('agent-terminal .terminal-container');
    const screen = document.querySelector('agent-terminal .terminal-container .xterm-screen');
    if (!el || !box || !screen) return false;
    const rows = (el as unknown as { terminal?: { rows: number } }).terminal?.rows ?? 0;
    if (rows <= 0) return false;
    const b = box.getBoundingClientRect();
    const s = screen.getBoundingClientRect();
    const cellH = s.height / rows;
    return document.documentElement.scrollHeight <= window.innerHeight + 1
      && b.height - s.height <= cellH + 1;
  }, null, { timeout });
}

/** The browser terminal's current cols/rows. */
async function termDims(page: Page): Promise<{ cols: number; rows: number }> {
  return page.evaluate(() => {
    const t = (document.querySelector('agent-terminal') as unknown as { terminal: { cols: number; rows: number } })
      .terminal;
    return { cols: t.cols, rows: t.rows };
  });
}

/** Wait until the terminal's buffer contains `text`.
 *  Asserts on the buffer, not the DOM: the WebGL renderer draws rows to a
 *  canvas, so .terminal-container has no text nodes to assert on. */
async function waitForTermText(page: Page, text: string, timeout = 10_000): Promise<void> {
  await page.waitForFunction(
    marker => {
      const el = document.querySelector('agent-terminal') as unknown as
        | { terminal?: { buffer: { active: { length: number; getLine(i: number): { translateToString(trimRight?: boolean): string } | undefined } } } }
        | null;
      const buf = el?.terminal?.buffer.active;
      if (!buf) return false;
      for (let i = 0; i < buf.length; i++) {
        if (buf.getLine(i)?.translateToString(true).includes(marker)) return true;
      }
      return false;
    },
    text,
    { timeout }
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
    sessionCookie = (await page.context().cookies()).find(c => c.name === 'webpi_session') ?? null;
  }
  await page.waitForSelector('session-sidebar .nav');
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
  expect((await request.get('/api/files/uploads/00000000-0000-4000-8000-000000000000')).status()).toBe(401);
  // Unknown API paths are 401 too — never the login page.
  expect((await request.get('/api/nope')).status()).toBe(401);
  // Server-rendered partials are data routes too — never the login page
  // (an element would swap login HTML into its list).
  expect((await request.get('/partials/jobs-list')).status()).toBe(401);
  expect((await request.get('/partials/settings')).status()).toBe(401);
  expect((await request.post('/api/session/hide', { data: { id: FIXTURE_A } })).status()).toBe(401);
  expect((await request.post('/api/session/unhide', { data: { id: FIXTURE_A } })).status()).toBe(401);
});

test('bad credentials show the danger callout', async ({ page }) => {
  await page.goto('/login');
  await page.fill('wa-input#username input', USERNAME);
  await page.fill('wa-input#password input', 'wrong-password');
  await page.click('wa-button:has-text("sign in")');
  await expect(page.locator('wa-callout#error:not(.hidden)')).toContainText('invalid credentials');
});

test('the login form validates in the browser: empty fields show their messages, nothing is POSTed', async ({ page }) => {
  // Client-side validation (validation-enhancer-zod + the loginForm schema)
  // — an empty field never costs a request, so this spends nothing from the
  // suite's login budget.
  const posts: string[] = [];
  page.on('request', r => { if (r.method() === 'POST') posts.push(r.url()); });
  await page.goto('/login');
  await page.waitForFunction(() => customElements.get('validation-enhancer-zod') !== undefined);
  await page.click('wa-button:has-text("sign in")');
  await expect(page.locator('#username-error')).toHaveText('enter your username');
  await expect(page.locator('#password-error')).toHaveText('enter your password');
  expect(posts).toEqual([]);
  // The message lives in the wa-input's hint slot: the REAL input inside
  // the shadow DOM is described by it (aria-errormessage on the host would
  // never reach it), and the hint is not aria-hidden.
  await expect(page.locator('wa-input#username input')).toHaveAccessibleDescription('enter your username');
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

test('login lands on the console with fixture sessions in the sidebar', async ({ page }) => {
  await login(page);
  await expect(page.locator('console-app wa-page')).toHaveCount(1);
  await expect(page.locator('agent-terminal .terminal-container .xterm')).toHaveCount(1);

  // The WebGL renderer is lazy-imported as an async chunk; once it loads,
  // xterm swaps its DOM rows for canvas rendering (the addon mounts >1
  // canvas, so assert presence, not an exact count). Headless Chromium has
  // SwiftShader WebGL, so the renderer should engage.
  await page.waitForFunction(
    () => document.querySelectorAll('agent-terminal .terminal-container canvas').length > 0,
    null, { timeout: 10_000 }
  );

  const nav = page.locator('session-sidebar .nav');
  await expect(nav).toContainText('fix the login bug in auth module');
  await expect(nav).toContainText('refactor the tmux helpers');
  await expect(nav).toContainText('deploy checklist review');
  // Sessions grouped by cwd: two groups across the five fixtures.
  await expect(nav.locator('li.group')).toHaveCount(2);
});

test('new session: created, attached, terminal round-trips input', async ({ page }) => {
  await login(page);

  await page.fill('wa-input#new-name input', 'itest-live');
  await page.click('wa-button#new-btn');
  await expect(page.locator('session-sidebar li[data-live="itest-live"]')).toHaveCount(1);

  // WS attach → tmux → banner from the session command appears in xterm.
  await waitForTermText(page, MARKER, 20_000);
  await expect(page.locator('.terminal-status.ok')).toContainText('attached');

  // Full loop: keystrokes in xterm → WS → pty → tmux → output rendered.
  // $((41+1)) distinguishes the shell's evaluated output (TYPIST_42) from
  // the locally echoed command line (which contains the expression).
  await page.locator('agent-terminal .terminal-container').click();
  await page.keyboard.type('echo TYPIST_$((41+1))\n');
  await waitForTermText(page, 'TYPIST_42', 10_000);
});

test('resume a past session from the sidebar', async ({ page }) => {
  await login(page);
  await page.click(`session-sidebar li[data-resume="${FIXTURE_A}"]`);
  await expect(page.locator('.terminal-status.ok')).toContainText('attached', { timeout: 20_000 });
  await waitForTermText(page, MARKER);
});

test('resuming sessions whose ids share a prefix gives each its own tmux session', async ({ page }) => {
  // pi ids are UUIDv7: the first 8 hex chars are a timestamp, so sessions
  // started close together share them. Regression: resume named its tmux
  // session r-<first 8 chars> and reused it, attaching the second resume
  // to the first one's running pi.
  const [one, two] = UUIDV7_SIBLINGS;
  await login(page);
  await page.click(`session-sidebar li[data-resume="${one}"]`);
  await expect(page.locator('.terminal-status.ok')).toContainText(`attached: r-${one}`, { timeout: 20_000 });
  await page.click(`session-sidebar li[data-resume="${two}"]`);
  await expect(page.locator('.terminal-status.ok')).toContainText(`attached: r-${two}`, { timeout: 20_000 });

  const names = execFileSync('tmux', ['-L', TMUX_SOCKET, 'list-sessions', '-F', '#{session_name}'],
    { encoding: 'utf8' }).split('\n');
  expect(names).toContain(`r-${one}`);
  expect(names).toContain(`r-${two}`);
});

test('a paste bigger than one WebSocket frame reaches the session whole', async ({ page }) => {
  test.setTimeout(60_000);
  // > the server's 1 MiB maxPayload: only arrives if the client chunks it.
  const size = 1_200_000;
  const out = `${WORKSPACE}/paste.out`;
  await login(page);
  await page.fill('wa-input#new-name input', 'itest-paste');
  await page.click('wa-button#new-btn');
  await waitForTermText(page, MARKER, 20_000);

  // Raw mode + no echo on the pane's tty so head sees the paste byte for
  // byte (a canonical-mode line is capped at 4 KiB by the kernel, which
  // would make this a test of the tty rather than of web-pi).
  await page.locator('agent-terminal .terminal-container').click();
  await page.keyboard.type(`stty raw -echo; echo RAW_$((40+2)); head -c ${size} > ${out}; stty sane\n`);
  await waitForTermText(page, 'RAW_42');
  await page.evaluate(n => {
    const el = document.querySelector('agent-terminal') as unknown as { terminal: { paste(d: string): void } };
    el.terminal.paste('x'.repeat(n));
  }, size);

  await expect.poll(() => {
    try { return fs.statSync(out).size; } catch { return -1; }
  }, { timeout: 30_000 }).toBe(size);
  await expect(page.locator('.terminal-status.ok')).toContainText('attached: itest-paste');
});

test('a dropped socket reconnects to the same session; a session that ends is not retried', async ({ page }) => {
  await login(page);
  await page.fill('wa-input#new-name input', 'itest-reconnect');
  await page.click('wa-button#new-btn');
  await waitForTermText(page, MARKER, 20_000);
  await expect(page.locator('.terminal-status.ok')).toContainText('attached: itest-reconnect');

  // Drop the socket the way a proxy idle cut does: closed under the
  // component, with no 'exit' from the server first.
  await page.evaluate(() =>
    (document.querySelector('agent-terminal') as unknown as { websocket: WebSocket }).websocket.close());
  await expect(page.locator('.terminal-status')).toContainText('reconnecting');
  await expect(page.locator('.terminal-status.ok')).toContainText('attached: itest-reconnect', { timeout: 10_000 });
  await page.locator('agent-terminal .terminal-container').click();
  await page.keyboard.type('echo BACK_$((40+2))\n');
  await waitForTermText(page, 'BACK_42');

  // The session itself ending arrives as the server's 'exit': reported,
  // never reconnected (that would also loop two tabs bumping each other).
  execFileSync('tmux', ['-L', TMUX_SOCKET, 'kill-session', '-t', 'itest-reconnect']);
  await expect(page.locator('.terminal-status.info')).toContainText('detached: itest-reconnect');
  await page.waitForTimeout(2500); // longer than the first reconnect backoff
  await expect(page.locator('.terminal-status.info')).toContainText('detached: itest-reconnect');
});

test('malformed requests and frames are rejected without taking the server down', async ({ page }) => {
  await login(page);
  // In-page fetch, not page.request: Playwright's API client doesn't send
  // the Secure session cookie over the suite's plain-http origin.
  const status = (method: string, url: string, body?: string): Promise<number> =>
    page.evaluate(async ([m, u, b]) => (await fetch(u!, {
      method: m!, headers: { 'Content-Type': 'application/json' }, ...(b === undefined ? {} : { body: b }),
    })).status, [method, url, body] as const);

  // A bad %-escape in a path segment threw out of the request handler and
  // killed the process; now it's a 400.
  expect(await status('DELETE', '/api/jobs/%E0')).toBe(400);
  expect(await status('POST', '/api/jobs/%E0/run')).toBe(400);
  // JSON bodies must be objects.
  expect(await status('POST', '/api/session/hide', '[]')).toBe(400);
  expect(await status('POST', '/api/new', '"just a string"')).toBe(400);
  // Bodies are capped at 10 KiB off the upload route: server/main.ts
  // refuses an oversized one from its Content-Length before Astro reads it.
  expect(await status('POST', '/api/new', JSON.stringify({ name: 'x'.repeat(20_000) }))).toBe(413);
  // The JSON API only parses JSON (or form) bodies.
  expect(await page.evaluate(async () => (await fetch('/api/new', {
    method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{"name":"x"}',
  })).status)).toBe(415);
  // API answers are per-user state: never cached.
  expect(await page.evaluate(async () => (await fetch('/api/state')).headers.get('cache-control'))).toBe('no-store');

  // Junk WS frames — before and after attaching (`null` and a data-less
  // input each used to crash the server) — are dropped; the socket lives on.
  expect(await status('POST', '/api/new', '{"name":"itest-junk"}')).toBe(200);
  const junk = ['null', '[]', '"x"', 'not json', '{"type":"input"}', '{"type":"input","data":5}',
    '{"type":"resize","cols":"wide"}', '{"type":"attach","mode":"live"}', '{"type":"attach","mode":"resume","id":7}',
    // the task/ws-terminal modes reject the same way: missing id/target
    '{"type":"attach","mode":"terminal"}', '{"type":"attach","mode":"run"}'];
  const stillOpen = await page.evaluate(async frames => {
    const ws = new WebSocket(`ws://${location.host}/ws`);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    for (const f of frames) ws.send(f);
    ws.send(JSON.stringify({ type: 'attach', mode: 'live', target: 'itest-junk' }));
    await new Promise<void>(resolve => {
      ws.onmessage = ev => { if ((JSON.parse(ev.data as string) as { type: string }).type === 'attached') resolve(); };
    });
    for (const f of frames) ws.send(f);
    await new Promise(r => setTimeout(r, 300));
    const open = ws.readyState === WebSocket.OPEN;
    ws.close();
    return open;
  }, junk);
  expect(stillOpen).toBe(true);
  expect(await status('GET', '/api/state')).toBe(200);
});

test('files: upload streams into object storage; downloads come back as resumable attachments', async ({ page }) => {
  await login(page);
  type Upload = { status: number; body: { key?: string; name?: string; size?: number; contentType?: string; code?: string } };
  const upload = (size: number, type: string, name = 'notes.txt'): Promise<Upload> =>
    page.evaluate(async ([n, t, f]) => {
      const form = new FormData();
      // Bytes of 'a' (0x61), so stored and downloaded bodies are checkable.
      form.append('file', new File([new Uint8Array(n!).fill(0x61)], f!, { type: t! }));
      const r = await fetch('/api/files', { method: 'POST', body: form });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    }, [size, type, name] as const);
  type Download = { status: number; headers: Record<string, string>; size: number; allA: boolean };
  const download = (path: string): Promise<Download> =>
    page.evaluate(async p => {
      const r = await fetch(p);
      const bytes = new Uint8Array(await r.arrayBuffer());
      return {
        status: r.status, headers: Object.fromEntries(r.headers.entries()),
        size: bytes.length, allA: bytes.every(b => b === 0x61),
      };
    }, path);

  const ok = await upload(12, 'text/plain', 'q1 notes (draft).txt');
  expect(ok.status).toBe(201);
  expect(ok.body).toMatchObject({ name: 'q1 notes (draft).txt', size: 12, contentType: 'text/plain' });
  expect(ok.body.key).toMatch(/^uploads\/[0-9a-f-]{36}$/);
  // It reached the S3 server (tests/fake-s3.mjs), body and headers intact...
  const stored = await (await fetch(`http://127.0.0.1:${S3_PORT}/__fake/objects/${S3_BUCKET}/${ok.body.key}`)).json() as
    { body: string; contentType: string; contentDisposition: string };
  expect(Buffer.from(stored.body, 'base64').toString()).toBe('a'.repeat(12));
  expect(stored.contentType).toBe('text/plain');
  expect(stored.contentDisposition).toBe("attachment; filename*=UTF-8''q1%20notes%20%28draft%29.txt");
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
  expect(await download(`/api/files/${big.body.key}`)).toMatchObject({ status: 200, size: 12 * 1024 * 1024 + 7, allA: true });

  // Resumable, the way a download manager does it: HEAD for the ETag, a
  // first part, then the rest from where it stopped with If-Range. A
  // patterned file, so a wrong offset can't pass.
  const resume = await page.evaluate(async () => {
    const n = 6 * 1024 * 1024 + 5;
    const pattern = new Uint8Array(n).map((_, i) => i % 251);
    const form = new FormData();
    form.append('file', new File([pattern], 'pattern.pdf', { type: 'application/pdf' }));
    const { key } = await (await fetch('/api/files', { method: 'POST', body: form })).json() as { key: string };
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
    const stale = await fetch(url, { headers: { Range: 'bytes=1000000-', 'If-Range': '"not-this-version"' } });
    const pastEnd = await fetch(url, { headers: { Range: `bytes=${n}-` } });
    const multi = await fetch(url, { headers: { Range: 'bytes=0-1,5-6' } });
    return {
      n,
      head: { status: head.status, length: head.headers.get('content-length'), ranges: head.headers.get('accept-ranges'),
        body: (await head.arrayBuffer()).byteLength },
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
  expect(resume.rest).toEqual({ status: 206, range: `bytes 1000000-${n - 1}/${n}`, length: n - 1_000_000 });
  expect(resume.intact).toBe(true);
  // A changed validator gets the whole file, not a part of another version.
  expect(resume.stale).toEqual({ status: 200, length: n });
  expect(resume.pastEnd).toEqual({ status: 416, range: `bytes */${n}` });
  // More than one range: ignored, the whole file.
  expect(resume.multi).toEqual({ status: 200, length: n });

  // Keys: unknown is 404; anything that isn't uploads/<uuid> is 400 — the
  // route serves nothing else from the bucket.
  expect((await download('/api/files/uploads/00000000-0000-4000-8000-000000000000')).status).toBe(404);
  expect((await download('/api/files/etc/passwd')).status).toBe(400);
  expect((await download('/api/files/uploads/..%2F..%2Fsecret')).status).toBe(400);

  // A rejected type answers before storage even on a big body — which the
  // server drains rather than cutting, so the browser gets the answer, not
  // a reset connection.
  expect(await upload(20 * 1024 * 1024, 'text/html', 'x.html')).toMatchObject({ status: 400, body: { code: 'unsupported_file_type' } });
  // Not multipart: 415.
  expect(await page.evaluate(async () => (await fetch('/api/files', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  })).status)).toBe(415);

  // Raw requests from Node with the session cookie, for what a browser won't send.
  const cookie = (await page.context().cookies()).find(c => c.name === 'webpi_session')!;
  const port = new URL(page.url()).port;
  const raw = (path: string, headers: Record<string, string>, body?: string[]): Promise<number> =>
    new Promise((resolve, reject) => {
      const req = http.request(`http://127.0.0.1:${port}${path}`, {
        method: 'POST', headers: { Cookie: `webpi_session=${cookie.value}`, ...headers },
      }, res => { res.resume(); resolve(res.statusCode ?? 0); req.destroy(); });
      req.on('error', err => { if (!req.destroyed) reject(err); });
      if (body) { for (const chunk of body) req.write(chunk); req.end(); } else req.flushHeaders();
    });
  // Over the whole-body cap (5 GiB + envelope): refused on Content-Length
  // alone — nothing is sent, and nothing needs to be.
  expect(await raw('/api/files', {
    'Content-Type': 'multipart/form-data; boundary=x', 'Content-Length': String(UPLOAD_MAX_BODY_BYTES + 1),
  })).toBe(413);
  // A body with no Content-Length (chunked) is refused off the upload
  // route — the 10 KiB cap can't be checked up front.
  expect(await raw('/api/new', { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' },
    ['{"name":', '"itest-chunked"}'])).toBe(411);
});

test('attached session opens at the browser terminal\'s size, not 80x24', async ({ page }) => {
  await login(page);

  // The client sends {attach} then {resize} back-to-back on WS open; the
  // server must carry that size across its async tmux lookup and spawn the
  // pty at it (regression: resize was dropped pre-spawn, so the session
  // opened 80x24 in the corner of a larger browser terminal).
  await page.fill('wa-input#new-name input', 'itest-openfit');
  await page.click('wa-button#new-btn');
  await expect(page.locator('.terminal-status.ok')).toContainText('attached', { timeout: 20_000 });
  await waitForTerminalFitted(page);

  const dims = await termDims(page);
  expect(dims.cols).toBeGreaterThan(100); // default viewport is far wider than 80

  const pane = execFileSync('tmux',
    ['-L', TMUX_SOCKET, 'display-message', '-p', '-t', 'itest-openfit:0.0', '#{pane_width}x#{pane_height}'],
    { encoding: 'utf8' }).trim();
  const [w, h] = pane.split('x').map(Number) as [number, number];
  expect(w).toBe(dims.cols);
  // tmux's status line takes one row of the attached client.
  expect(h).toBeGreaterThanOrEqual(dims.rows - 1);
});

test('terminal fills the available space and refits when it shrinks', async ({ page }) => {
  await login(page);

  // Attach so the status bar is in its final state before measuring.
  await page.fill('wa-input#new-name input', 'itest-fill');
  await page.click('wa-button#new-btn');
  await expect(page.locator('.terminal-status.ok')).toContainText('attached', { timeout: 20_000 });

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

// jobs (in-process scheduler): the backend is inside the server, so the
// suite exercises the real thing everywhere — no degraded mode, no
// systemctl dependency. Runs land on the suite's tmux socket like any
// session; persistence and missed-run catch-up boot a second server on
// another port against a copy of the state db (rebooting the shared
// webServer mid-suite would take the login cookie down with it).

/** Authed in-page JSON fetch (Playwright's API client doesn't send the
 *  Secure session cookie over the suite's plain-http origin). */
async function api(page: Page, method: string, url: string, body?: unknown):
  Promise<{ status: number; json: any }> {
  return page.evaluate(async ([m, u, b]) => {
    const r = await fetch(u!, {
      method: m!, headers: { 'Content-Type': 'application/json' },
      ...(b === undefined ? {} : { body: JSON.stringify(b) }),
    });
    return { status: r.status, json: await r.json().catch(() => null) };
  }, [method, url, body] as const);
}

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
  expect((await api(page, 'POST', '/api/jobs',
    { name: 'itest-job', schedule: 'daily 08:00', command: 'true' })).status).toBe(400);
  const saved = await api(page, 'POST', '/api/jobs',
    { name: 'itest-job', schedule: '*/5 * * * *', command: 'sleep 300' });
  expect(saved.json).toMatchObject({ name: 'itest-job' });

  // The /jobs page arrives with the job card server-rendered (the HTML
  // itself, before any script runs) — and shows it.
  const html = await page.evaluate(async () => (await fetch('/jobs')).text());
  expect(html).toContain('itest-job');
  await page.goto('/jobs');
  await expect(page.locator('jobs-app .job')).toHaveCount(1);
  await expect(page.locator('jobs-app .job-name')).toContainText('itest-job');
  await expect(page.locator('jobs-app .job-meta')).toContainText('*/5 * * * *');

  // Run now: a live webpi-<name> tmux session on the suite's socket.
  const run = await api(page, 'POST', '/api/jobs/itest-job/run');
  expect(run.json).toMatchObject({ name: 'itest-job', session: 'webpi-itest-job' });
  const live = () => {
    try {
      return execFileSync('tmux', ['-L', TMUX_SOCKET, 'list-sessions', '-F', '#{session_name}'],
        { encoding: 'utf8' });
    } catch { return ''; } // no tmux server yet
  };
  await expect.poll(live, { timeout: 10_000 }).toContain('webpi-itest-job');

  // The run is live in the listing and the card says so.
  const listed = await api(page, 'GET', '/api/jobs');
  const job = listed.json.jobs.find((j: { name: string }) => j.name === 'itest-job');
  expect(job).toMatchObject({ running: true, session: 'webpi-itest-job' });
  expect(job.last).toBeTruthy();
  await page.reload();
  await expect(page.locator('jobs-app .job wa-badge:has-text("running")')).toHaveCount(1);

  // A second run while the previous one is live is refused (409).
  expect((await api(page, 'POST', '/api/jobs/itest-job/run')).status).toBe(409);

  // Delete: definition gone, the live run's session is left alone.
  expect((await api(page, 'DELETE', '/api/jobs/itest-job')).status).toBe(200);
  expect((await api(page, 'DELETE', '/api/jobs/itest-job')).status).toBe(404);
  expect((await api(page, 'GET', '/api/jobs')).json.jobs).toEqual([]);
  expect(live()).toContain('webpi-itest-job');
  execFileSync('tmux', ['-L', TMUX_SOCKET, 'kill-session', '-t', 'webpi-itest-job']);
});

test('the jobs dialog validates against the shared schema: per-field errors, no request until valid', async ({ page }) => {
  await login(page);
  await page.goto('/jobs');
  await page.waitForFunction(() => customElements.get('validation-enhancer-zod') !== undefined);
  const saves: string[] = [];
  page.on('request', r => { if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/jobs') saves.push(r.url()); });
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
  expect(await page.locator('jobs-app .job wa-button[data-del="form-check"]').evaluate(
    el => el.shadowRoot?.querySelectorAll('[part~="base"]').length)).toBe(1);
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
  const dbCopy = `${WORKSPACE}/webpi-restart.db`;
  fs.copyFileSync(`${WORKSPACE}/webpi.db`, dbCopy);
  const backdate = Date.now() - 3 * 60_000;
  const w = new DatabaseSync(dbCopy);
  w.prepare("INSERT INTO jobs (name, schedule, command, created_at) VALUES ('itest-persist', '* * * * *', 'sleep 60', ?)")
    .run(backdate - 2 * 60_000);
  w.prepare("INSERT INTO job_runs (job, fired_at, origin) VALUES ('itest-persist', ?, 'schedule')")
    .run(backdate);
  w.close();

  // Second server, same workspace shape as the suite webServer (its own
  // port; the tmux socket and session command are shared).
  const PORT2 = 3471;
  const child = spawn('node', ['dist-server/server/main.js'], {
    env: {
      ...process.env,
      WEB_PI_PORT: String(PORT2),
      WEB_PI_HOST: '127.0.0.1',
      WEB_PI_DB_FILE: dbCopy,
      WEB_PI_SESSIONS_DIR: `${WORKSPACE}/sessions`,
      WEB_PI_AGENT_DIR: `${WORKSPACE}/pi-agent`,
      WEB_PI_NEW_SESSION_CWD: WORKSPACE,
      WEB_PI_TMUX_SOCKET: TMUX_SOCKET,
      WEB_PI_COMMAND: `${WORKSPACE}/cmd.sh`,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let bootLog = '';
  child.stderr!.setEncoding('utf8').on('data', (d: string) => { bootLog += d; });

  const sessions = () => {
    try {
      return execFileSync('tmux', ['-L', TMUX_SOCKET, 'list-sessions', '-F', '#{session_name}'],
        { encoding: 'utf8' });
    } catch { return ''; }
  };
  try {
    // Booted: the job survived the restart — listed by the new server.
    await expect.poll(async () => {
      try { return (await fetch(`http://127.0.0.1:${PORT2}/login`)).status; } catch { return 0; }
    }, { timeout: 20_000 }).toBe(200);
    const login2 = await fetch(`http://127.0.0.1:${PORT2}/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
    });
    const cookie = (login2.headers.get('set-cookie') ?? '').split(';')[0];
    const listed = await fetch(`http://127.0.0.1:${PORT2}/api/jobs`, { headers: { Cookie: cookie } });
    const state = await listed.json() as { jobs: Array<{ name: string }> };
    expect(state.jobs.map(j => j.name)).toContain('itest-persist');

    // Catch-up: the first scheduler tick (≤30s after boot) sees the missed
    // window and fires ONE run — a live webpi-<name> session on the socket.
    await expect.poll(sessions, { timeout: 45_000 }).toContain('webpi-itest-persist');

    // ...and the fire is recorded (newer than the backdated row, as catchup).
    const r = new DatabaseSync(dbCopy);
    const last = r.prepare("SELECT MAX(fired_at) AS last FROM job_runs WHERE job = 'itest-persist'")
      .get() as { last: number };
    const origins = r.prepare("SELECT DISTINCT origin FROM job_runs WHERE job = 'itest-persist'")
      .all() as Array<{ origin: string }>;
    r.close();
    expect(last.last!).toBeGreaterThan(backdate);
    expect(origins.map(o => o.origin)).toContain('catchup');
  } finally {
    child.kill('SIGKILL');
    await new Promise<void>(resolve => child.once('exit', () => resolve()));
    if (sessions().includes('webpi-itest-persist')) {
      execFileSync('tmux', ['-L', TMUX_SOCKET, 'kill-session', '-t', 'webpi-itest-persist']);
    }
    fs.rmSync(dbCopy, { force: true });
    if (bootLog && !/ExperimentalWarning/.test(bootLog)) console.log(`restart-server stderr:\n${bootLog}`);
  }
});

test('hide: session leaves the sidebar, manage dialog restores it', async ({ page }) => {
  await login(page);
  const row = page.locator(`session-sidebar li[data-resume="${FIXTURE_B}"]`);
  await expect(row).toContainText('refactor the tmux helpers');

  // The row action asks for confirmation before hiding.
  await row.locator('wa-button[data-hide]').click();
  const confirm = page.locator('wa-dialog#confirm-hide');
  await expect(confirm.locator('#confirm-hide-title')).toContainText('refactor the tmux helpers');
  await confirm.locator('wa-button#confirm-hide-ok').click();

  await expect(page.locator(`session-sidebar li[data-resume="${FIXTURE_B}"]`)).toHaveCount(0);
  await expect(page.locator('session-sidebar #session-list')).not.toContainText('refactor the tmux helpers');

  // "N hidden — manage" appears; the dialog (outside the poll-rendered
  // sidebar) lists the hidden session and unhides it.
  await expect(page.locator('session-sidebar wa-button#manage-hidden')).toContainText('1 hidden');
  await page.click('session-sidebar wa-button#manage-hidden');
  const dialog = page.locator('wa-dialog#hidden-dialog');
  await expect(dialog.locator('.hidden-row .t-name')).toContainText('refactor the tmux helpers');
  await dialog.locator('wa-button[data-unhide]').click();
  await expect(page.locator(`session-sidebar li[data-resume="${FIXTURE_B}"]`)).toHaveCount(1);
  await expect(page.locator('session-sidebar wa-button#manage-hidden')).toHaveCount(0);
});

test('hide persists across reload in the sqlite state db', async ({ page }) => {
  await login(page);
  await page.locator(`session-sidebar li[data-resume="${FIXTURE_B}"] wa-button[data-hide]`).click();
  await page.locator('wa-dialog#confirm-hide wa-button#confirm-hide-ok').click();
  await expect(page.locator(`session-sidebar li[data-resume="${FIXTURE_B}"]`)).toHaveCount(0);

  await page.reload();
  await page.waitForSelector('session-sidebar .nav');
  await expect(page.locator(`session-sidebar li[data-resume="${FIXTURE_B}"]`)).toHaveCount(0);
  await expect(page.locator('session-sidebar wa-button#manage-hidden')).toContainText('1 hidden');

  // The state db carries the id (hide ≠ delete: the fixture session file
  // is untouched).
  const db = new DatabaseSync(`${WORKSPACE}/webpi.db`);
  const hidden = db.prepare('SELECT session_id FROM sessions WHERE hidden_at IS NOT NULL').all() as Array<{ session_id: string }>;
  db.close();
  expect(hidden.map(r => r.session_id)).toContain(FIXTURE_B);
  expect(fs.existsSync(`${WORKSPACE}/sessions/alpha/2026-10-02T10-00-00_${FIXTURE_B}.jsonl`)).toBe(true);

  // Tidy via unhide-all so later tests see a clean list.
  await page.click('session-sidebar wa-button#manage-hidden');
  await page.locator('wa-dialog#hidden-dialog wa-button#unhide-all').click();
  await expect(page.locator(`session-sidebar li[data-resume="${FIXTURE_B}"]`)).toHaveCount(1);
});

test('search filters the past-session list and survives the poll re-render', async ({ page }) => {
  await login(page);
  const search = page.locator('wa-input#session-search input');

  // Title match: one row, one cwd group, count badge follows.
  await search.fill('login bug');
  await expect(page.locator('session-sidebar li[data-resume]')).toHaveCount(1);
  await expect(page.locator('session-sidebar li[data-resume]')).toContainText('fix the login bug');
  await expect(page.locator('session-sidebar li.group')).toHaveCount(1);
  await expect(page.locator('session-sidebar #sessions-count')).toHaveText('1');

  // cwd match and the empty state.
  await search.fill('/srv');
  await expect(page.locator('session-sidebar li[data-resume]')).toHaveCount(1);
  await expect(page.locator('session-sidebar li[data-resume]')).toContainText('deploy checklist review');
  await search.fill('zzz-no-match');
  await expect(page.locator('session-sidebar li.empty')).toContainText('no sessions match');

  // Escape clears.
  await search.press('Escape');
  await expect(page.locator('session-sidebar li[data-resume]')).toHaveCount(5);

  // A state poll re-render (the 15s interval, forced here) must not eat
  // the search box: value, focus and caret are restored.
  await search.fill('tmux');
  await page.keyboard.press('ArrowLeft'); // caret mid-string, not at the end
  const caretBefore = await page.evaluate(() => {
    const wa = document.querySelector('#session-search') as HTMLElement & { shadowRoot: ShadowRoot | null };
    return wa.shadowRoot?.querySelector('input')?.selectionStart ?? null;
  });
  expect(caretBefore).toBe(3);
  await page.evaluate(() =>
    (document.querySelector('console-app') as unknown as { loadState(): Promise<void> }).loadState());
  await page.waitForFunction(() => {
    const wa = document.querySelector('#session-search') as HTMLElement & { shadowRoot: ShadowRoot | null };
    const native = wa.shadowRoot?.querySelector('input') ?? null;
    // Focus inside an open shadow root retargets document.activeElement to
    // the host, so accept either the host or the inner input being focused.
    return native != null && native.value === 'tmux'
      && (document.activeElement === wa || wa.shadowRoot?.activeElement === native);
  });
  const caretAfter = await page.evaluate(() => {
    const wa = document.querySelector('#session-search') as HTMLElement & { shadowRoot: ShadowRoot | null };
    return wa.shadowRoot?.querySelector('input')?.selectionStart ?? null;
  });
  expect(caretAfter).toBe(caretBefore);
  // The filter is still applied after the re-render.
  await expect(page.locator('session-sidebar li[data-resume]')).toHaveCount(1);
});

test('signed out, any page URL serves the login page and sign-in returns to it', async ({ page }) => {
  // Regression: /jobs answered a bare "unauthorized" while / and /settings
  // rendered the login page.
  await page.goto('/jobs');
  await expect(page.locator('wa-input#username input')).toHaveCount(1);
  await signIn(page);
  await expect(page.locator('jobs-app .jobs-main')).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/jobs');
});

test('unauthenticated /settings serves the login page; settings APIs stay guarded', async ({ page, request }) => {
  await page.goto('/settings');
  await expect(page.locator('wa-input#username input')).toHaveCount(1);
  expect((await request.get('/api/settings')).status()).toBe(401);
  expect((await request.post('/api/update-pi', { data: {} })).status()).toBe(401);
  expect((await request.post('/api/auto-update-pi', { data: { enabled: true } })).status()).toBe(401);
});

test('settings dashboard shows effective config; update dry-run is check-only', async ({ page }) => {
  await login(page);
  // The global header bar's settings link is the way in.
  await expect(page.locator('app-header wa-button[href$="/settings"]')).toBeVisible();
  await page.goto('/settings');

  const cfg = page.locator('#config');
  await expect(cfg.locator('.cfg-row')).toHaveCount(12);
  const text = await cfg.innerText();
  expect(text).toContain('web-pi-itest');             // tmux socket (config env)
  expect(text).toContain('cmd.sh');                   // session command
  expect(text).toContain('/tmp/web-pi-itest/sessions'); // sessions dir
  expect(text).toContain('/tmp/web-pi-itest/webpi.db'); // state db path — path only, never contents
  await expect(page.locator('#pi-badge')).toContainText(/pi /);
  await expect(page.locator('#pi-declared')).toContainText('declared');

  // Check-only dry-run through the authed page — installs nothing.
  const dry = await page.evaluate(async () => {
    const r = await fetch('/api/update-pi', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"dryRun":true}',
    });
    return { status: r.status, body: await r.json() };
  });
  expect(dry.status).toBe(200);
  expect(dry.body.ok).toBe(true);
  expect(dry.body.dryRun).toBe(true);
  expect(dry.body.output).toContain('would run');
});

// ---- /api/state scan (async fs + title cache) over a populated store ----
// Bulk sessions for the scan tests: 205 valid two-line .jsonl files (session
// header + first user message) in their own scope, aged strictly between the
// two alpha fixtures (30 min and 24 h) so the newest-first order is
// unambiguous. 205 + 5 fixtures = 210 → the MAX_FILES=200 cap drops the 10
// oldest (the 4 older fixtures + bulk 199..204).
const BULK_SCOPE = 'bulk';
const BULK_COUNT = 205;
const CACHE_ID = 'dddddddd-dddd-4000-8000-dddddddddddd';
const bulkId = (i: number): string => `cccccccc-cccc-4000-8000-${(0xcafe00000000 + i).toString(16).padStart(12, '0')}`;
const bulkTitle = (i: number): string => `bulk task ${i.toString().padStart(3, '0')}: migrate the widget registry`;

/** One /api/state poll via in-page fetch → Map<id, {title, mtime}>. */
async function pollSessions(page: Page): Promise<Map<string, { title: string; mtime: number }>> {
  const rows = await page.evaluate(async () => {
    const r = await fetch('/api/state');
    const body = await r.json() as { sessions: Array<{ id: string; title: string; mtime: number }> };
    return { status: r.status, sessions: body.sessions.map(s => [s.id, s.title, s.mtime] as const) };
  });
  expect(rows.status).toBe(200);
  return new Map(rows.sessions.map(([id, title, mtime]) => [id as string, { title: title as string, mtime: mtime as number }]));
}

test('/api/state lists the fixture + bulk sessions newest-first with correct titles and the 200 cap', async ({ page }) => {
  const dir = path.join(WORKSPACE, 'sessions', BULK_SCOPE);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const now = Date.now();
  for (let i = 0; i < BULK_COUNT; i++) {
    const file = path.join(dir, `2026-10-02T12-30-00_${bulkId(i)}.jsonl`);
    fs.writeFileSync(file, [
      JSON.stringify({ type: 'session', id: bulkId(i), timestamp: '2026-10-02T12:30:00.000Z', cwd: '/home/tester/bulk-proj' }),
      JSON.stringify({ type: 'message', message: { role: 'user', content: bulkTitle(i) } }),
    ].join('\n') + '\n');
    const when = new Date(now - (40 + i * 5) * 60_000);
    fs.utimesSync(file, when, when);
  }

  // Junk tolerance: a corrupt binary and a >64 KiB first line must never
  // 500 the poll — both degrade to id = file name, '(no preview)'. They
  // share one mtime, pinning the filename tiebreaker too (concurrent
  // scope scans resolve in arbitrary order; ties need determinism).
  const JUNK = ['2026-10-02T12-30-00_junk-corrupt.jsonl', '2026-10-02T12-30-00_junk-hugefirst.jsonl'];
  fs.writeFileSync(path.join(dir, JUNK[0]), Buffer.from([0x00, 0xff, 0xfe, 0x81, 0x0a, 0x7f, 0x03]));
  fs.writeFileSync(path.join(dir, JUNK[1]),
    'x'.repeat(70 * 1024) + '\n' + JSON.stringify({ type: 'message', message: { role: 'user', content: 'never seen' } }) + '\n');
  const junkWhen = new Date(now - 5 * 60_000); // newest: inside the kept window
  for (const j of JUNK) fs.utimesSync(path.join(dir, j), junkWhen, junkWhen);

  await login(page);
  // The Map preserves the response's array order — assert on that, not a
  // client-side re-sort, so an unordered response can't pass.
  const sessions = [...(await pollSessions(page)).entries()].map(([id, e]) => ({ id, ...e }));

  // Capped at MAX_FILES=200: the two junk files (newest, 5 min), fixture A
  // (30 min) and bulk 0..196 (40 min … 1020 min).
  expect(sessions).toHaveLength(200);
  for (let i = 1; i < sessions.length; i++) {
    expect(sessions[i].mtime).toBeLessThanOrEqual(sessions[i - 1].mtime);
  }
  expect(sessions[0]).toMatchObject({ id: JUNK[0], title: '(no preview)' });
  expect(sessions[1]).toMatchObject({ id: JUNK[1], title: '(no preview)' });
  expect(sessions[2].id).toBe(FIXTURE_A);
  expect(sessions[2].title).toBe('fix the login bug in auth module');
  const keptBulk = 197; // 200 minus the junk pair and fixture A's slots
  for (let i = 0; i < keptBulk; i++) {
    expect(sessions[i + 3].id).toBe(bulkId(i));
    expect(sessions[i + 3].title).toBe(bulkTitle(i));
  }

  // The 12 oldest fell off the cap: the four older fixtures and the
  // oldest bulk files (197..204).
  const ids = new Set(sessions.map(s => s.id));
  for (const absent of [FIXTURE_B, '33333333-3333-3333-333333333333', ...UUIDV7_SIBLINGS,
    ...Array.from({ length: BULK_COUNT - keptBulk }, (_, k) => bulkId(keptBulk + k))]) {
    expect(ids.has(absent)).toBe(false);
  }
});

test('/api/state title cache: untouched files reuse their entry, an mtime bump re-reads', async ({ page }) => {
  await login(page);

  // A header-only session: no first user message yet → '(no preview)'.
  // Mtimes are pinned to whole seconds (utimes round-trips integer
  // seconds exactly): the coarse-mtime case, where each cache-key leg can
  // be isolated deterministically.
  const dir = path.join(WORKSPACE, 'sessions', 'cachetest');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `2026-10-02T13-00-00_${CACHE_ID}.jsonl`);
  const header = JSON.stringify({ type: 'session', id: CACHE_ID, timestamp: '2026-10-02T13:00:00.000Z', cwd: '/tmp/cache-check' });
  fs.writeFileSync(file, header + '\n');
  const T = Math.floor(Date.now() / 1000) * 1000 - 60_000;
  fs.utimesSync(file, new Date(T), new Date(T));

  const first = await pollSessions(page);
  expect(first.get(CACHE_ID)?.title).toBe('(no preview)');
  expect(first.get(CACHE_ID)!.mtime).toBe(T);

  // Size leg: append a first user message, then re-pin the mtime to the
  // SAME whole second — same mtime, grown file. Only the size half of the
  // (mtime, size) key notices; an mtime-only cache keeps serving the stale
  // title (the real case: an append landing inside the mtime tick on
  // coarse-mtime network storage).
  fs.appendFileSync(file, JSON.stringify({ type: 'message', message: { role: 'user', content: 'cache invalidation probe' } }) + '\n');
  fs.utimesSync(file, new Date(T), new Date(T));
  const second = await pollSessions(page);
  expect(second.get(CACHE_ID)?.title).toBe('cache invalidation probe');
  expect(second.get(CACHE_ID)!.mtime).toBe(T); // the served mtime really is unchanged

  // Mtime leg: same byte size, different whole-second mtime — rewrite the
  // message with a same-length title ('probe' → 'probF') and bump the mtime
  // one second. Only the mtime half of the key notices; a size-only cache
  // would keep serving the stale title.
  fs.writeFileSync(file, [
    header,
    JSON.stringify({ type: 'message', message: { role: 'user', content: 'cache invalidation probF' } }),
  ].join('\n') + '\n');
  fs.utimesSync(file, new Date(T + 1000), new Date(T + 1000));
  const third = await pollSessions(page);
  expect(third.get(CACHE_ID)?.title).toBe('cache invalidation probF');
  expect(third.get(CACHE_ID)!.mtime).toBe(T + 1000);

  // Untouched files answer identically across polls — cached, not re-derived.
  for (const [id, entry] of first) {
    if (id === CACHE_ID) continue;
    expect(third.get(id)).toEqual(entry);
  }

  fs.rmSync(dir, { recursive: true, force: true }); // gone before the next test's scan
});

test('/api/state poll stays fast and terminal traffic keeps flowing during it', async ({ page }) => {
  test.setTimeout(60_000);
  await login(page);

  // The cache-probe file from the previous test must have left the list.
  expect((await pollSessions(page)).has(CACHE_ID)).toBe(false);

  // Force the heavy path: bump every bulk mtime so the poll re-reads
  // ~200 files instead of being answered from the title cache.
  const dir = path.join(WORKSPACE, 'sessions', BULK_SCOPE);
  const names = fs.readdirSync(dir);
  const now = Date.now();
  const bump = (offset: number): void => {
    for (const [i, f] of names.entries()) {
      const when = new Date(now + offset + i * 1000);
      fs.utimesSync(path.join(dir, f), when, when);
    }
  };
  bump(0);

  const timed = await page.evaluate(async () => {
    const t0 = performance.now();
    const r = await fetch('/api/state');
    const body = await r.json() as { sessions: unknown[] };
    return { ms: performance.now() - t0, status: r.status, n: body.sessions.length };
  });
  expect(timed.status).toBe(200);
  expect(timed.n).toBe(200);
  expect(timed.ms).toBeLessThan(2000); // loose smoke: ~200 × 64 KiB reads, off the event loop

  // Liveness: keystrokes reach the pty and output renders while a poll is
  // in flight — the scan must never freeze the terminal WS. Bump the bulk
  // mtimes AGAIN first: the timed poll above left the cache warm, and a
  // liveness check against a warm cache proves nothing — this way the
  // concurrent poll re-reads ~200 files while the terminal is typing.
  bump(1000 * names.length);
  await page.fill('wa-input#new-name input', 'itest-poll-live');
  await page.click('wa-button#new-btn');
  await waitForTermText(page, MARKER, 20_000);
  await page.locator('agent-terminal .terminal-container').click();
  const poll = page.evaluate(async () => (await fetch('/api/state')).status);
  await page.keyboard.type('echo LIVE_$((40+2))\n');
  expect(await poll).toBe(200);
  await waitForTermText(page, 'LIVE_42', 10_000);

  // Tidy: drop the generated store so nothing after sees the bulk files.
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------- browser hardening (DESIGN_REVIEW §1.2) ----------

const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "connect-src 'self' wss:; frame-ancestors 'none'";

/** The four security headers every app-sent response carries. */
function expectSecurityHeaders(headers: Record<string, string>): void {
  expect(headers['content-security-policy']).toBe(CSP);
  expect(headers['x-frame-options']).toBe('DENY');
  expect(headers['x-content-type-options']).toBe('nosniff');
  expect(headers['referrer-policy']).toBe('same-origin');
}

test('non-GET requests with a foreign Origin are rejected; no Origin behaves normally', async ({ page, request }) => {
  await page.goto('/login'); // establish the suite origin for the page below
  // A present-but-mismatched Origin (sibling subdomain, sandboxed "null")
  // is 403 before auth is even consulted.
  for (const origin of ['https://evil.example', 'https://console.example.com', 'null']) {
    const r = await request.post('/api/session/hide', { headers: { Origin: origin }, data: { id: FIXTURE_A } });
    expect(r.status(), `Origin: ${origin}`).toBe(403);
  }
  // No Origin header at all (curl, API clients) and a matching Origin both
  // reach the normal auth gate — 401 here, this context has no session.
  expect((await request.post('/api/session/hide', { data: { id: FIXTURE_A } })).status()).toBe(401);
  const origin = new URL(page.url()).origin;
  expect((await request.post('/api/session/hide', { headers: { Origin: origin }, data: { id: FIXTURE_A } })).status()).toBe(401);

  // The browser path — a same-origin POST from an authed page — keeps
  // working (the browser attaches the page's own Origin).
  await login(page);
  expect(await page.evaluate(async () =>
    (await fetch('/api/session/unhide', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"all":true}',
    })).status)).toBe(200);
});

test('WS upgrades demand a matching Origin — missing or foreign destroys the socket', async ({ page }) => {
  await login(page);
  const token = (await page.context().cookies()).find(c => c.name === 'webpi_session')?.value ?? '';
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
        try { ws.close(); } catch { /* never opened */ }
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
  expect(await attempt({ Origin: wsOrigin, Cookie: `webpi_session=${token}` })).toBe('open');

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
    const ws = new NodeWebSocket(`${wsOrigin.replace(/^http/, 'ws')}/ws`, { headers: { Origin: wsOrigin } });
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

test('console/jobs/settings load requests nothing off-origin and glyphs render from the app itself', async ({ page }) => {
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
    page.waitForFunction(() => {
      const icons = [...document.querySelectorAll('wa-icon')];
      return icons.length > 0 && icons.every(i => i.shadowRoot?.querySelector('svg') != null);
    }, null, { timeout: 8000 }).then(() => true, () => false);

  await page.goto('/');
  await page.waitForSelector('session-sidebar .nav');
  expect(await glyphsRender()).toBe(true);
  for (const p of ['/jobs', '/settings']) {
    await page.goto(p);
    expect(await glyphsRender(), `${p} glyphs`).toBe(true);
  }
  expect(external).toEqual([]);
});

test('logout ends live terminal sockets: signed-out message, no reconnect', async ({ page }) => {
  await login(page);
  await page.fill('wa-input#new-name input', 'itest-signout');
  await page.click('wa-button#new-btn');
  await waitForTermText(page, MARKER, 20_000);
  await expect(page.locator('.terminal-status.ok')).toContainText('attached: itest-signout');

  // Keep the page on the console while its session dies: the sidebar poll
  // (and the terminal-closed re-poll) would otherwise 401 → /login.
  await page.route('**/api/state', route => route.fulfill({
    json: { me: 'ok', configured: true, live: [], sessions: [], hiddenCount: 0 },
  }));

  // Protocol: a second socket on the same cookie sees 'signed-out' and
  // then the close — in that order.
  const events = page.evaluate(async () => {
    const ws = new WebSocket(`ws://${location.host}/ws`);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    const seen = new Promise<string[]>(resolve => {
      const log: string[] = [];
      ws.onmessage = ev => log.push('msg:' + (JSON.parse(ev.data as string) as { type: string }).type);
      ws.onclose = () => { log.push('close'); resolve(log); };
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
  await expect.poll(() => page.evaluate(() =>
    (document.querySelector('agent-terminal') as unknown as { websocket?: WebSocket }).websocket
    === undefined)).toBe(true);
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
  const state = (p: Page): Promise<number> =>
    p.evaluate(async () => (await fetch('/api/state')).status);
  expect(await state(page)).toBe(401);
  expect(await state(page2)).toBe(401);
  await ctx2.close();

  sessionCookie = null; // both tokens are dead
});

test('SIGTERM: every socket gets restart, closes, and the process exits 0', async ({ browser }) => {
  test.setTimeout(60_000); // boots its own server + browser session before the signal
  // The suite's webServer is managed by Playwright — spawn our own
  // short-lived server instead (suite env pattern from playwright.config,
  // own port + tmp dir so nothing collides with the shared instance).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webpi-sigterm-'));
  const dbFile = path.join(dir, 'webpi.db');
  expect(setCredential(new StateDb(dbFile), USERNAME, PASSWORD).ok).toBe(true);
  const port = 3481;
  // Per-run socket: a server left over from an interrupted run would hold
  // the sig-live session name and /api/new would 409.
  const tmuxSocket = `webpi-itest-sig-${process.pid}`;
  const child = spawn(process.execPath, ['dist-server/server/main.js'], {
    env: {
      ...process.env,
      WEB_PI_PORT: String(port),
      WEB_PI_HOST: '127.0.0.1',
      WEB_PI_DB_FILE: dbFile,
      WEB_PI_SESSIONS_DIR: path.join(dir, 'sessions'),
      WEB_PI_AGENT_DIR: path.join(dir, 'pi-agent'),
      WEB_PI_NEW_SESSION_CWD: dir,
      WEB_PI_TMUX_SOCKET: tmuxSocket,
      WEB_PI_COMMAND: '/bin/sh',
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
      } catch { /* not listening yet */ }
      if (Date.now() > up) throw new Error('spawned server did not come up');
      await new Promise(r => setTimeout(r, 100));
    }

    // Login on the spawned server (its own limiter — the shared budget
    // is untouched) and open one authenticated socket.
    const login = await fetch(`http://127.0.0.1:${port}/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
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

    // And one real console page attached to a session: the client must
    // treat 'restart' as reconnectable (unlike 'exit'/'error') — it says
    // so and starts its backoff instead of going dark.
    await page.goto(`http://127.0.0.1:${port}/login`);
    await signIn(page);
    await page.waitForURL(u => u.pathname === '/');
    await page.fill('wa-input#new-name input', 'sig-live');
    await page.click('wa-button#new-btn');
    await expect(page.locator('.terminal-status.ok')).toContainText('attached: sig-live', { timeout: 20_000 });

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
    await expect(page.locator('.terminal-status')).toContainText('server restarting', { timeout: 5000 });
    await expect(page.locator('.terminal-status')).toContainText('reconnecting in', { timeout: 5000 });

    expect(await exited).toBe(0);
    expect(Date.now() - killed).toBeLessThan(7000); // ~5s drain deadline + slack
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    try { ws?.close(); } catch { /* already gone */ }
    await ctx.close();
    try { execFileSync('tmux', ['-L', tmuxSocket, 'kill-server'], { stdio: 'ignore' }); }
    catch { /* no server was started — fine */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('auto-update setting: default OFF, toggle persists across reload, status lines render', async ({ page }) => {
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
  expect(html).toContain(`${WORKSPACE}/webpi.db`);
  expect(html).toContain('not checked yet');
  await page.goto('/settings');

  // The switch upgraded client-side (SSR ≠ client imports — AGENTS.md).
  await page.waitForFunction(() =>
    typeof (document.querySelector('wa-switch#pi-auto-update') as unknown as
      { checked?: boolean })?.checked === 'boolean');
  const isChecked = (): Promise<boolean> =>
    page.evaluate(() => (document.querySelector('wa-switch#pi-auto-update') as unknown as
      { checked: boolean }).checked);
  const control = page.locator('wa-switch#pi-auto-update [part="control"]');

  // Fresh db (global-setup recreated the workspace): default OFF, both in
  // the UI and on the API, with the never-checked status lines rendered.
  expect(await isChecked()).toBe(false);
  await expect(page.locator('#auto-check-line')).toContainText('not checked yet');
  await expect(page.locator('#auto-update-line')).toContainText('no auto-update has run yet');
  expect((await api(page, 'GET', '/api/settings')).json.piAutoUpdate).toMatchObject({ enabled: false });

  // Toggle ON through the real control.
  await control.click();
  await expect.poll(async () =>
    (await api(page, 'GET', '/api/settings')).json.piAutoUpdate.enabled).toBe(true);
  const db = new DatabaseSync(`${WORKSPACE}/webpi.db`);
  const setting = () => (db.prepare(
    "SELECT value FROM settings WHERE key = 'piAutoUpdate.enabled'").get() as
    { value: string }).value;
  expect(setting()).toBe('1');

  // Persisted across a reload: the switch renders ON from /api/settings.
  await page.reload();
  await page.waitForFunction(() =>
    (document.querySelector('wa-switch#pi-auto-update') as unknown as
      { checked?: boolean })?.checked === true);
  await expect(page.locator('#auto-check-line')).toContainText('not checked yet');

  // The API validates its (deliberately trivial) body.
  expect((await api(page, 'POST', '/api/auto-update-pi', { enabled: 'yes' })).status).toBe(400);
  expect((await api(page, 'POST', '/api/auto-update-pi', {})).status).toBe(400);

  // Toggle back OFF — clean state, nothing scheduled for the rest of
  // the suite.
  await control.click();
  await expect.poll(async () =>
    (await api(page, 'GET', '/api/settings')).json.piAutoUpdate.enabled).toBe(false);
  expect(setting()).toBe('0');
  db.close();
});

test('the editor stays absent when unconfigured (task/ws-editor)', async ({ page, request }) => {
  // This suite never sets WEB_PI_EDITOR_UPSTREAM, so the sidebar must
  // render no open-in-editor affordances, /api/state reports editor:
  // false, and the same-origin proxy fails closed: /editor/ answers 404
  // signed in (the editor profile isn't deployed) and 401 unsigned in —
  // it is a data route, never a page, so no login shell either. The
  // cookieless leg uses Playwright's API client, which never sends the
  // Secure session cookie over this plain-http origin (AGENTS.md).
  await login(page);
  await expect(page.locator('session-sidebar [data-editor]')).toHaveCount(0);
  expect((await api(page, 'GET', '/api/state')).json.editor).toBe(false);

  expect((await page.goto('/editor/'))?.status()).toBe(404);
  expect((await page.goto('/editor/stable-abc/out/vs/code/browser/workbench/workbench.js'))?.status()).toBe(404);

  expect((await request.get('/editor/')).status()).toBe(401);
});

test('deep link ?t=<uuid> attaches the terminal tab; an unknown uuid degrades to the error status (task/ws-terminal)', async ({ page }) => {
  // Runs before the rate-limit test (last). The shared webServer spawns
  // the suite's cmd.sh on the webpi-itest socket; the terminal-mode WS
  // attach (plan §4/§7) is exercised through the real page wiring:
  // console-app's pendingTerminal → agent-terminal attach('terminal').
  await login(page);
  const cwd = `${WORKSPACE}/t-deep-link`;
  fs.mkdirSync(cwd, { recursive: true });
  const wsMade = await api(page, 'POST', '/api/workspaces', { name: 'deep link', cwd });
  expect(wsMade.status).toBe(200);
  const made = await api(page, 'POST', `/api/workspaces/${wsMade.json.id}/terminals`, {});
  expect(made.status).toBe(200);
  expect(made.json.live).toBe(true);
  const id = made.json.id as string;

  // The deep link opens the tab's terminal directly (terminal tabs UI is
  // branch 4's): attached to the derived t-<uuid> session, banner shown.
  await page.goto(`/?t=${id}`);
  await expect(page.locator('.terminal-status')).toContainText(`attached: t-${id}`);
  await waitForTermText(page, MARKER);

  // Graceful degradation: a well-formed uuid that is not ours is a dead
  // end shown in the status line — the page stays up, nothing respawns.
  await page.goto('/?t=99999999-9999-4999-8999-999999999999');
  await expect(page.locator('.terminal-status')).toContainText('no such terminal');

  // Cleanup: close the tab (row + best-effort session kill) and the
  // workspace, so later state reads (and the Live list) are unchanged.
  expect((await api(page, 'DELETE', `/api/terminals/${id}`)).status).toBe(200);
  expect((await api(page, 'DELETE', `/api/workspaces/${wsMade.json.id}`)).status).toBe(200);
});

test('login rate limit kicks in (10 per 15 min per IP) and ignores a spoofed X-Forwarded-For', async ({ request }) => {
  // Runs last: earlier tests already spent part of the shared budget.
  // Every attempt claims a different client IP. The server runs with
  // WEB_PI_TRUST_PROXY unset (0), so the header must be ignored and every
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
