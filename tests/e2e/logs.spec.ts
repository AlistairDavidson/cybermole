// /logs and its header link exist only with CYBERMOLE_GRAFANA_URL set. Two
// private servers: one without it, one pointing at a dead port. The
// iframe's navigation is aborted, so only the page's own markup is asserted.
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

/** The machine's and suite's CYBERMOLE_ / PI_CODING_AGENT_ settings must not leak in. */
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
  /** name=value, planted per page context */
  cookie: string;
}

/** Own state dir and tmux socket; the credential is set through the CLI,
 *  then one JSON login (this server's own budget). */
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
    // No logs section on any page.
    await expect(page.locator('app-header wa-button[href$="/logs"]')).toHaveCount(0);
    await page.goto(`${BASE}/settings`);
    await expect(page.locator('app-header wa-button[href$="/logs"]')).toHaveCount(0);
    // The rest of the header still works.
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
  // Abort every request to Grafana's origin, so the iframe never leaves the test.
  await page.route(`${GRAFANA}/**`, route => route.abort());
  const server = await bootServer({ CYBERMOLE_GRAFANA_URL: GRAFANA });
  try {
    await signIn(page, server);
    const link = page.locator('app-header wa-button[href$="/logs"]');
    await expect(link).toBeVisible();
    // The nav is icon-only; the label rides the title (the Icons wave).
    await expect(link).toHaveAttribute('title', 'Logs');
    await expect(link.locator('wa-icon')).toHaveAttribute('name', 'file-lines');
    // The vendored glyph renders (this page's icon is only pinned here).
    await page.waitForFunction(
      () =>
        document
          .querySelector('app-header wa-button[href$="/logs"] wa-icon')
          ?.shadowRoot?.querySelector('svg') != null,
      undefined,
      { timeout: 8000 },
    );
    // A real anchor: click through.
    await link.click();
    await page.waitForURL(u => u.pathname === '/logs');
    const iframe = page.locator('.logs-main iframe');
    await expect(iframe).toBeVisible();
    await expect(iframe).toHaveAttribute('title', 'Grafana Explore — cybermole logs');
    await expect(iframe).toHaveAttribute('allow', 'fullscreen');
    // The Explore URL: v1 panes payload, Loki preselected.
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
    // The page's CSP widens frame-src to exactly Grafana's origin.
    const res = await page.goto(`${BASE}/logs`);
    expect(res?.status()).toBe(200);
    expect(res?.headers()['content-security-policy']).toContain(`frame-src ${GRAFANA}`);
    await page.goto(`${BASE}/jobs`);
    await expect(page.locator('app-header wa-button[href$="/logs"]')).toBeVisible();
    await expect(page.locator('jobs-app')).toBeVisible();
  } finally {
    await stopServer(server);
  }
});
