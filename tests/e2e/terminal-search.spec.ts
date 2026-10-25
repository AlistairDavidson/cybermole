// The attach-time scrollback backfill and the Ctrl+F find bar, against a
// private server (own port, db and login, so the shared suite's budget and
// socket are untouched). Its sessions must survive page reloads.
//
// tmux.conf keeps the client out of the alternate screen (smcup@/rmcup@)
// and out of scroll-by-N (indn@: xterm.js discards SU-scrolled rows), so
// live output accumulates scrollback. Bursty output still coalesces in the
// live view; the backfill heals that, since it reads tmux's own history.
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, test, type Cookie, type Page } from '@playwright/test';

const ROOT = path.resolve(__dirname, '..', '..');
const PORT = 3486; // clear of the shared :3470, the specs' 3471–3485, S3's 3490
const BASE = `http://127.0.0.1:${PORT}`;
const USERNAME = 'tester';
const PASSWORD = 'correct-horse-9';
const MARKER = 'TS_MARKER_READY';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** The machine's and suite's CYBERMOLE_ / PI_CODING_AGENT_ settings must not leak in. */
function bareEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith('CYBERMOLE_') && !k.startsWith('PI_CODING_AGENT'))
      env[k] = v;
  }
  return { ...env, ...extra };
}

let server: { cookie: string; dir: string } | null = null;
let child: ReturnType<typeof spawn> | null = null;
const SOCKET = 'cybermole-itest-tsearch';
const childEnv = () =>
  bareEnv({
    CYBERMOLE_PORT: String(PORT),
    CYBERMOLE_HOST: '127.0.0.1',
    CYBERMOLE_STATE_DIR: server!.dir,
    CYBERMOLE_APPS_SOCK: '',
    CYBERMOLE_TMUX_SOCKET: SOCKET,
    CYBERMOLE_NEW_SESSION_CWD: os.tmpdir(),
    CYBERMOLE_COMMAND: path.join(server!.dir, 'cmd.sh'),
    // deterministic agent command (never asserted here)
    CYBERMOLE_AGENT_COMMAND: path.join(server!.dir, 'cmd.sh'),
  });

/** Resolves once it listens. */
async function spawnServer(): Promise<void> {
  const next = spawn('node', ['dist-server/server/main.js'], {
    cwd: ROOT,
    env: childEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let boot = '';
  next.stdout!.on('data', (d: Buffer) => {
    boot += d.toString();
  });
  next.stderr!.on('data', (d: Buffer) => {
    boot += d.toString();
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`server did not boot; output: ${boot}`)),
      15_000,
    );
    next.stdout!.on('data', () => {
      if (boot.includes('cybermole listening')) {
        clearTimeout(timer);
        resolve();
      }
    });
    next.on('error', reject);
  });
  child = next;
}

/** SIGTERM (every WS gets 'restart') and wait for the exit. */
async function stopServer(): Promise<void> {
  const c = child;
  if (!c || c.exitCode !== null || c.signalCode !== null) return;
  c.kill('SIGTERM');
  await new Promise<void>(resolve => {
    if (c.exitCode !== null || c.signalCode !== null) return resolve();
    c.once('exit', () => resolve());
    setTimeout(() => c.kill('SIGKILL'), 10_000).unref();
  });
}

test.afterAll(async () => {
  await stopServer();
  try {
    spawnSync('tmux', ['-L', SOCKET, 'kill-server'], { stdio: 'ignore' });
  } catch {
    /* gone */
  }
  if (server) fs.rmSync(server.dir, { recursive: true, force: true });
});

/** Boot once for the file. */
test.beforeAll(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cybermole-ts-'));
  const cmd = path.join(dir, 'cmd.sh');
  fs.writeFileSync(cmd, `#!/bin/sh\necho '${MARKER}'\nexec /bin/sh\n`);
  fs.chmodSync(cmd, 0o755);
  server = { cookie: '', dir };

  const pw = spawnSync('node', ['dist-server/server/set-password.js'], {
    cwd: ROOT,
    input: `${USERNAME}\n${PASSWORD}\n${PASSWORD}\n`,
    env: bareEnv({ CYBERMOLE_PORT: '0', CYBERMOLE_STATE_DIR: dir }),
  });
  expect(pw.status, pw.stderr?.toString()).toBe(0);

  await spawnServer();

  const login = await fetch(`${BASE}/login`, {
    method: 'POST',
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
  });
  expect(login.status).toBe(200);
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  expect(cookie).toContain('cybermole_session=');
  server = { cookie, dir };
});

async function api(
  method: string,
  url: string,
  body?: unknown,
): // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the parsed body, callers narrow it
Promise<{ status: number; json: any }> {
  const r = await fetch(`${BASE}${url}`, {
    method,
    headers: {
      cookie: server!.cookie,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}

/** The session spawns at the workspace cwd. */
async function makeTerminal(name: string): Promise<{ ws: string; id: string }> {
  const ws = await api('POST', '/api/workspaces', { name, cwd: server!.dir });
  expect(ws.status, JSON.stringify(ws.json)).toBe(200);
  const term = await api('POST', `/api/workspaces/${ws.json.id}/terminals`, {});
  expect(term.status, JSON.stringify(term.json)).toBe(200);
  expect(term.json.id).toMatch(UUID_RE);
  return { ws: ws.json.id, id: term.json.id };
}

/** Trimmed lines of the visible pane's buffer. */
function bufferLines(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const el = document.querySelector('agent-terminal:not(.hidden)') as unknown as {
      terminal?: {
        buffer: {
          active: {
            length: number;
            getLine(i: number): { translateToString(trimRight?: boolean): string } | undefined;
          };
        };
      };
    };
    const buf = el?.terminal?.buffer.active;
    if (!buf) return [];
    const lines: string[] = [];
    for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? '');
    return lines;
  });
}

/** A duplicated backfill or redraw pushes this past 1. */
async function countExactLine(page: Page, line: string): Promise<number> {
  const lines = await bufferLines(page);
  return lines.filter(l => l === line).length;
}

async function waitForTermLine(page: Page, line: string, timeout = 10_000): Promise<void> {
  await page.waitForFunction(
    want => {
      const el = document.querySelector('agent-terminal:not(.hidden)') as unknown as {
        terminal?: {
          buffer: {
            active: {
              length: number;
              getLine(i: number): { translateToString(trimRight?: boolean): string } | undefined;
            };
          };
        };
      };
      const buf = el?.terminal?.buffer.active;
      if (!buf) return false;
      for (let i = 0; i < buf.length; i++) {
        if ((buf.getLine(i)?.translateToString(true) ?? '') === want) return true;
      }
      return false;
    },
    line,
    { timeout },
  );
}

function bufferShape(page: Page): Promise<{ len: number; rows: number; type: string }> {
  return page.evaluate(() => {
    const el = document.querySelector('agent-terminal:not(.hidden)') as unknown as {
      terminal: { rows: number; buffer: { active: { length: number; type: string } } };
    };
    return {
      len: el.terminal.buffer.active.length,
      rows: el.terminal.rows,
      type: el.terminal.buffer.active.type,
    };
  });
}

/** The first call signs in through the form; later calls reuse the cookie. */
let sessionCookie: Cookie | null = null;
async function openTerminal(page: Page, id: string): Promise<void> {
  if (!sessionCookie) {
    await page.goto(`${BASE}/login`);
    await page.fill('wa-input#username input', USERNAME);
    await page.fill('wa-input#password input', PASSWORD);
    await page.click('wa-button:has-text("sign in")');
    await page.waitForURL(u => u.pathname === '/');
    sessionCookie =
      (await page.context().cookies()).find(c => c.name === 'cybermole_session') ?? null;
    expect(sessionCookie).not.toBeNull();
  } else {
    await page.context().addCookies([sessionCookie]);
  }
  await page.goto(`${BASE}/?t=${id}`);
  await page.waitForSelector('agent-terminal:not(.hidden) .terminal-container .xterm');
  await expect(page.locator('agent-terminal:not(.hidden) .terminal-status')).toContainText(
    'attached',
    { timeout: 15_000 },
  );
}

/** A missing n means lost history; a doubled n, a screen painted twice. */
async function expectSeqOnceEach(page: Page): Promise<void> {
  const lines = await bufferLines(page);
  for (let n = 1; n <= 60; n++) {
    const want = String(n);
    const got = lines.filter(l => l === want).length;
    expect(got, `line "${want}" must appear exactly once (got ${got})`).toBe(1);
  }
  const markers = lines.filter(l => l.includes(MARKER)).length;
  expect(markers, 'the cmd.sh banner must appear exactly once').toBe(1);
}

/** The first line not present exactly once, or null. Used as the settle
 *  poll's value so a timeout names the offender. */
function firstSeqViolation(lines: string[]): string | null {
  for (let n = 1; n <= 60; n++) {
    const want = String(n);
    const got = lines.filter(l => l === want).length;
    if (got !== 1) return `line "${want}" must appear exactly once (got ${got})`;
  }
  const markers = lines.filter(l => l.includes(MARKER)).length;
  if (markers !== 1) return `the cmd.sh banner must appear exactly once (got ${markers})`;
  return null;
}

/** Seeing '1' only proves the backfill landed: the redraw below it can
 *  still be parsing, and a sample in between reads a mid-screen line as 0.
 *  So poll the full condition; a genuine double or loss never heals and
 *  times out. */
async function waitForSeqOnceEach(page: Page, timeout = 10_000): Promise<void> {
  await expect.poll(async () => firstSeqViolation(await bufferLines(page)), { timeout }).toBe(null);
}

test('backfill: reload brings the scrollback back under the redraw — nothing doubled, nothing lost', async ({
  page,
}) => {
  const { id } = await makeTerminal('backfill');
  await openTerminal(page, id);
  await waitForTermLine(page, MARKER);

  // 60 lines into a ~40-row terminal must push the buffer past one screen.
  await page.click('agent-terminal:not(.hidden) .terminal-container');
  await page.keyboard.type('seq 1 60\n');
  await waitForTermLine(page, '60');
  const live = await bufferShape(page);
  expect(live.type).toBe('normal');
  expect(live.len, 'live output must grow the buffer past one screen').toBeGreaterThan(live.rows);

  // After a reload, '1' only exists in history, so seeing it is the
  // backfill; each line exactly once proves the redraw landed below the
  // history rather than over it.
  await page.reload();
  await page.waitForSelector('agent-terminal:not(.hidden) .terminal-container .xterm');
  await expect(page.locator('agent-terminal:not(.hidden) .terminal-status')).toContainText(
    'attached',
    { timeout: 15_000 },
  );
  await waitForTermLine(page, '1');
  // Settle before the one-shot assert.
  await waitForSeqOnceEach(page);
  await expectSeqOnceEach(page);

  // A second reload: still exactly one copy of each line.
  await page.reload();
  await page.waitForSelector('agent-terminal:not(.hidden) .terminal-container .xterm');
  await expect(page.locator('agent-terminal:not(.hidden) .terminal-status')).toContainText(
    'attached',
    { timeout: 15_000 },
  );
  await waitForTermLine(page, '1');
  await waitForSeqOnceEach(page); // every reload races the same settle
  await expectSeqOnceEach(page);
});

test('backfill is skipped on reconnect (buffer already holds the session) — no duplicate history', async ({
  page,
}) => {
  const { id } = await makeTerminal('reconnect');
  await openTerminal(page, id);
  await waitForTermLine(page, MARKER);

  // Slow output: every line lands in the live buffer.
  await page.click('agent-terminal:not(.hidden) .terminal-container');
  await page.keyboard.type('for i in $(seq 1 20); do echo RELINE_$i; sleep 0.15; done\n');
  await waitForTermLine(page, 'RELINE_20', 20_000);
  for (let n = 1; n <= 20; n++) {
    expect(await countExactLine(page, `RELINE_${n}`), `RELINE_${n} once before the drop`).toBe(1);
  }

  // After a server restart the session survives and the terminal reconnects
  // onto the same element, keeping its buffer, so the reattach's backfill
  // must be ignored or every line doubles.
  await stopServer();
  await expect(page.locator('agent-terminal:not(.hidden) .terminal-status')).toContainText(
    'reconnect',
    { timeout: 10_000 },
  );
  await spawnServer();
  await expect(page.locator('agent-terminal:not(.hidden) .terminal-status')).toContainText(
    'attached',
    { timeout: 30_000 },
  );
  await waitForTermLine(page, 'RELINE_1');
  for (let n = 1; n <= 20; n++) {
    expect(
      await countExactLine(page, `RELINE_${n}`),
      `RELINE_${n} still exactly once after the reattach`,
    ).toBe(1);
  }
  expect(await countExactLine(page, MARKER), 'the banner must not double either').toBe(1);
});

test('find bar: ctrl+F searches the (backfilled) scrollback, Esc refocuses the terminal, the query survives pane switches', async ({
  page,
}) => {
  const { ws, id } = await makeTerminal('findbar');
  await openTerminal(page, id);
  await waitForTermLine(page, MARKER);

  // Matches pushed into history, then a reload so they only exist via the backfill.
  await page.click('agent-terminal:not(.hidden) .terminal-container');
  await page.keyboard.type('echo alpha_one; echo alpha_two; seq 1 60\n');
  await waitForTermLine(page, '60');
  await page.reload();
  await page.waitForSelector('agent-terminal:not(.hidden) .terminal-container .xterm');
  await expect(page.locator('agent-terminal:not(.hidden) .terminal-status')).toContainText(
    'attached',
    { timeout: 15_000 },
  );
  await waitForTermLine(page, 'alpha_one');

  // Hidden until Ctrl+F.
  const pane = page.locator('agent-terminal:not(.hidden)');
  const findBar = pane.locator('.terminal-find');
  await expect(pane.locator('.terminal-toolbar')).toBeVisible();
  await expect(findBar).toHaveClass(/hidden/);

  // Ctrl+F opens it while focus is in the terminal (xterm's hidden textarea).
  await page.keyboard.press('Control+f');
  await expect(findBar).not.toHaveClass(/hidden/);
  const input = findBar.locator('wa-input input');
  await expect(input).toBeFocused();

  // alpha_* is above the screen: a live search must scroll up to it.
  const viewportBefore = await page.evaluate(
    () =>
      (
        document.querySelector('agent-terminal:not(.hidden)') as unknown as {
          terminal: { buffer: { active: { viewportY: number } } };
        }
      ).terminal.buffer.active.viewportY,
  );
  await page.keyboard.type('alpha');
  await expect
    .poll(
      async () =>
        page.evaluate(
          () =>
            (
              document.querySelector('agent-terminal:not(.hidden)') as unknown as {
                terminal: { buffer: { active: { viewportY: number } } };
              }
            ).terminal.buffer.active.viewportY,
        ),
      { timeout: 5000 },
    )
    .toBeLessThan(viewportBefore);

  // Enter / Shift+Enter step through matches; focus stays in the input.
  await page.keyboard.press('Enter');
  await page.keyboard.press('Shift+Enter');
  await expect(input).toBeFocused();
  expect(
    await findBar
      .locator('wa-input')
      .evaluate(el => (el as unknown as { value: string | null }).value),
  ).toBe('alpha');

  // Esc closes and refocuses the terminal.
  await page.keyboard.press('Escape');
  await expect(findBar).toHaveClass(/hidden/);
  await expect(pane.locator('.terminal-container .xterm-helper-textarea')).toBeFocused();

  // Not hijacked while a real input (the sidebar filter) has focus.
  await page.fill('workspace-sidebar wa-input#workspace-search input', 'find');
  await page.keyboard.press('Control+f');
  await expect(findBar).toHaveClass(/hidden/);

  // The query survives a pane switch (module state, not DOM).
  const second = await api('POST', `/api/workspaces/${ws}/terminals`, {});
  expect(second.status).toBe(200);
  // force the 15 s poll
  await page.evaluate(async () => {
    await (
      document.querySelector('console-app') as unknown as { loadState(): Promise<void> }
    ).loadState();
  });
  await page.waitForSelector(`terminal-tabs .tab[data-term="${second.json.id}"]`, {
    timeout: 10_000,
  });
  await page.click(`terminal-tabs .tab[data-term="${second.json.id}"]`);
  await expect(page.locator('agent-terminal:not(.hidden) .terminal-status')).toContainText(
    'attached',
    { timeout: 15_000 },
  );
  await page.keyboard.press('Control+f');
  await expect(page.locator('agent-terminal:not(.hidden) .terminal-find')).not.toHaveClass(
    /hidden/,
  );
  expect(
    await page
      .locator('agent-terminal:not(.hidden) .terminal-find wa-input')
      .evaluate(el => (el as unknown as { value: string | null }).value),
  ).toBe('alpha');
});
