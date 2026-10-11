// releases.test.mjs — the management page's swap machinery (src/lib/
// releases.ts): the builder marker protocol (one case per state), release
// dir validation, the boot-time serve resolution, the pointer, the db
// migration (v5), and the Releases service's verbs — one case per error
// code, with a fake builder playing the filesystem side of the protocol
// and a spy restart trigger.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const {
  Releases, markerPaths, readBuildMarker, writeBuildRequest, anyBuildActive,
  validateReleaseDir, resolveServingDirs, readPointer, writePointer,
} = await import('../../dist-server/src/lib/releases.js');
const { StateDb } = await import('../../dist-server/src/lib/db.js');
const { BuildDoneMarkerSchema } = await import('../../dist-server/src/schemas/management.js');

// ---------- fixtures ----------

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'webpi-releases-'));

/** A minimal app root with a version.json recording `git`. */
function fakeAppRoot(git = 'unknown') {
  const root = fs.mkdtempSync(path.join(tmp, 'app-'));
  fs.writeFileSync(path.join(root, 'version.json'), JSON.stringify({ git, builtAt: '2026-10-10T00:00:00Z' }));
  return root;
}

/** A tiny git repo: base commit with README + one follow-up commit. */
function gitRepo() {
  const root = fs.mkdtempSync(path.join(tmp, 'repo-'));
  const run = (cmd) => execFileSync('git', cmd, { cwd: root, stdio: 'ignore' });
  run(['init', '-q', '-b', 'main']);
  run(['config', 'user.email', 't@t']);
  run(['config', 'user.name', 't']);
  fs.writeFileSync(path.join(root, 'README.md'), 'base\n');
  run(['add', '-A']);
  run(['commit', '-q', '-m', 'base']);
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim();
  fs.writeFileSync(path.join(root, 'README.md'), 'target\n');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'x.ts'), 'x');
  run(['add', '-A']);
  run(['commit', '-q', '-m', 'target']);
  const target = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim();
  return { root, base, target };
}

/** A service harness: fresh db, releases dir, checkout, restart spy. */
function harness(opts = {}) {
  const db = new StateDb(path.join(fs.mkdtempSync(path.join(tmp, 'db-')), 'webpi.db'));
  const releasesDir = path.join(fs.mkdtempSync(path.join(tmp, 'rel-')), 'releases');
  fs.mkdirSync(releasesDir, { recursive: true });
  const restarts = [];
  const deps = {
    db,
    checkout: opts.checkout !== undefined ? opts.checkout : null,
    // (null must survive: it means "no releases volume mounted")
    releasesDir: opts.releasesDir !== undefined ? opts.releasesDir : releasesDir,
    appRoot: opts.appRoot ?? fakeAppRoot(opts.baseSha ?? 'unknown'),
    bootServing: opts.bootServing ?? { kind: 'image', sha: null },
    requestRestart: () => restarts.push(Date.now()),
    verify: async (username, password) =>
      username === 'tester' && password === 'pw'
        ? { ok: true, resultType: 'verify_login', data: { username } }
        : { ok: false, resultType: 'verify_login', data: { username }, errorCode: 'invalid_credentials', errorMessage: 'invalid credentials' },
  };
  return { db, service: new Releases(deps), releasesDir, restarts, deps };
}

/** Play the builder: claim the pending marker (if any) and answer `status`. */
function fakeBuilder(releasesDir, sha, status, log = '') {
  const p = markerPaths(releasesDir, sha);
  fs.mkdirSync(path.dirname(p.building), { recursive: true });
  fs.mkdirSync(path.dirname(p.done), { recursive: true });
  if (fs.existsSync(p.pending)) {
    fs.renameSync(p.pending, p.building);
  }
  fs.rmSync(p.building, { force: true });
  fs.writeFileSync(p.done, JSON.stringify(
    BuildDoneMarkerSchema.parse({ sha, status, builtAt: Date.now(), log })));
  if (status === 'built') makeRelease(releasesDir, sha);
}

/** The builder's claim half alone: rename to building/ AND delete the
 *  previous build's done marker (the real builder-entrypoint.sh does
 *  both — a re-build must not report the stale answer as live state). */
function claimBuilder(releasesDir, sha) {
  const p = markerPaths(releasesDir, sha);
  fs.mkdirSync(path.dirname(p.building), { recursive: true });
  fs.renameSync(p.pending, p.building);
  fs.rmSync(p.done, { force: true });
}

/** A valid release dir for `sha`. */
function makeRelease(releasesDir, sha, manifestSha = sha) {
  const p = markerPaths(releasesDir, sha);
  fs.mkdirSync(path.join(p.releaseDir, 'dist', 'server'), { recursive: true });
  fs.mkdirSync(path.join(p.releaseDir, 'dist', 'client', '_astro'), { recursive: true });
  fs.writeFileSync(path.join(p.releaseDir, 'dist', 'server', 'entry.mjs'), 'export const handler = 1;');
  fs.writeFileSync(path.join(p.releaseDir, 'dist', 'client', '_astro', 'x.js'), 'x');
  fs.writeFileSync(path.join(p.releaseDir, 'manifest.json'),
    JSON.stringify({ sha: manifestSha, builtAt: 1234, builder: 'test' }));
}

const PW = { username: 'tester', password: 'pw' };

// ---------- db migration ----------

test('state db v5: the releases table exists and holds history', async () => {
  const repo = gitRepo();
  const { db, service, releasesDir } = harness({ baseSha: repo.base, checkout: repo.root });
  assert.equal(db.db().prepare('PRAGMA user_version').get().user_version, 5);
  const built = await service.requestBuild({ sha: repo.target, ...PW });
  assert.equal(built.ok, true, JSON.stringify(built));
  fakeBuilder(releasesDir, repo.target, 'built', 'npm ok');
  const state = await service.state();
  assert.ok(state.ok);
  assert.equal(state.data.releases.length, 1);
  assert.equal(state.data.releases[0].status, 'built'); // synced from the marker
  assert.equal(state.data.releases[0].log, 'npm ok');
});

// ---------- the marker protocol ----------

test('marker protocol: none → pending → building → built/failed', async () => {
  const repo = gitRepo();
  const { service, releasesDir } = harness({ baseSha: repo.base, checkout: repo.root });
  const sha = repo.target;
  assert.equal(readBuildMarker(releasesDir, sha).status, 'none');
  const requested = await service.requestBuild({ sha, ...PW });
  assert.equal(requested.ok, true);
  assert.deepEqual(requested.data, { sha, status: 'requested' });
  assert.equal(readBuildMarker(releasesDir, sha).status, 'pending');
  assert.equal(anyBuildActive(releasesDir), true);
  // the builder claims it
  const p = markerPaths(releasesDir, sha);
  fs.mkdirSync(path.dirname(p.building), { recursive: true });
  fs.renameSync(p.pending, p.building);
  assert.equal(readBuildMarker(releasesDir, sha).status, 'building');
  assert.equal(anyBuildActive(releasesDir), true);
  // answers built + lays the release down
  fakeBuilder(releasesDir, sha, 'built', 'out');
  assert.equal(readBuildMarker(releasesDir, sha).status, 'built');
  assert.equal(readBuildMarker(releasesDir, sha).log, 'out');
  assert.equal(anyBuildActive(releasesDir), false);
});

test('marker protocol: a failed done marker carries the log; a corrupt one reads as failed', async () => {
  const repo = gitRepo();
  const { service, releasesDir } = harness({ baseSha: repo.base, checkout: repo.root });
  const sha = repo.target;
  await service.requestBuild({ sha, ...PW });
  fakeBuilder(releasesDir, sha, 'failed', 'boom');
  const marker = readBuildMarker(releasesDir, sha);
  assert.equal(marker.status, 'failed');
  assert.equal(marker.log, 'boom');
  fs.writeFileSync(markerPaths(releasesDir, sha).done, '{not json');
  assert.equal(readBuildMarker(releasesDir, sha).status, 'failed');
});

test('a re-build over a recorded outcome: pending shadows the stale answer, the new answer lands', async () => {
  const repo = gitRepo();
  const { service, releasesDir } = harness({ baseSha: repo.base, checkout: repo.root });
  const sha = repo.target;
  await service.requestBuild({ sha, ...PW });
  fakeBuilder(releasesDir, sha, 'failed', 'first log');
  let row = (await service.state()).data.releases.find(r => r.sha === sha);
  assert.equal(row.status, 'failed');
  assert.equal(row.log, 'first log');

  // the retry: re-request (the page re-offers build for any allowed pick)
  assert.equal((await service.requestBuild({ sha, ...PW })).ok, true);
  // the new request shadows the previous answer until the builder claims it
  assert.equal(readBuildMarker(releasesDir, sha).status, 'pending');
  // the claim deletes the stale answer (builder-entrypoint.sh)
  claimBuilder(releasesDir, sha);
  assert.equal(readBuildMarker(releasesDir, sha).status, 'building');
  fakeBuilder(releasesDir, sha, 'built', 'second log');
  row = (await service.state()).data.releases.find(r => r.sha === sha);
  // a failed→built retry is not a dead end: the new outcome overwrites
  assert.equal(row.status, 'built');
  assert.equal(row.log, 'second log');
});

test('applied_at survives a re-build; a re-activation keeps the FIRST activation time', async () => {
  const repo = gitRepo();
  const { service, releasesDir, restarts } = harness({ baseSha: repo.base, checkout: repo.root });
  const sha = repo.target;
  await service.requestBuild({ sha, ...PW });
  fakeBuilder(releasesDir, sha, 'built', 'ok');
  assert.equal((await service.activate({ target: sha, ...PW })).ok, true);
  let row = (await service.state()).data.releases.find(r => r.sha === sha);
  assert.equal(row.status, 'applied');
  const first = row.appliedAt;
  assert.ok(first > 0);

  // re-build the applied release: the lifecycle resets, the history stays
  assert.equal((await service.requestBuild({ sha, ...PW })).ok, true);
  row = (await service.state()).data.releases.find(r => r.sha === sha);
  assert.equal(row.status, 'requested');
  assert.equal(row.appliedAt, first);
  claimBuilder(releasesDir, sha);
  fakeBuilder(releasesDir, sha, 'built', 'again');
  row = (await service.state()).data.releases.find(r => r.sha === sha);
  assert.equal(row.status, 'built');
  assert.equal(row.appliedAt, first);

  // re-activation: applied_at keeps its FIRST value (coalesce), not the last
  assert.equal((await service.activate({ target: sha, ...PW })).ok, true);
  row = (await service.state()).data.releases.find(r => r.sha === sha);
  assert.equal(row.status, 'applied');
  assert.equal(row.appliedAt, first);
  assert.equal(restarts.length, 2);
});

test('writeBuildRequest: the marker is schema-valid and atomic (tmp+rename)', () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'req-'));
  writeBuildRequest(dir, 'a'.repeat(40), 'b'.repeat(40));
  const body = JSON.parse(fs.readFileSync(path.join(dir, 'pending', `${'a'.repeat(40)}.json`), 'utf8'));
  assert.deepEqual(Object.keys(body).sort(), ['base', 'requestedAt', 'sha']);
  assert.equal(fs.readdirSync(path.join(dir, 'pending')).length, 1); // no tmp leftovers
});

// ---------- release validation ----------

test('validateReleaseDir: layout + manifest must match the sha', () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'val-'));
  const sha = 'c'.repeat(40);
  makeRelease(dir, sha);
  assert.deepEqual(validateReleaseDir(path.join(dir, sha), sha), { ok: true });
  // manifest naming another sha → refused (the builder cannot mislabel)
  const mislabeled = 'd'.repeat(40);
  makeRelease(dir, mislabeled, sha);
  assert.equal(validateReleaseDir(path.join(dir, mislabeled), mislabeled).ok, false);
  // missing pieces → refused
  makeRelease(dir, sha);
  fs.rmSync(path.join(dir, sha, 'dist', 'server', 'entry.mjs'));
  assert.equal(validateReleaseDir(path.join(dir, sha), sha).ok, false);
  makeRelease(dir, sha);
  fs.rmSync(path.join(dir, sha, 'dist', 'client', '_astro'), { recursive: true });
  assert.equal(validateReleaseDir(path.join(dir, sha), sha).ok, false);
  assert.equal(validateReleaseDir(path.join(dir, 'nope'), sha).ok, false);
});

// ---------- boot-time serve resolution ----------

test('resolveServingDirs: image copy when no pointer; release when valid; fallback when not', () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'serve-'));
  const image = { imageClientDir: '/opt/web-pi/dist/client', imageAstroEntry: '/opt/web-pi/dist/server/entry.mjs' };
  // no releases dir at all
  assert.deepEqual(resolveServingDirs({ ...image, releasesDir: null }).dirs,
    { clientDir: image.imageClientDir, astroEntry: image.imageAstroEntry, releaseDir: null, sha: null });
  // pointer set but release missing → image fallback, loudly
  const sha = 'e'.repeat(40);
  writePointer(dir, sha);
  const missing = resolveServingDirs({ ...image, releasesDir: dir });
  assert.equal(missing.dirs.astroEntry, image.imageAstroEntry);
  assert.match(missing.note, /missing/);
  // valid release → served
  makeRelease(dir, sha);
  const serving = resolveServingDirs({ ...image, releasesDir: dir });
  assert.equal(serving.dirs.sha, sha);
  assert.equal(serving.dirs.astroEntry, path.join(dir, sha, 'dist', 'server', 'entry.mjs'));
  assert.match(serving.note, new RegExp(`serving release ${sha}`));
  // invalid release (manifest mismatch) → fallback
  makeRelease(dir, sha, 'f'.repeat(40));
  const invalid = resolveServingDirs({ ...image, releasesDir: dir });
  assert.equal(invalid.dirs.astroEntry, image.imageAstroEntry);
  assert.match(invalid.note, /INVALID/);
  // cleared pointer → image
  writePointer(dir, null);
  assert.equal(resolveServingDirs({ ...image, releasesDir: dir }).dirs.releaseDir, null);
});

// ---------- the service verbs: one case per error code ----------

test('requestBuild: invalid_credentials — the password re-confirmation', async () => {
  const repo = gitRepo();
  const { service } = harness({ baseSha: repo.base, checkout: repo.root });
  const r = await service.requestBuild({ sha: repo.target, username: 'tester', password: 'nope' });
  assert.equal(r.ok, false);
  assert.equal(r.errorCode, 'invalid_credentials');
});

test('requestBuild: releases_not_configured (no volume mounted)', async () => {
  const repo = gitRepo();
  const { service } = harness({ baseSha: repo.base, checkout: repo.root, releasesDir: null });
  const r = await service.requestBuild({ sha: repo.target, ...PW });
  assert.equal(r.errorCode, 'releases_not_configured');
});

test('requestBuild: checkout_missing (unset and absent dir)', async () => {
  const repo = gitRepo();
  for (const checkout of [null, path.join(tmp, 'no-such-checkout')]) {
    const { service } = harness({ baseSha: repo.base, checkout });
    const r = await service.requestBuild({ sha: repo.target, ...PW });
    assert.equal(r.errorCode, 'checkout_missing', String(checkout));
  }
});

test('requestBuild: base_unknown — no version.json, no pointer', async () => {
  const repo = gitRepo();
  const { service } = harness({ baseSha: 'unknown', checkout: repo.root });
  const r = await service.requestBuild({ sha: repo.target, ...PW });
  assert.equal(r.errorCode, 'base_unknown');
  assert.match(r.errorMessage, /GIT_SHA/);
});

test('requestBuild: base_not_in_checkout — a base the checkout does not resolve', async () => {
  const repo = gitRepo();
  const { service } = harness({ baseSha: '9'.repeat(40), checkout: repo.root });
  const r = await service.requestBuild({ sha: repo.target, ...PW });
  assert.equal(r.errorCode, 'base_not_in_checkout');
});

test('requestBuild: target_not_found', async () => {
  const repo = gitRepo();
  const { service } = harness({ baseSha: repo.base, checkout: repo.root });
  const r = await service.requestBuild({ sha: '8'.repeat(40), ...PW });
  assert.equal(r.errorCode, 'target_not_found');
});

test('requestBuild: enforcement_rejected names the offending paths', async () => {
  const repo = gitRepo();
  // a commit that edits compose.yaml
  fs.writeFileSync(path.join(repo.root, 'compose.yaml'), 'evil\n');
  execFileSync('git', ['add', '-A'], { cwd: repo.root, stdio: 'ignore' });
  execFileSync('git', ['commit', '-q', '-m', 'evil'], { cwd: repo.root, stdio: 'ignore' });
  const evil = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo.root }).toString().trim();
  const { service } = harness({ baseSha: repo.base, checkout: repo.root });
  const r = await service.requestBuild({ sha: evil, ...PW });
  assert.equal(r.errorCode, 'enforcement_rejected');
  assert.match(r.errorMessage, /compose\.yaml/);
  assert.match(r.errorMessage, /original project/);
});

test('requestBuild: build_active while another build is in flight', async () => {
  const repo = gitRepo();
  const { service } = harness({ baseSha: repo.base, checkout: repo.root });
  const first = await service.requestBuild({ sha: repo.target, ...PW });
  assert.equal(first.ok, true);
  const second = await service.requestBuild({ sha: repo.target, ...PW });
  assert.equal(second.errorCode, 'build_active');
});

test('activate: image target with no releases volume is a no-op success (already serving the image)', async () => {
  const { service, restarts } = harness({ releasesDir: null });
  const r = await service.activate({ target: 'image', ...PW });
  assert.deepEqual(r, { ok: true, resultType: 'activate_release', data: { target: 'image', status: 'activating' } });
  assert.equal(restarts.length, 0);
});

test('activate: the happy path — pointer written, history recorded, restart triggered', async () => {
  const repo = gitRepo();
  const { service, releasesDir, restarts } = harness({ baseSha: repo.base, checkout: repo.root });
  assert.equal((await service.requestBuild({ sha: repo.target, ...PW })).ok, true);
  fakeBuilder(releasesDir, repo.target, 'built', 'ok');
  const r = await service.activate({ target: repo.target, ...PW });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(restarts.length, 1);
  assert.equal(readPointer(releasesDir), repo.target);
  const state = await service.state();
  const record = state.data.releases.find(x => x.sha === repo.target);
  assert.equal(record.status, 'applied');
  assert.ok(record.appliedAt > 0);
});

test('activate: invalid_credentials; release_not_built; release_invalid', async () => {
  const repo = gitRepo();
  const { service, releasesDir } = harness({ baseSha: repo.base, checkout: repo.root });
  assert.equal((await service.activate({ target: repo.target, username: 'x', password: 'y' })).errorCode, 'invalid_credentials');
  assert.equal((await service.activate({ target: repo.target, ...PW })).errorCode, 'release_not_built');
  // a release whose manifest names another sha — the builder cannot mislabel
  await service.requestBuild({ sha: repo.target, ...PW });
  fakeBuilder(releasesDir, repo.target, 'built');
  makeRelease(releasesDir, repo.target, '0'.repeat(40));
  assert.equal((await service.activate({ target: repo.target, ...PW })).errorCode, 'release_invalid');
});

test('activate: enforcement re-run catches a commit that was clean at build time… and one that never was', async () => {
  const repo = gitRepo();
  const { service, releasesDir } = harness({ baseSha: repo.base, checkout: repo.root });
  // a release is "built" for the clean target…
  await service.requestBuild({ sha: repo.target, ...PW });
  fakeBuilder(releasesDir, repo.target, 'built');
  // …but a hand-forged done marker + release dir for an EVIL commit must
  // still be refused: the enforcement runs at ACTIVATE, not just build.
  fs.writeFileSync(path.join(repo.root, 'Dockerfile'), 'evil\n');
  execFileSync('git', ['add', '-A'], { cwd: repo.root, stdio: 'ignore' });
  execFileSync('git', ['commit', '-q', '-m', 'evil'], { cwd: repo.root, stdio: 'ignore' });
  const evil = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo.root }).toString().trim();
  fakeBuilder(releasesDir, evil, 'built');
  const r = await service.activate({ target: evil, ...PW });
  assert.equal(r.errorCode, 'enforcement_rejected');
  assert.match(r.errorMessage, /Dockerfile/);
});

test('activate: rollback to image clears the pointer and restarts', async () => {
  const repo = gitRepo();
  const { service, releasesDir, restarts } = harness({ baseSha: repo.base, checkout: repo.root });
  await service.requestBuild({ sha: repo.target, ...PW });
  fakeBuilder(releasesDir, repo.target, 'built');
  assert.equal((await service.activate({ target: repo.target, ...PW })).ok, true);
  assert.equal(readPointer(releasesDir), repo.target);
  const back = await service.activate({ target: 'image', ...PW });
  assert.equal(back.ok, true);
  assert.equal(restarts.length, 2);
  assert.equal(readPointer(releasesDir), null);
});

test('state: serving is the BOOT snapshot; nextBoot shows a written-but-unrestarted pointer', async () => {
  const repo = gitRepo();
  const { service, deps, releasesDir } = harness({ baseSha: repo.base, checkout: repo.root });
  await service.requestBuild({ sha: repo.target, ...PW });
  fakeBuilder(releasesDir, repo.target, 'built');
  await service.activate({ target: repo.target, ...PW }); // pointer written, restart spy fired
  const state = await service.state();
  // the process has NOT rebooted in this harness → honest image serving + pending next boot
  assert.equal(state.data.serving.kind, 'image');
  assert.deepEqual(state.data.nextBoot, { kind: 'release', sha: repo.target });
  // after the reboot: main.ts resolves the pointer BEFORE building the
  // service, so the new process reports the release with nothing pending
  const booted = new Releases({ ...deps, bootServing: { kind: 'release', sha: repo.target } });
  const after = await booted.state();
  assert.equal(after.data.serving.kind, 'release');
  assert.equal(after.data.serving.release?.sha, repo.target);
  assert.equal(after.data.nextBoot, null);
});
