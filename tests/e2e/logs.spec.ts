// logs.spec.ts — task/logs-page: the /logs page and its header link exist
// ONLY when CYBERMOLE_GRAFANA_URL is configured. Non-page spec (restart /
// state-dir / terminal-search pattern): spawns its OWN server children on
// its own port — each with its own state dir, tmux socket and login
// rate-limit budget — one without the var (feature off) and one with it
// pointing at a port nothing listens on (grafana is not part of the test
// environment; the iframe's navigation is route-aborted, so the page is
// asserted on its own markup, never on Grafana reaching the browser).
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { PASSWORD, USERNAME } from '../support/env';

const ROOT = path.resolve(__dirname, '..', '..');
const PORT = 3491; // clear of the shared :3470 webServer and the other specs' children
const BASE = `http://127.0.0.1:${PORT}`;
// Grafana-shaped and unreachable: only the URL string is under test.
const GRAFANA = 'http://127.0.0.1:3599';

/** Child env with the CYBERMOLE_ / PI_CODING_AGENT_ overrides stripped. */
function bareEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith('CYBERMOLE_') && !k.startsWith('PI_CODING_AGENT'))
      env[k] = v;
  }
  return { ...env, ...extra };
}

interface PrivateServer {
  child: ChildProcess;
  dir: string;
  /** the signed-in session cookie (name=value) — planted per page context */
  cookie: string;
}

/** Boot one private server (own state dir + tmux socket), set the
 *  credential through the CLI an operator runs (stdin, like
 *  terminal-search's beforeAll — the db the fresh server just opened),
 *  and sign in ONCE through the JSON login: this process's own
 *  rate-limit budget, like every private-server spec. */
async function bootServer(env: Record<string, string> = {}): Promise<PrivateServer> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cybermole-logs-'));
  const pw = spawnSync('node', ['dist-server/server/set-password.js'], {
    cwd: ROOT,
    input: `${USERNAME}\n${PASSWORD}\n${PASSWORD}\n`,
    env: bareEnv({ CYBERMOLE_PORT: '0', CYBERMOLE_STATE_DIR: dir }),
  });
  expect(pw.status, pw.stderr?.toString()).toBe(0);
  const child = spawn('node', ['dist-server/server/main.js'], {
    cwd: ROOT,
    env: bareEnv({
      CYBERMOLE_PORT: String(PORT),
      CYBERMOLE_HOST: '127.0.0.1',
      CYBERMOLE_STATE_DIR: dir,
      // task/app-web: this spec's server doesn't exercise the apps surface
      // — empty CYBERMOLE_APPS_SOCK keeps the single-user spawn rule from
      // starting a supervised app host beside this boot.
      CYBERMOLE_APPS_SOCK: '',
      CYBERMOLE_TMUX_SOCKET: `cybermole-logs-itest-${process.pid}`,
      ...env,
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`server did not boot; stdout: ${out}`)),
      15_000,
    );
    child.stdout!.on('data', (d: Buffer) => {
      out += d.toString();
      if (out.includes('cybermole listening')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on('error', reject);
  });
  const login = await fetch(`${BASE}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
  });
  expect(login.status).toBe(200);
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  expect(cookie).toContain('cybermole_session=');
  return { child, dir, cookie };
}

async function stopServer(server: PrivateServer): Promise<void> {
  if (server.child.exitCode === null && server.child.signalCode === null) {
    server.child.kill('SIGTERM');
    await new Promise<void>(resolve => {
      server.child.once('exit', () => resolve());
      setTimeout(() => server.child.kill('SIGKILL'), 5_000).unref(); // wedged-child backstop
    });
  }
  fs.rmSync(server.dir, { recursive: true, force: true });
}

/** The signed-in console in `page`'s context (this server's own cookie). */
async function signIn(page: Page, server: PrivateServer): Promise<void> {
  const [name, value] = server.cookie.split('=');
  await page.context().addCookies([{ name: name!, value: value!, url: BASE }]);
  await page.goto(`${BASE}/`);
  await page.waitForSelector('workspace-sidebar .nav');
}

test('CYBERMOLE_GRAFANA_URL unset: no logs link anywhere, /logs answers 404', async ({ page }) => {
  const server = await bootServer();
  try {
    await signIn(page, server);
    // The section does not exist at all — on any page.
    await expect(page.locator('app-header wa-button[href$="/logs"]')).toHaveCount(0);
    await page.goto(`${BASE}/settings`);
    await expect(page.locator('app-header wa-button[href$="/logs"]')).toHaveCount(0);
    // The other sections still navigate (the header itself is intact).
    await expect(page.locator('app-header wa-button[href$="/jobs"]')).toBeVisible();
    const res = await page.goto(`${BASE}/logs`);
    expect(res?.status()).toBe(404);
    expect(await res?.text()).toBe('not found');
  } finally {
    await stopServer(server);
  }
});

test('CYBERMOLE_GRAFANA_URL set: header link + /logs iframe on Grafana Explore', async ({
  page,
}) => {
  // Grafana is not there (and must not be): abort every request to the
  // configured origin so the iframe's navigation never leaves the test.
  await page.route(`${GRAFANA}/**`, route => route.abort());
  const server = await bootServer({ CYBERMOLE_GRAFANA_URL: GRAFANA });
  try {
    await signIn(page, server);
    const link = page.locator('app-header wa-button[href$="/logs"]');
    await expect(link).toBeVisible();
    await expect(link).toContainText('logs');
    await expect(link.locator('wa-icon')).toHaveAttribute('name', 'file-lines');
    // The vendored glyph itself renders (the shared glyphs test covers /,
    // /jobs, /settings — this page's icon is only pinned here): a missing
    // public/icons/wa/solid/file-lines.svg would upgrade to nothing.
    await page.waitForFunction(
      () =>
        document
          .querySelector('app-header wa-button[href$="/logs"] wa-icon')
          ?.shadowRoot?.querySelector('svg') != null,
      undefined,
      { timeout: 8000 },
    );
    // A real anchor: click through the UI (works unupgraded too).
    await link.click();
    await page.waitForURL(u => u.pathname === '/logs');
    const iframe = page.locator('.logs-main iframe');
    await expect(iframe).toBeVisible();
    await expect(iframe).toHaveAttribute('title', 'Grafana Explore — cybermole logs');
    await expect(iframe).toHaveAttribute('allow', 'fullscreen');
    // The server-built Explore URL: v1 panes payload, Loki preselected
    // (src/lib/grafana.ts; shape pinned against grafana 13.2.3).
    const src = await iframe.getAttribute('src');
    expect(src).toBeTruthy();
    const u = new URL(src!);
    expect(u.origin).toBe(GRAFANA);
    expect(u.pathname).toBe('/explore');
    expect(u.searchParams.get('schemaVersion')).toBe('1');
    const panes = JSON.parse(u.searchParams.get('panes')!) as Record<
      string,
      { datasource?: string }
    >;
    expect(Object.values(panes).at(-1)?.datasource).toBe('cybermole-loki');
    // The page's own CSP widens frame-src to exactly the configured
    // Grafana origin (the global CSP would refuse the cross-origin frame).
    const res = await page.goto(`${BASE}/logs`);
    expect(res?.status()).toBe(200);
    expect(res?.headers()['content-security-policy']).toContain(`frame-src ${GRAFANA}`);
    // Pages keep working with the var set — the other sections included.
    await page.goto(`${BASE}/jobs`);
    await expect(page.locator('app-header wa-button[href$="/logs"]')).toBeVisible();
    await expect(page.locator('jobs-app')).toBeVisible();
  } finally {
    await stopServer(server);
  }
});
