// management.spec.ts — the /management page against the real built app:
// SSR + partial refresh, the enforcement verdict surfacing BEFORE any
// verb, and the API guards (re-auth, origin gate, the refusal itself).
//
// Non-page specs that need dedicated server-side state spawn their OWN
// server children on their own port (restart.spec.ts / state-dir / split
// pattern) — this one does too, and it MUST: it runs after e2e.spec.ts,
// whose login-rate-limit test (runs last there) spends the shared :3470
// webServer's whole per-IP login budget, so a form sign-in against the
// shared instance would 429 here. The child has its own budget, its own
// state db, and the management env below.
//
// The fixture: a real git repo as the "workspace checkout" (base commit
// = the version.json we plant for the image), so preview/build exercise
// real git, the real -z parser and the real protected-set matching. No
// builder sidecar runs here: build stops at the pending marker (asserted
// on disk), and activate is only tested on its refusal paths — a real
// activation restarts the server, and process-lifecycle coverage belongs
// to tests/restart.spec.ts. The marker/swap halves are unit-tested in
// tests/unit/releases.test.mjs.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, test, type Cookie, type Page } from '@playwright/test';
import { setCredential } from '../src/lib/auth';
import { StateDb } from '../src/lib/db';
import { PASSWORD, USERNAME, WORKSPACE } from './env';

const ROOT = path.resolve(__dirname, '..');
const PORT = 3484; // clear of the shared :3470 and the specs' own 3471–3483
const BASE = `http://127.0.0.1:${PORT}`;
const CHECKOUT = path.join(WORKSPACE, 'mgmt-checkout');
const RELEASES = path.join(WORKSPACE, 'mgmt-releases');
const STATE = fs.mkdtempSync(path.join(os.tmpdir(), 'webpi-mgmt-'));
// The child's APP_ROOT is the repo (dist-server/src/lib/env.ts) — the
// "image's" baked version lives there (gitignored; removed in afterAll).
const VERSION_FILE = path.join(ROOT, 'version.json');

let BASE_SHA = '';
let CLEAN_SHA = '';
let EVIL_SHA = '';
let child: ChildProcess | null = null;

/** One git call in the fixture checkout. */
function git(cmd: string[], cwd = CHECKOUT): string {
  return execFileSync('git', cmd, { cwd }).toString().trim();
}

/** Child env with the WEB_PI_ / PI_CODING_AGENT_ overrides stripped. */
function bareEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith('WEB_PI_') && !k.startsWith('PI_CODING_AGENT')) env[k] = v;
  }
  return { ...env, ...extra };
}

test.beforeAll(() => {
  // The fixture checkout: a real git repo whose base commit carries the
  // protected files (like the real repo does).
  fs.rmSync(CHECKOUT, { recursive: true, force: true });
  fs.rmSync(RELEASES, { recursive: true, force: true });
  fs.mkdirSync(CHECKOUT, { recursive: true });
  const run = (cmd: string[]) => { execFileSync('git', cmd, { cwd: CHECKOUT, stdio: 'ignore' }); };
  run(['init', '-q', '-b', 'main']);
  run(['config', 'user.email', 't@t']);
  run(['config', 'user.name', 't']);
  for (const f of ['compose.yaml', 'Dockerfile', 'server/main.ts', 'src/lib/releases.ts', 'package.json']) {
    fs.mkdirSync(path.dirname(path.join(CHECKOUT, f)), { recursive: true });
    fs.writeFileSync(path.join(CHECKOUT, f), `# ${f}\n`);
  }
  fs.writeFileSync(path.join(CHECKOUT, 'README.md'), 'base\n');
  run(['add', '-A']);
  run(['commit', '-q', '-m', 'base']);
  BASE_SHA = git(['rev-parse', 'HEAD']);
  fs.writeFileSync(path.join(CHECKOUT, 'README.md'), 'clean target\n');
  run(['add', '-A']);
  run(['commit', '-q', '-m', 'clean target']);
  CLEAN_SHA = git(['rev-parse', 'HEAD']);
  fs.writeFileSync(path.join(CHECKOUT, 'compose.yaml'), 'evil: true\n');
  run(['add', '-A']);
  run(['commit', '-q', '-m', 'evil target']);
  EVIL_SHA = git(['rev-parse', 'HEAD']);
  // The image's baked version names the base commit (the trusted diff root)
  fs.writeFileSync(VERSION_FILE, JSON.stringify({ git: BASE_SHA, builtAt: '2026-10-10T00:00:00Z' }));

  expect(setCredential(new StateDb(path.join(STATE, 'webpi.db')), USERNAME, PASSWORD).ok).toBe(true);

  // The child server: the full app, with the management env pointed at
  // the fixture (checkout + releases volume). No S3, no sessions started.
  child = spawn('node', ['dist-server/server/main.js'], {
    cwd: ROOT,
    env: bareEnv({
      WEB_PI_PORT: String(PORT),
      WEB_PI_HOST: '127.0.0.1',
      WEB_PI_DB_FILE: path.join(STATE, 'webpi.db'),
      WEB_PI_AGENT_DIR: path.join(STATE, 'pi-agent'),
      WEB_PI_SESSIONS_DIR: path.join(STATE, 'sessions'),
      WEB_PI_NEW_SESSION_CWD: STATE,
      WEB_PI_TMUX_SOCKET: `webpi-mgmt-itest-${process.pid}`,
      WEB_PI_MANAGEMENT_CHECKOUT: CHECKOUT,
      WEB_PI_RELEASES_DIR: RELEASES,
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  return new Promise<void>((resolve, reject) => {
    const t = child!;
    const timer = setTimeout(() => reject(new Error(`server did not boot; stdout: ${out}`)), 15_000);
    t.stdout!.on('data', (d: Buffer) => {
      out += d.toString();
      if (out.includes('web-pi listening')) { clearTimeout(timer); resolve(); }
    });
    t.on('error', reject);
  });
});

test.afterAll(() => {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
    child.kill('SIGKILL');
  }
  fs.rmSync(VERSION_FILE, { force: true });
  fs.rmSync(STATE, { recursive: true, force: true });
});

// ---- the shared-suite login conventions (one POST, cookie reused) ----
// The child's own budget: the form sign-in below is the only /login POST.

async function signIn(page: Page): Promise<void> {
  await page.fill('wa-input#username input', USERNAME);
  await page.fill('wa-input#password input', PASSWORD);
  await page.click('wa-button:has-text("sign in")');
}

let sessionCookie: Cookie | null = null;
async function login(page: Page): Promise<void> {
  if (sessionCookie) {
    await page.context().addCookies([sessionCookie]);
    return;
  }
  await page.goto(`${BASE}/login`);
  await signIn(page);
  await page.waitForURL(`${BASE}/`);
  const cookies = await page.context().cookies();
  sessionCookie = cookies.find(c => c.name === 'webpi_session') ?? null;
  expect(sessionCookie).not.toBeNull();
}

test('unauthenticated: /management renders the login page in place; the APIs answer 401', async ({ page }) => {
  const api = await fetch(`${BASE}/api/management`);
  expect(api.status).toBe(401);
  await page.goto(`${BASE}/management`);
  await expect(page.locator('wa-input#username')).toBeVisible();
});

test('the page renders the server state: serving, checkout, commits', async ({ page }) => {
  await login(page);
  await page.goto(`${BASE}/management`);
  await expect(page.locator('#mgmt-serving')).toContainText('the image copy');
  await expect(page.locator('#mgmt-serving')).toContainText(BASE_SHA.slice(0, 12));
  await expect(page.locator('#mgmt-checkout')).toContainText('mgmt-checkout');
  await expect(page.locator('#mgmt-commits .mgmt-commit')).toHaveCount(3);
  // wa-* upgraded (the back button is a real link, the card headers render)
  await expect(page.locator('wa-button:has-text("settings")')).toBeVisible();
});

test('picking a commit fetches the server-rendered verdict BEFORE any verb', async ({ page }) => {
  await login(page);
  await page.goto(`${BASE}/management`);
  await page.click(`[data-pick="${CLEAN_SHA}"]`);
  await expect(page.locator('#mgmt-preview')).toContainText('allowed');
  await expect(page.locator('#mgmt-preview .mgmt-protected')).toHaveCount(0);
  // the picked row is marked, and the preview names the changed file
  await expect(page.locator(`[data-pick="${CLEAN_SHA}"]`).first()).toHaveAttribute('data-selected', 'true');
  await expect(page.locator('#mgmt-preview')).toContainText('README.md');

  // the evil commit's verdict refuses and names the protected path
  await page.click(`[data-pick="${EVIL_SHA}"]`);
  await expect(page.locator('#mgmt-preview')).toContainText('REFUSED');
  await expect(page.locator('#mgmt-preview .mgmt-protected')).toContainText('compose.yaml');
});

test('build: re-auth gates it, enforcement refuses the protected change, the marker is the only effect', async ({ page }) => {
  await login(page);
  await page.goto(`${BASE}/management`);

  const call = (sha: string, username: string, password: string) => page.evaluate(
    async ([s, u, p]) => {
      const r = await fetch('/api/management/build', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sha: s, confirm: true, username: u, password: p }),
      });
      return { status: r.status, body: await r.json().catch(() => ({})) as Record<string, unknown> };
    },
    [sha, username, password] as const);

  // wrong password → 401, nothing written
  const wrong = await call(CLEAN_SHA, USERNAME, 'nope');
  expect(wrong.status).toBe(401);
  expect(wrong.body.code).toBe('invalid_credentials');

  // the protected change → 422 naming the path, nothing written
  const refused = await call(EVIL_SHA, USERNAME, PASSWORD);
  expect(refused.status).toBe(422);
  expect(refused.body.code).toBe('enforcement_rejected');
  expect(String(refused.body.error)).toContain('compose.yaml');
  expect(fs.existsSync(path.join(RELEASES, 'pending'))).toBe(false);

  // the clean commit → 202: the request marker is the ONLY thing that happened
  const ok = await call(CLEAN_SHA, USERNAME, PASSWORD);
  expect(ok.status).toBe(202);
  const marker = path.join(RELEASES, 'pending', `${CLEAN_SHA}.json`);
  expect(fs.existsSync(marker)).toBe(true);
  expect(JSON.parse(fs.readFileSync(marker, 'utf8'))).toMatchObject({ sha: CLEAN_SHA, base: BASE_SHA });
  // the page's history table picked the request up
  await page.goto(`${BASE}/management`);
  await expect(page.locator('#mgmt-releases')).toContainText(CLEAN_SHA.slice(0, 12));

  // no confirm → the schema refuses it (the dialog's checkbox is not optional)
  const unconfirmed = await page.evaluate(async ([s, u, p]) => {
    const r = await fetch('/api/management/build', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sha: s, confirm: false, username: u, password: p }),
    });
    return r.status;
  }, [CLEAN_SHA, USERNAME, PASSWORD] as const);
  expect(unconfirmed).toBe(400);
});

test('build through the dialog: the checkbox gate, re-auth toast, success closes + refreshes', async ({ page }) => {
  await login(page);
  await page.goto(`${BASE}/management`);
  // The fetch-based build test above left CLEAN_SHA's pending marker; no
  // builder runs in this suite, so it is dead weight that would trip the
  // one-build-at-a-time guard — clear it (the history row stays).
  fs.rmSync(path.join(RELEASES, 'pending'), { recursive: true, force: true });

  // pick the clean commit, then the preview's build button opens the dialog
  await page.click(`[data-pick="${CLEAN_SHA}"]`);
  await expect(page.locator('#mgmt-preview')).toContainText('allowed');
  await page.click(`#mgmt-preview [data-build="${CLEAN_SHA}"]`);
  const dialogText = page.locator('wa-dialog#mgmt-dialog #mgmt-dialog-text');
  // the dialog opens (an unupgraded wa-dialog would leave this invisible —
  // the AGENTS.md SSR-≠-client lesson, caught only by a real browser)
  await expect(dialogText).toBeVisible();
  await expect(dialogText).toContainText(`build ${CLEAN_SHA.slice(0, 12)}`);

  // valid credentials but the confirm checkbox unticked: refused by the
  // element's own gate — nothing is posted
  await page.fill('wa-input#mgmt-username input', USERNAME);
  await page.fill('wa-input#mgmt-password input', 'nope');
  await page.click('#mgmt-confirm-ok');
  await expect(page.locator('#mgmt-confirm-error')).toContainText('tick the checkbox');
  expect(fs.existsSync(path.join(RELEASES, 'pending'))).toBe(false);

  // ticked + wrong password: 401 → the toast (an upgraded wa-toast), the
  // dialog stays open, still nothing written
  await page.click('wa-checkbox#mgmt-confirm-box');
  // The wa-checkbox HOST is not an <input> and carries no role/aria-checked
  // (WebAwesome keeps the checkbox semantics on the real input inside its
  // shadow DOM — the same piercing as the wa-input fills above), so
  // toBeChecked must target that inner input: on the host it fails with
  // "not a checkbox or radio button" whether upgraded or not. The worker's
  // sandbox had no browser; this line first ran on the merge host.
  await expect(page.locator('wa-checkbox#mgmt-confirm-box input')).toBeChecked();
  await page.click('#mgmt-confirm-ok');
  await expect(page.locator('wa-toast')).toContainText('wrong username or password');
  await expect(dialogText).toBeVisible();
  expect(fs.existsSync(path.join(RELEASES, 'pending'))).toBe(false);

  // right password: the dialog closes, the request lands on disk and the
  // history table picks it up (the element refreshes from the partial)
  await page.fill('wa-input#mgmt-password input', PASSWORD);
  await page.click('#mgmt-confirm-ok');
  await expect(dialogText).not.toBeVisible();
  await expect(page.locator('#mgmt-releases')).toContainText(CLEAN_SHA.slice(0, 12));
  expect(JSON.parse(fs.readFileSync(
    path.join(RELEASES, 'pending', `${CLEAN_SHA}.json`), 'utf8'))).toMatchObject(
    { sha: CLEAN_SHA, base: BASE_SHA });
});

test('activate without a built release is a 404; a foreign Origin POST never reaches it', async ({ page }) => {
  await login(page);
  await page.goto(`${BASE}/management`);
  const missing = await page.evaluate(async ([sha, u, p]) => {
    const r = await fetch('/api/management/activate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: sha, confirm: true, username: u, password: p }),
    });
    return { status: r.status, code: (await r.json().catch(() => ({}))).code };
  }, [CLEAN_SHA, USERNAME, PASSWORD] as const);
  expect(missing.status).toBe(404);
  expect(missing.code).toBe('release_not_built');

  // the origin gate runs before anything else (403, no session needed).
  // Node fetch, not the browser: Origin is a forbidden header in a page.
  const foreign = await fetch(`${BASE}/api/management/build`, {
    method: 'POST',
    headers: { origin: 'https://evil.example', 'Content-Type': 'application/json' },
    body: JSON.stringify({ sha: CLEAN_SHA, confirm: true, username: USERNAME, password: PASSWORD }),
  });
  expect(foreign.status).toBe(403);
});
