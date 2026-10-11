// verify-management-ssr.mjs — verify the /management page and its API
// routes through the REAL built Astro handler (dist/server/entry.mjs)
// with stubbed locals, without booting the full Node server. That is the
// right shape wherever node-pty cannot build (no C++ toolchain — the
// sandbox; e2e's `node dist-server/server/main.js` would die on the
// import), and it is the sandbox half of the host verification in
// docs/management-page.md §7: everything below the main.ts gate (SSR
// HTML, the partial, the thin routes, the status mapping) runs for real
// against a REAL Releases service over a REAL git fixture.
//
//   npm run build && node tools/verify-management-ssr.mjs
//
// What it does NOT cover (by design): the main.ts gate itself (origin
// check, session check, body caps — protected code, unchanged on this
// branch, covered by the existing e2e for its other routes) and the
// browser halves (the <management-app> element, dialog upgrade) — those
// are tests/management.spec.ts's job on a host that can run chromium.
import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');
const USERNAME = 'tester';
const PASSWORD = 'correct-horse-9';

// ---------- the fixture: a real git checkout + a fake "image" ----------

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'webpi-ssr-'));
const CHECKOUT = path.join(tmp, 'checkout');
const RELEASES = path.join(tmp, 'releases');
const APP_ROOT = path.join(tmp, 'app'); // fake image root: version.json lives here

function git(cmd, cwd = CHECKOUT) {
  return execFileSync('git', cmd, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
}

fs.mkdirSync(CHECKOUT, { recursive: true });
fs.mkdirSync(RELEASES, { recursive: true });
fs.mkdirSync(APP_ROOT, { recursive: true });
execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: CHECKOUT, stdio: 'ignore' });
git(['config', 'user.email', 't@t']);
git(['config', 'user.name', 't']);
for (const f of ['compose.yaml', 'Dockerfile', 'server/main.ts', 'src/lib/releases.ts', 'package.json']) {
  fs.mkdirSync(path.dirname(path.join(CHECKOUT, f)), { recursive: true });
  fs.writeFileSync(path.join(CHECKOUT, f), `# ${f}\n`);
}
fs.writeFileSync(path.join(CHECKOUT, 'README.md'), 'base\n');
git(['add', '-A']);
git(['commit', '-q', '-m', 'base']);
const BASE_SHA = git(['rev-parse', 'HEAD']);
fs.writeFileSync(path.join(CHECKOUT, 'README.md'), 'clean target\n');
git(['add', '-A']);
git(['commit', '-q', '-m', 'clean target']);
const CLEAN_SHA = git(['rev-parse', 'HEAD']);
fs.writeFileSync(path.join(CHECKOUT, 'compose.yaml'), 'evil: true\n');
git(['add', '-A']);
git(['commit', '-q', '-m', 'evil target']);
const EVIL_SHA = git(['rev-parse', 'HEAD']);
fs.writeFileSync(path.join(APP_ROOT, 'version.json'),
  JSON.stringify({ git: BASE_SHA, builtAt: '2026-10-10T00:00:00Z' }));

// ---------- the real domain service behind the stubbed locals ----------

const { Releases } = await import(pathToFileURL(path.join(ROOT, 'dist-server/src/lib/releases.js')).href);
const { StateDb } = await import(pathToFileURL(path.join(ROOT, 'dist-server/src/lib/db.js')).href);

const restarts = [];
const service = new Releases({
  db: new StateDb(path.join(tmp, 'webpi.db')),
  checkout: CHECKOUT,
  releasesDir: RELEASES,
  appRoot: APP_ROOT,
  bootServing: { kind: 'image', sha: null },
  requestRestart: () => restarts.push(Date.now()),
  verify: async (username, password) =>
    username === USERNAME && password === PASSWORD
      ? { ok: true, resultType: 'verify_login', data: { username } }
      : { ok: false, resultType: 'verify_login', data: { username }, errorCode: 'invalid_credentials', errorMessage: 'invalid credentials' },
});

// The locals main.ts would pass on the authenticated path. Only
// `management` is reached from /management and its routes; the rest of
// WebPiServices is absent on purpose (a route touching it would explode —
// that is the point of the check).
const locals = { webpi: { management: service }, session: 'stubbed-session-token' };

// ---------- the real Astro handler with the stubbed locals ----------

const { handler } = await import(pathToFileURL(path.join(ROOT, 'dist/server/entry.mjs')).href);
const server = http.createServer((req, res) => {
  handler(req, res, () => { res.writeHead(404); res.end('no route'); }, locals);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const BASE = `http://127.0.0.1:${server.address().port}`;

const call = async (method, urlPath, body) => {
  const r = await fetch(BASE + urlPath, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* html */ }
  return { status: r.status, text, json };
};

let failures = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    failures++;
    console.error(`NOT OK - ${name}\n${err && err.stack ? err.stack : err}`);
  }
};

// ---------- SSR: the page (what the e2e spec asserts on the DOM) ----------

const page = await call('GET', '/management');
check('the page renders (200, text/html)', () => {
  assert.equal(page.status, 200);
  assert.match(page.text, /<!doctype html>/i);
});
check('#mgmt-serving: the image copy + the baked sha', () => {
  assert.match(page.text, /id="mgmt-serving"/);
  assert.match(page.text, /the image copy/);
  assert.ok(page.text.includes(BASE_SHA.slice(0, 12)), 'the image git sha is shown');
});
check('#mgmt-checkout: the fixture checkout path + HEAD', () => {
  assert.match(page.text, /id="mgmt-checkout"/);
  assert.ok(page.text.includes(CHECKOUT), 'the checkout path is shown');
});
check('#mgmt-commits: one .mgmt-commit button per commit, data-pick carries the sha', () => {
  assert.match(page.text, /id="mgmt-commits"/);
  assert.equal((page.text.match(/class="mgmt-commit"/g) ?? []).length, 3);
  for (const sha of [BASE_SHA, CLEAN_SHA, EVIL_SHA]) {
    assert.ok(page.text.includes(`data-pick="${sha}"`), sha);
  }
});
check('the confirm dialog + its fields are in the HTML', () => {
  assert.match(page.text, /id="mgmt-dialog"/);
  assert.match(page.text, /id="mgmt-form"/);
  assert.match(page.text, /id="mgmt-username"/);
  assert.match(page.text, /id="mgmt-confirm-box"/);
});

// ---------- the partial (what <management-app> refreshes from) ----------

const cleanPartial = await call('GET', `/partials/management?sha=${CLEAN_SHA}`);
check('the partial for a clean commit: allowed, the changed file listed', () => {
  assert.equal(cleanPartial.status, 200);
  assert.ok(cleanPartial.text.includes('allowed'), 'the verdict badge says allowed');
  assert.ok(cleanPartial.text.includes('README.md'), 'the changed path is listed');
  assert.doesNotMatch(cleanPartial.text, /mgmt-protected/, 'no protected list');
});
const evilPartial = await call('GET', `/partials/management?sha=${EVIL_SHA}`);
check('the partial for a protected change: REFUSED + the path + the rationale', () => {
  assert.equal(evilPartial.status, 200);
  assert.ok(evilPartial.text.includes('REFUSED'), 'the verdict badge says REFUSED');
  assert.ok(evilPartial.text.includes('compose.yaml'), 'the protected path is named');
  assert.ok(evilPartial.text.includes('the split'), 'the entry\'s rationale is shown');
  assert.ok(evilPartial.text.includes(`data-selected="true"`), 'the picked row is marked');
});

// ---------- the thin API routes (statuses + bodies, docs §5) ----------

const state = await call('GET', '/api/management');
check('GET /api/management: the state JSON', () => {
  assert.equal(state.status, 200);
  assert.equal(state.json.me, 'ok');
  assert.equal(state.json.serving.kind, 'image');
  assert.equal(state.json.serving.image.git, BASE_SHA);
  assert.equal(state.json.releasesDir, RELEASES);
  assert.equal(state.json.checkout.head, EVIL_SHA); // the fixture's HEAD is its last commit
  assert.equal(state.json.checkout.branch, 'main');
  assert.deepEqual(state.json.releases, []);
});
const commits = await call('GET', '/api/management/commits');
check('GET /api/management/commits: 3 commits, newest first', () => {
  assert.equal(commits.status, 200);
  assert.equal(commits.json.commits.length, 3);
  assert.equal(commits.json.commits[0].sha, EVIL_SHA);
  assert.equal(commits.json.commits[0].subject, 'evil target');
});
const preview = await call('GET', `/api/management/preview?sha=${EVIL_SHA}`);
check('GET /api/management/preview: the verdict as data (with the rationale)', () => {
  assert.equal(preview.status, 200);
  assert.equal(preview.json.allowed, false);
  assert.deepEqual(preview.json.protectedChanged, ['compose.yaml']);
  assert.ok(preview.json.protectedWhy['compose.yaml'].length > 10, 'the rationale rides along');
});
const badPreview = await call('GET', '/api/management/preview?sha=xyz');
check('GET /api/management/preview with a bad sha: 400 with issues', () => {
  assert.equal(badPreview.status, 400);
  assert.equal(badPreview.json.code, 'validation_failure');
  assert.ok(badPreview.json.issues && typeof badPreview.json.issues === 'object', 'issues ride along');
});

const body = (sha, password = PASSWORD, confirm = true) =>
  ({ sha, confirm, username: USERNAME, password });

const wrongPw = await call('POST', '/api/management/build', body(CLEAN_SHA, 'nope'));
check('POST build, wrong password: 401 invalid_credentials, no marker', () => {
  assert.equal(wrongPw.status, 401);
  assert.equal(wrongPw.json.code, 'invalid_credentials');
  assert.equal(fs.existsSync(path.join(RELEASES, 'pending')), false);
});
const refused = await call('POST', '/api/management/build', body(EVIL_SHA));
check('POST build, protected change: 422 enforcement_rejected naming the path, no marker', () => {
  assert.equal(refused.status, 422);
  assert.equal(refused.json.code, 'enforcement_rejected');
  assert.ok(refused.json.error.includes('compose.yaml'), 'the error names the path');
  assert.equal(fs.existsSync(path.join(RELEASES, 'pending')), false);
});
const unconfirmed = await call('POST', '/api/management/build', body(CLEAN_SHA, PASSWORD, false));
check('POST build without confirm: 400 (the checkbox is not optional)', () => {
  assert.equal(unconfirmed.status, 400);
  assert.equal(unconfirmed.json.code, 'validation_failure');
  assert.ok(unconfirmed.json.issues && Object.keys(unconfirmed.json.issues).length > 0, 'issues ride along');
});
const built = await call('POST', '/api/management/build', body(CLEAN_SHA));
check('POST build, clean commit: 202 + the pending marker on disk', () => {
  assert.equal(built.status, 202);
  assert.deepEqual(built.json, { sha: CLEAN_SHA, status: 'requested' });
  const marker = path.join(RELEASES, 'pending', `${CLEAN_SHA}.json`);
  const parsed = JSON.parse(fs.readFileSync(marker, 'utf8'));
  assert.equal(parsed.sha, CLEAN_SHA);
  assert.equal(parsed.base, BASE_SHA);
});
const again = await call('POST', '/api/management/build', body(CLEAN_SHA));
check('POST build again while pending: 409 build_active', () => {
  assert.equal(again.status, 409);
  assert.equal(again.json.code, 'build_active');
});

const history = await call('GET', '/api/management');
check('the history row exists after the request', () => {
  assert.equal(history.json.releases.length, 1);
  assert.equal(history.json.releases[0].sha, CLEAN_SHA);
  assert.equal(history.json.releases[0].status, 'requested');
  assert.equal(history.json.releases[0].live, 'pending'); // synced from the marker
});

const notBuilt = await call('POST', '/api/management/activate',
  { target: CLEAN_SHA, confirm: true, username: USERNAME, password: PASSWORD });
check('POST activate without a built release: 404 release_not_built, no restart', () => {
  assert.equal(notBuilt.status, 404);
  assert.equal(notBuilt.json.code, 'release_not_built');
  assert.equal(restarts.length, 0);
});

// ---------- teardown ----------

server.close();
fs.rmSync(tmp, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nmanagement SSR + API verified through the real Astro entry');
