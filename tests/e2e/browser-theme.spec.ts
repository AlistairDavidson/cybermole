// Light/dark follows the browser's prefers-color-scheme on every page: the
// wa-dark/wa-light class, per-mode surfaces, color-scheme, the theme-color
// metas, a live flip re-theming a live terminal pane, and the editor pane
// reloading on a flip.
//
// Sorts before e2e.spec.ts, whose last test exhausts the shared login
// budget; signs in once. The editor test boots a private server with the
// editor upstream at a dead port, so the tab and pane exist and the iframe
// gets 502s. External navigation is blocked.
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, test, type Cookie, type Page } from '@playwright/test';
import { PASSWORD, USERNAME } from '../support/env';

// ---------- shared server ----------

const modeState = (page: Page) =>
  page.evaluate(() => {
    const cls = document.documentElement.classList;
    const cs = getComputedStyle(document.documentElement);
    const meta = (media: string): string =>
      document
        .querySelector(`meta[name="theme-color"][media="${media}"]`)
        ?.getAttribute('content') ?? '';
    return {
      dark: cls.contains('wa-dark'),
      light: cls.contains('wa-light'),
      bodyBg: getComputedStyle(document.body).backgroundColor,
      colorScheme: cs.colorScheme,
      metaDark: meta('(prefers-color-scheme: dark)'),
      metaLight: meta('(prefers-color-scheme: light)'),
    };
  });

/** The first call signs in through the form; later calls reuse the cookie. */
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

test.describe('browser scheme dark', () => {
  test.use({ colorScheme: 'dark' });

  test('console: html.wa-dark, the dark brand surface, color-scheme and both theme-color metas', async ({
    page,
  }) => {
    await login(page);
    await expect
      .poll(async () => (await modeState(page)).dark, {
        timeout: 15_000,
      })
      .toBe(true);
    const state = await modeState(page);
    expect(state.light).toBe(false);
    // the dark surface (#11131a)
    expect(state.bodyBg).toBe('rgb(17, 19, 26)');
    expect(state.colorScheme).toBe('dark');
    // one meta per mode
    expect(state.metaDark).toBe('#11131a');
    expect(state.metaLight).toBe('#e1e2e7');
  });

  test('login and offline shells render the same mode (every page is Base)', async ({ page }) => {
    // /login and /offline render through Base.astro too. The script runs
    // before first paint, but tolerate its first load racing the assert.
    await page.goto('/login');
    await expect.poll(async () => (await modeState(page)).dark).toBe(true);
    expect((await modeState(page)).bodyBg).toBe('rgb(17, 19, 26)');
    await page.goto('/offline');
    await expect.poll(async () => (await modeState(page)).dark).toBe(true);
  });
});

test.describe('browser scheme light', () => {
  test.use({ colorScheme: 'light' });

  test('console: html.wa-light and the light brand surface', async ({ page }) => {
    await login(page); // cookie reuse — no second POST /login
    await expect.poll(async () => (await modeState(page)).light).toBe(true);
    const state = await modeState(page);
    expect(state.dark).toBe(false);
    // the light surface (#e1e2e7)
    expect(state.bodyBg).toBe('rgb(225, 226, 231)');
    expect(state.colorScheme).toBe('light');
  });
});

test.describe('live scheme flip', () => {
  test.use({ colorScheme: 'dark' });

  test("a live flip flips the class and the attached pane's xterm theme", async ({ page }) => {
    await login(page);
    await expect(page.locator('agent-terminal:not(.hidden) .terminal-status')).toContainText(
      'attached',
      { timeout: 15_000 },
    );
    // Built from the resolved mode (dark bg).
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const el = document.querySelector('agent-terminal:not(.hidden)') as unknown as {
            terminal?: { options: { theme: { background?: string } } };
          };
          return el.terminal?.options.theme.background ?? '';
        }),
      )
      .toBe('#11131a');

    // A live flip: the theme-boot listener flips the class, and the
    // terminal's observer re-themes the pane.
    await page.emulateMedia({ colorScheme: 'light' });
    await expect.poll(async () => (await modeState(page)).light).toBe(true);
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const el = document.querySelector('agent-terminal:not(.hidden)') as unknown as {
            terminal?: { options: { theme: { background?: string } } };
          };
          return el.terminal?.options.theme.background ?? '';
        }),
      )
      .toBe('#e1e2e7');
    expect((await modeState(page)).bodyBg).toBe('rgb(225, 226, 231)');

    // and back again, no reload
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect.poll(async () => (await modeState(page)).dark).toBe(true);
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const el = document.querySelector('agent-terminal:not(.hidden)') as unknown as {
            terminal?: { options: { theme: { background?: string } } };
          };
          return el.terminal?.options.theme.background ?? '';
        }),
      )
      .toBe('#11131a');
  });
});

// ---------- private server: the editor pane ----------

const ROOT = path.resolve(__dirname, '..', '..');
const PORT = 3487; // clear of the shared :3470 and the specs' 3471–3486
const BASE = `http://127.0.0.1:${PORT}`;

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

/** The editor upstream points at a dead port: configured, so the tab and
 *  pane render, but the iframe gets 502s. Only its src and reload are
 *  asserted. */
async function spawnServer(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cybermole-theme-'));
  server = { cookie: '', dir };
  const pw = spawnSync('node', ['dist-server/server/set-password.js'], {
    cwd: ROOT,
    input: `${USERNAME}\n${PASSWORD}\n${PASSWORD}\n`,
    env: bareEnv({ CYBERMOLE_PORT: '0', CYBERMOLE_STATE_DIR: dir }),
  });
  expect(pw.status, pw.stderr?.toString()).toBe(0);

  const next = spawn('node', ['dist-server/server/main.js'], {
    cwd: ROOT,
    env: bareEnv({
      CYBERMOLE_PORT: String(PORT),
      CYBERMOLE_HOST: '127.0.0.1',
      CYBERMOLE_STATE_DIR: dir,
      CYBERMOLE_APPS_SOCK: '',
      // configured, but nothing listens
      CYBERMOLE_EDITOR_UPSTREAM: 'http://127.0.0.1:1',
      CYBERMOLE_NEW_SESSION_CWD: dir,
    }),
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

  const login = await fetch(`${BASE}/login`, {
    method: 'POST',
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
  });
  expect(login.status).toBe(200);
  server.cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  expect(server.cookie).toContain('cybermole_session=');
}

test.beforeAll(async () => {
  await spawnServer();
});

test.afterAll(async () => {
  const c = child;
  if (c && c.exitCode === null && c.signalCode === null) {
    c.kill('SIGTERM');
    await new Promise<void>(resolve => {
      if (c.exitCode !== null || c.signalCode !== null) return resolve();
      c.once('exit', () => resolve());
      setTimeout(() => c.kill('SIGKILL'), 5_000).unref();
    });
  }
  if (server) fs.rmSync(server.dir, { recursive: true, force: true });
});

test.describe('editor pane (private server, dead upstream)', () => {
  test.use({ colorScheme: 'dark' });

  test('the editor pane opens at the workspace folder, and a mode flip reloads it', async ({
    page,
  }) => {
    // Nothing may leave the loopback.
    await page.route('**/*', route => {
      const host = new URL(route.request().url()).hostname;
      if (host === '127.0.0.1' || host === 'localhost') return route.continue();
      return route.abort();
    });

    // A workspace via the routes (the pane under test is the editor tab).
    const ws = await fetch(`${BASE}/api/workspaces`, {
      method: 'POST',
      headers: { cookie: server!.cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'theme', cwd: server!.dir }),
    });
    expect(ws.status).toBe(200);

    await page.context().addCookies([
      {
        name: 'cybermole_session',
        value: server!.cookie.split('=').slice(1).join('='),
        url: BASE,
      },
    ]);
    await page.goto(`${BASE}/`);
    await page.waitForSelector('workspace-sidebar .nav');

    await page.click('button.tab.editor-tab');
    const frame = page.locator('iframe.editor-frame');
    await expect(frame).toBeVisible();
    // ...opens the folder through the proxy, with no theme param: the
    // workbench ignores one. Mode-following is the proxy's injected
    // defaults plus the reload below.
    await expect
      .poll(async () =>
        page.evaluate(
          () =>
            (document.querySelector('iframe.editor-frame') as HTMLIFrameElement | null)?.src ?? '',
        ),
      )
      .toContain(`/editor/?folder=${encodeURIComponent(server!.dir)}`);

    // A flip reloads the iframe; count its loads across the flip.
    await page.evaluate(() => {
      const frame = document.querySelector('iframe.editor-frame');
      if (!frame) return;
      (window as unknown as { __editorLoads?: number }).__editorLoads = 0;
      frame.addEventListener('load', () => {
        (window as unknown as { __editorLoads: number }).__editorLoads += 1;
      });
    });
    await page.emulateMedia({ colorScheme: 'light' });
    await expect.poll(async () => (await modeState(page)).light, { timeout: 15_000 }).toBe(true);
    await expect
      .poll(
        async () =>
          page.evaluate(() => (window as unknown as { __editorLoads?: number }).__editorLoads ?? 0),
        { timeout: 15_000 },
      )
      .toBeGreaterThan(0);
    // ...with the src unchanged.
    await expect
      .poll(async () =>
        page.evaluate(
          () =>
            (document.querySelector('iframe.editor-frame') as HTMLIFrameElement | null)?.src ?? '',
        ),
      )
      .toContain(`/editor/?folder=${encodeURIComponent(server!.dir)}`);
  });
});
