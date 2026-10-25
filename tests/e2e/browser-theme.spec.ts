// browser-theme.spec.ts — task/theme-browser, end to end against the
// compiled app: the global light/dark mode follows the BROWSER
// (prefers-color-scheme, emulated by Playwright) on every page — the
// wa-dark/wa-light class the blocking theme-boot script sets, the two
// per-mode brand surfaces, color-scheme, the two theme-color metas, a LIVE
// scheme flip flipping the class and the xterm theme of a live pane, and
// the editor iframe pane (src + reload on flip).
//
// File name sorts BEFORE e2e.spec.ts on purpose: that file's LAST test
// exhausts the shared server's login rate-limit budget on purpose, so any
// spec signing in against the shared webServer must run before it. This
// file signs in through the real form exactly ONCE (the login() helper
// pattern) and reuses the cookie for its other shared-server tests. The
// editor-pane test boots its own private server (the terminal-ws.spec
// pattern: own port + db + login budget) with the editor upstream pointed
// at a dead port — editor "configured" (the tab and pane exist, which is
// what the assertions need) without a real VSCodium; the proxy answers 502
// into the iframe and nothing is asserted of its content. External
// navigation is blocked at the route level (hermeticity).
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, test, type Cookie, type Page } from '@playwright/test';
import { PASSWORD, USERNAME } from '../support/env';

// ---------- shared server (the suite webServer, :3470) ----------

/** The root element's mode classes + the surfaces/metas that follow them. */
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

/** Lands on the signed-in console. The FIRST call signs in through the real
 *  login form (one POST /login — the shared budget); later calls reuse the
 *  session cookie, the e2e.spec login() convention. */
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
    // the dark brand surface (console.css html.wa-dark: #11131a)
    expect(state.bodyBg).toBe('rgb(17, 19, 26)');
    expect(state.colorScheme).toBe('dark');
    // both metas, one per mode, carrying the two surfaces
    expect(state.metaDark).toBe('#11131a');
    expect(state.metaLight).toBe('#e1e2e7');
  });

  test('login and offline shells render the same mode (every page is Base)', async ({ page }) => {
    // /login is pre-auth, /offline the PWA shell — both render through
    // Base.astro, so the same blocking script and classes apply. The
    // blocking script must run before first paint, so no poll is needed —
    // but tolerate the script's first load racing the assert.
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
    // the light brand surface (console.css html.wa-light: #e1e2e7,
    // the Tokyo-Night Day counterpart)
    expect(state.bodyBg).toBe('rgb(225, 226, 231)');
    expect(state.colorScheme).toBe('light');
  });
});

test.describe('live scheme flip', () => {
  test.use({ colorScheme: 'dark' });

  test("a live flip flips the class and the attached pane's xterm theme", async ({ page }) => {
    await login(page);
    // The auto-selected fixture tab is a live session: the pane attaches.
    await expect(page.locator('agent-terminal:not(.hidden) .terminal-status')).toContainText(
      'attached',
      { timeout: 15_000 },
    );
    // The pane's theme was built from the resolved mode (dark brand bg).
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

    // LIVE flip: emulateMedia changes matchMedia inside the page, the
    // theme-boot listener flips the classes, and the agent-terminal class
    // observer re-themes the live pane at runtime.
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

    // and back — the flip is repeatable, no reload involved
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

// ---------- private server: the editor pane follows the mode ----------

const ROOT = path.resolve(__dirname, '..', '..');
const PORT = 3487; // clear of the shared :3470 and the specs' 3471–3486
const BASE = `http://127.0.0.1:${PORT}`;

/** Child env with the CYBERMOLE_ / PI_CODING_AGENT_ overrides stripped: the
 *  values under test must not see this machine's (or the suite webServer's)
 *  explicit settings. */
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

/** Boot the private server once for the file — same shape as
 *  terminal-ws.spec's bootServer, but the editor upstream points at a DEAD
 *  port: the editor is "configured" (the console renders its tab and
 *  pane), while the proxy answers 502 into the iframe. The assertions are
 *  about the pane's src and its reload on a mode flip, never its content.
 *  The node:sqlite ExperimentalWarning in the set-password output is
 *  expected (AGENTS.md). */
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
      // task/app-web: this spec's server doesn't exercise the apps surface
      // — empty CYBERMOLE_APPS_SOCK keeps the single-user spawn rule from
      // starting a supervised app host beside this boot.
      CYBERMOLE_APPS_SOCK: '',
      // the editor upstream: configured (editor: true in the state the
      // console polls) but nothing listens — dead-on-arrival 502s only.
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
    // Hermeticity: nothing this page loads may leave the loopback — the
    // editor iframe boots only local URLs (and here gets 502s), but a
    // guard makes that an invariant instead of an assumption.
    await page.route('**/*', route => {
      const host = new URL(route.request().url()).hostname;
      if (host === '127.0.0.1' || host === 'localhost') return route.continue();
      return route.abort();
    });

    // One console workspace (no terminals needed — the pane under test is
    // the editor tab), through the real routes.
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

    // The editor tab (rendered because the state's editor flag is on)...
    await page.click('button.tab.editor-tab');
    const frame = page.locator('iframe.editor-frame');
    await expect(frame).toBeVisible();
    // ...opens the workspace folder through the same-origin proxy. NO
    // theme parameter — VERIFIED against the vendored reh-web build: the
    // workbench parses only folder/workspace/ew from the URL, so a
    // ?theme= would be dead weight; the mode-following mechanism is the
    // proxy's configurationDefaults injection (src/lib/editor.ts) plus
    // this pane's reload-on-flip below.
    await expect
      .poll(async () =>
        page.evaluate(
          () =>
            (document.querySelector('iframe.editor-frame') as HTMLIFrameElement | null)?.src ?? '',
        ),
      )
      .toContain(`/editor/?folder=${encodeURIComponent(server!.dir)}`);

    // A live scheme flip reloads the iframe (the workbench reads the
    // browser scheme at boot; the console's class observer re-navigates
    // the pane). Count the frame's loads across the flip.
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
    // ...and the src is unchanged by the flip (the folder is still the
    // folder; there is no per-mode src to carry).
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
