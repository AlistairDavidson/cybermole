// terminal-search.spec.ts — task/terminal-search, end to end against the
// compiled server: the attach-time scrollback backfill (capture-pane
// history → the 'backfill' frame, written into the fresh buffer UNDER the
// attach redraw) and the Ctrl+F find bar (@xterm/addon-search behind the
// .terminal-toolbar cluster), including the don't-hijack-real-inputs rule
// and the query surviving pane switches.
// Non-page-boot specs share the terminal-ws.spec pattern: its own server
// child on its own port + db + login, so the serial suite's shared login
// budget and tmux socket are untouched; the node:sqlite ExperimentalWarning
// in the set-password boot output is expected (AGENTS.md).
//
// Scrollback mechanics under test (verified against a real browser
// terminal): tmux.conf's terminal-overrides keep the attached client out
// of the alternate screen (smcup@/rmcup@) and out of scroll-by-N (indn@ —
// xterm.js's SU handler DISCARDS scrolled rows instead of pushing them
// into scrollback), so live output accumulates scrollback. Bursty output
// still coalesces in the client view (tmux's screen-diff skips lines for
// any outer terminal, real xterm included) — which is exactly what the
// attach backfill heals: after a reload the buffer holds the pane's full
// history, each line exactly once, with the redraw's screen below it.
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, test, type Cookie, type Page } from '@playwright/test';

const ROOT = path.resolve(__dirname, '..');
const PORT = 3486; // clear of the shared :3470, the specs' 3471–3485, S3's 3490
const BASE = `http://127.0.0.1:${PORT}`;
const USERNAME = 'tester';
const PASSWORD = 'correct-horse-9';
const MARKER = 'TS_MARKER_READY';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Child env with the CYBERMOLE_ / PI_CODING_AGENT_ overrides stripped: the
 *  values under test must not see this machine's (or the suite
 *  webServer's) explicit settings. */
function bareEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith('CYBERMOLE_') && !k.startsWith('PI_CODING_AGENT')) env[k] = v;
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
    CYBERMOLE_TMUX_SOCKET: SOCKET,
    CYBERMOLE_NEW_SESSION_CWD: os.tmpdir(),
    CYBERMOLE_COMMAND: path.join(server!.dir, 'cmd.sh'),
  });

/** Boot the server child (beforeAll, and again by the restart test) —
 *  resolves once it listens. */
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

/** SIGTERM the server child (its graceful shutdown: every WS gets
 *  'restart') and wait for the process to be gone. */
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

/** Boot the private server once for the file: the deterministic cmd.sh
 *  banner + a shell we type into, exactly like the shared suite's
 *  fixture. terminal-ws.spec's bootServer, minus the per-test socket
 *  lifecycle (this spec wants its sessions to SURVIVE page reloads). */
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

/** One JSON call against the private server (node fetch + cookie: this
 *  spec's pages are on this origin anyway). */
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

/** A workspace + one terminal row through the real routes; the session
 *  spawns (fork-to-start socket) at the workspace cwd. */
async function makeTerminal(name: string): Promise<{ ws: string; id: string }> {
  const ws = await api('POST', '/api/workspaces', { name, cwd: server!.dir });
  expect(ws.status, JSON.stringify(ws.json)).toBe(200);
  const term = await api('POST', `/api/workspaces/${ws.json.id}/terminals`, {});
  expect(term.status, JSON.stringify(term.json)).toBe(200);
  expect(term.json.id).toMatch(UUID_RE);
  return { ws: ws.json.id, id: term.json.id };
}

/** The visible pane's buffer as exact (trimmed) lines. */
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

/** How many buffer lines are EXACTLY `line` — the doubling probe: a
 *  duplicated backfill or redraw would push this past 1. */
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

/** The visible pane's buffer length + rows (live-scrollback proof). */
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

/** Land on the console with a workspace's terminal tab attached. The
 *  first call signs in through the real form (this server's own login
 *  budget); later calls reuse that cookie in the (fresh per test)
 *  context — the shared-suite convention. */
let sessionCookie: Cookie | null = null;
async function openTerminal(page: Page, id: string): Promise<void> {
  if (!sessionCookie) {
    await page.goto(`${BASE}/login`);
    await page.fill('wa-input#username input', USERNAME);
    await page.fill('wa-input#password input', PASSWORD);
    await page.click('wa-button:has-text("sign in")');
    await page.waitForURL(u => u.pathname === '/');
    sessionCookie = (await page.context().cookies()).find(c => c.name === 'cybermole_session') ?? null;
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

/** Every n of `seq 1 60` appears exactly once as a whole line — the
 *  backfill dedupe proof: a missing n means history was lost, a doubled n
 *  means the screen was painted twice (backfill overlapping the redraw). */
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

/** The first exact-once violation in `lines` — null when every line of
 *  the seq 1 60 and the banner sit in the buffer exactly once. The
 *  settle poll's value: a timeout surfaces it as the Received line,
 *  naming the first offender, while expectSeqOnceEach above stays the
 *  one-shot reporter (every line, its own precise message). */
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

/** Wait for a reloaded buffer to SETTLE. waitForTermLine('1') proves
 *  only that the backfill history landed: xterm.js parses writes in
 *  chunks on its own cadence, so the attach redraw that repaints the
 *  current screen BELOW that history can still be in flight, and a
 *  one-shot sample taken between the two reads a mid-screen line
 *  ('24') as 0 — the transient the churn probes flaked on, not a lost
 *  line. Poll the full exact-once condition instead (expect.poll
 *  retries a bad value, not a thrown callback): a genuine double cannot
 *  heal (it stays 2 forever → timeout, the first offender named) and a
 *  genuinely lost line times out the same way — expectSeqOnceEach
 *  after it still walks every line for the complete message. */
async function waitForSeqOnceEach(page: Page, timeout = 10_000): Promise<void> {
  await expect.poll(async () => firstSeqViolation(await bufferLines(page)), { timeout }).toBe(null);
}

test('backfill: reload brings the scrollback back under the redraw — nothing doubled, nothing lost', async ({
  page,
}) => {
  const { id } = await makeTerminal('backfill');
  await openTerminal(page, id);
  await waitForTermLine(page, MARKER);

  // Live scrollback accumulates while attached (tmux.conf's indn@ override
  // — xterm.js discards SU-scrolled rows, so tmux must scroll with LFs):
  // 60 lines into a ~40-row terminal must push the buffer past one screen.
  await page.click('agent-terminal:not(.hidden) .terminal-container');
  await page.keyboard.type('seq 1 60\n');
  await waitForTermLine(page, '60');
  const live = await bufferShape(page);
  expect(live.type).toBe('normal');
  expect(live.len, 'live output must grow the buffer past one screen').toBeGreaterThan(live.rows);

  // Reload: fresh buffer, the server captures the pane's history and
  // writes it as the backfill BEFORE the attach redraw flows. Line "1"
  // only exists in history — it coming back is the backfill; each line
  // exactly once is the dedupe (the capture stops above the screen, the
  // client pads the viewport down, the redraw repaints the screen BELOW
  // the history instead of over it). Bursty output that coalesced in the
  // live view (tmux's screen-diff) is healed here too — the capture reads
  // tmux's own history, which is complete.
  await page.reload();
  await page.waitForSelector('agent-terminal:not(.hidden) .terminal-container .xterm');
  await expect(page.locator('agent-terminal:not(.hidden) .terminal-status')).toContainText(
    'attached',
    { timeout: 15_000 },
  );
  await waitForTermLine(page, '1');
  // '1' proves the backfill landed; the redraw under it can still be in
  // flight this early — settle before the one-shot assert.
  await waitForSeqOnceEach(page);
  await expectSeqOnceEach(page);

  // A second reload: same proof against a history that now includes
  // everything — still exactly one copy of each line.
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

  // Slow, line-per-tick output: no coalescing, every line lands in the
  // live buffer — the complete-history baseline the reconnect keeps.
  await page.click('agent-terminal:not(.hidden) .terminal-container');
  await page.keyboard.type('for i in $(seq 1 20); do echo RELINE_$i; sleep 0.15; done\n');
  await waitForTermLine(page, 'RELINE_20', 20_000);
  for (let n = 1; n <= 20; n++) {
    expect(await countExactLine(page, `RELINE_${n}`), `RELINE_${n} once before the drop`).toBe(1);
  }

  // Server restart (deploy/container stop — the graceful shutdown tells
  // every WS 'restart'): the pane's tmux session SURVIVES (the tmux server
  // is its own process), the page's terminal reconnects with its usual
  // backoff onto the SAME element — the buffer is kept, so the reattach's
  // backfill frame must be ignored (a second copy of the history would
  // double every line).
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

  // Searchable scrollback: distinct matches, then enough output to push
  // them into history, then a RELOAD so they only exist via the backfill.
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

  // The toolbar + find bar exist and stay hidden until Ctrl+F.
  const pane = page.locator('agent-terminal:not(.hidden)');
  const findBar = pane.locator('.terminal-find');
  await expect(pane.locator('.terminal-toolbar')).toBeVisible();
  await expect(findBar).toHaveClass(/hidden/);

  // Ctrl+F opens the bar (the terminal pane is the active context —
  // focus is in the terminal, xterm's own hidden textarea).
  await page.keyboard.press('Control+f');
  await expect(findBar).not.toHaveClass(/hidden/);
  const input = findBar.locator('wa-input input');
  await expect(input).toBeFocused();

  // Live search: typing a query whose matches are in the BACKFILLED
  // history (alpha_* is above the screen) must scroll the viewport up.
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

  // Enter steps to the next match, Shift+Enter back — no crash, focus
  // stays in the find input.
  await page.keyboard.press('Enter');
  await page.keyboard.press('Shift+Enter');
  await expect(input).toBeFocused();
  expect(
    await findBar
      .locator('wa-input')
      .evaluate(el => (el as unknown as { value: string | null }).value),
  ).toBe('alpha');

  // Esc closes the bar and hands focus back to the terminal.
  await page.keyboard.press('Escape');
  await expect(findBar).toHaveClass(/hidden/);
  await expect(pane.locator('.terminal-container .xterm-helper-textarea')).toBeFocused();

  // Ctrl+F is NOT hijacked while a real input has focus (the sidebar's
  // workspace filter): the find bar stays closed.
  await page.fill('workspace-sidebar wa-input#workspace-search input', 'find');
  await page.keyboard.press('Control+f');
  await expect(findBar).toHaveClass(/hidden/);

  // The query survives pane switches: module-level state, not DOM. A
  // second terminal in the same workspace, its pane opened by clicking
  // the tab, gets the previous pane's query prefilled.
  const second = await api('POST', `/api/workspaces/${ws}/terminals`, {});
  expect(second.status).toBe(200);
  // the console's own state-refresh path (the 15 s poll, forced)
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
