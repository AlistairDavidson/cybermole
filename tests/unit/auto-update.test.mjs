// auto-update.ts: the pure decision logic, the check flow against a fake npm
// on PATH (never the real one), and AutoUpdater timing with mock timers.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { StateDb } from '../../dist-server/src/lib/platform/db.js';
import { logger } from '../../dist-server/src/lib/platform/logger.js';
import {
  AutoUpdater,
  autoUpdateSpec,
  autoUpdateEnabled,
  compareVersions,
  isPlainVersion,
  lastCheck,
  lastUpdate,
  parseNpmViewVersion,
  performAutoUpdateCheck,
  shouldAutoUpdate,
  setAutoUpdateEnabled,
} from '../../dist-server/src/lib/platform/auto-update.js';

/** Counted at the winston transport: it writes to the streams directly, so
 *  a console.error mock can't see it. */
const mockLogSite = t => t.mock.method(logger.transports[0], 'log', () => {});

const PI = '@earendil-works/pi-coding-agent';

const value = r => {
  assert.equal(r.ok, true, r.errorMessage);
  return r.data.value;
};

// ---------- range spec ----------

test('autoUpdateSpec: the declared range becomes the npm spec, or null', () => {
  assert.equal(autoUpdateSpec('^1.0.1'), `${PI}@^1.0.1`);
  assert.equal(autoUpdateSpec('  ~2.3  '), `${PI}@~2.3`); // trimmed
  assert.equal(autoUpdateSpec('1.2.3'), `${PI}@1.2.3`); // exact pin
  assert.equal(autoUpdateSpec('>=1.0.1 <2'), `${PI}@>=1.0.1 <2`);
  assert.equal(autoUpdateSpec('*'), `${PI}@*`);
  assert.equal(autoUpdateSpec('^1.0.1 || ^2.0.0'), `${PI}@^1.0.1 || ^2.0.0`);
  // Anything npm might read as a tag, url, git ref or alias disables auto-update.
  for (const bad of [
    'unknown',
    'latest',
    'next',
    'github:a/b',
    'https://x/y.tgz',
    'file:../pi',
    'npm:other@1',
    '',
    '  ',
  ]) {
    assert.equal(autoUpdateSpec(bad), null, bad);
  }
});

// ---------- semver + the install decision ----------

test('compareVersions: precedence for plain and prerelease semver', () => {
  const lt = (a, b) => assert.equal(Math.sign(compareVersions(a, b)), -1, `${a} < ${b}`);
  lt('1.0.1', '1.0.2');
  lt('1.9.0', '1.10.0'); // numeric, not lexical
  lt('1.99.99', '2.0.0');
  lt('1.0.0-alpha', '1.0.0'); // prerelease < release
  lt('1.0.0-alpha.1', '1.0.0-alpha.2');
  lt('1.0.0-alpha', '1.0.0-beta');
  lt('1.0.0-2', '1.0.0-alpha'); // numeric identifiers sort below alphanumeric
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
  assert.equal(compareVersions('1.2.3', 'v1.2.3'), 0);
  assert.equal(compareVersions('1.2.3+build.7', '1.2.3'), 0); // build metadata ignored
  assert.equal(isPlainVersion('1.2.3-rc.1+b'), true);
  assert.equal(isPlainVersion('latest'), false);
  assert.equal(isPlainVersion('1.2'), false);
  // Unparseable never wins, so nothing installs.
  assert.equal(compareVersions('junk', '1.2.3'), 0);
  assert.equal(compareVersions('1.2.3', 'junk'), 0);
});

test('shouldAutoUpdate: only a strictly newer in-range version installs', () => {
  assert.equal(shouldAutoUpdate(null, '1.2.3'), true); // nothing installed
  assert.equal(shouldAutoUpdate('1.2.3', '1.2.3'), false); // equal
  assert.equal(shouldAutoUpdate('1.2.3', '1.2.4'), true); // newer in range
  assert.equal(shouldAutoUpdate('2.0.0', '1.9.9'), false); // above the range: never "downgrade into range"
  assert.equal(shouldAutoUpdate('junk', '1.2.3'), false); // incomparable → don't touch
});

// ---------- npm view output ----------

test('parseNpmViewVersion: single string, ascending array, junk', () => {
  // One match answers a JSON string…
  assert.equal(parseNpmViewVersion('"1.0.1"\n'), '1.0.1');
  // …several answer every match ascending; the newest is picked by precedence.
  assert.equal(parseNpmViewVersion('["1.0.1","1.0.2","1.1.0"]'), '1.1.0');
  assert.equal(parseNpmViewVersion('["1.0.1","1.1.0","1.0.2"]'), '1.1.0');
  // Prereleases order by precedence, not lexically.
  assert.equal(parseNpmViewVersion('["1.2.0-rc.9","1.2.0-rc.10"]'), '1.2.0-rc.10');
  // A plain (non-JSON) single version parses; nothing else does.
  assert.equal(parseNpmViewVersion('1.0.1'), '1.0.1');
  assert.equal(parseNpmViewVersion(''), null);
  assert.equal(parseNpmViewVersion('no match found'), null);
  assert.equal(parseNpmViewVersion('{"error":true}'), null);
  assert.equal(parseNpmViewVersion('["1.0.1","not-a-version"]'), '1.0.1');
});

// ---------- settings kv ----------

test('state db settings kv: default null, write + overwrite', () => {
  const db = new StateDb(
    path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cybermole-au-')), 'cybermole.db'),
  );
  assert.equal(db.getSetting('nope'), null);
  assert.equal(value(autoUpdateEnabled(db)), false); // default OFF
  db.setSetting('k', '1');
  assert.equal(db.getSetting('k'), '1');
  db.setSetting('k', '2');
  assert.equal(db.getSetting('k'), '2');
});

// ---------- check flow, fake npm ----------

/** package.json declaring the pi range, plus an installed manifest. */
function fakeAppRoot(installed) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cybermole-approot-'));
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'cybermole', dependencies: { [PI]: '^1.0.1' } }, null, 2),
  );
  const manifest = path.join(root, 'node_modules', PI, 'package.json');
  fs.mkdirSync(path.dirname(manifest), { recursive: true });
  const writeManifest = v => fs.writeFileSync(manifest, JSON.stringify({ name: PI, version: v }));
  writeManifest(installed);
  return { root, writeManifest };
}

/** `view` reports FAKE_NPM_LATEST; `install` records its argv, may sleep,
 *  and flips the manifest to FAKE_NPM_INSTALLS_TO. */
function fakeNpmBin() {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'cybermole-npmbin-'));
  const script = path.join(bin, 'npm');
  fs.writeFileSync(
    script,
    `#!/bin/sh
if [ "$1" = "view" ]; then printf '%s\\n' "$FAKE_NPM_LATEST"; exit 0; fi
printf '%s\\n' "$*" >> "$FAKE_NPM_LOG"
sleep "${'${FAKE_NPM_SLEEP:-0}'}"
node -e 'const fs=require("fs");const m=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));m.version=process.env.FAKE_NPM_INSTALLS_TO;fs.writeFileSync(process.argv[1],JSON.stringify(m,null,2))' "${'${FAKE_NPM_MANIFEST?}'}"
exit 0
`,
  );
  fs.chmodSync(script, 0o755);
  return bin;
}

function withFakeNpm(t, bin, root, manifest, latest, installsTo, sleepSec) {
  const saved = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${saved}`;
  process.env.FAKE_NPM_LOG = path.join(root, 'install-args.log');
  process.env.FAKE_NPM_MANIFEST = manifest;
  process.env.FAKE_NPM_LATEST = latest;
  process.env.FAKE_NPM_INSTALLS_TO = installsTo;
  if (sleepSec !== undefined) process.env.FAKE_NPM_SLEEP = String(sleepSec);
  t.after(() => {
    process.env.PATH = saved;
    delete process.env.FAKE_NPM_LOG;
    delete process.env.FAKE_NPM_MANIFEST;
    delete process.env.FAKE_NPM_LATEST;
    delete process.env.FAKE_NPM_INSTALLS_TO;
    delete process.env.FAKE_NPM_SLEEP;
  });
}

test('performAutoUpdateCheck: newer in-range version installs via the declared-range spec', async t => {
  const { root } = fakeAppRoot('1.0.1');
  const bin = fakeNpmBin();
  withFakeNpm(
    t,
    bin,
    root,
    path.join(root, 'node_modules', PI, 'package.json'),
    '["1.0.1","1.0.2","1.1.0"]',
    '1.1.0',
  );
  const db = new StateDb(path.join(root, 'cybermole.db'));

  await performAutoUpdateCheck({ db, appRoot: root });

  // installed with the declared-range spec, never @latest
  const args = fs.readFileSync(path.join(root, 'install-args.log'), 'utf8').trim();
  assert.equal(args, `install ${PI}@^1.0.1`);
  const check = value(lastCheck(db));
  assert.equal(check.outcome, 'installed');
  assert.match(check.detail, /1\.1\.0/);
  const upd = value(lastUpdate(db));
  assert.equal(upd.ok, true);
  assert.equal(upd.before, '1.0.1');
  assert.equal(upd.after, '1.1.0');
  assert.match(upd.detail, /within \^1\.0\.1/);
});

test('performAutoUpdateCheck: already newest in range → up-to-date, no install', async t => {
  const { root } = fakeAppRoot('1.1.0');
  const bin = fakeNpmBin();
  withFakeNpm(
    t,
    bin,
    root,
    path.join(root, 'node_modules', PI, 'package.json'),
    '["1.0.1","1.1.0"]',
    '1.1.0',
  );
  const db = new StateDb(path.join(root, 'cybermole.db'));

  await performAutoUpdateCheck({ db, appRoot: root });

  assert.equal(fs.existsSync(path.join(root, 'install-args.log')), false);
  const check = value(lastCheck(db));
  assert.equal(check.outcome, 'up-to-date');
  assert.match(check.detail, /pi 1\.1\.0 is the newest within \^1\.0\.1/);
  assert.equal(value(lastUpdate(db)), null); // no install → no update outcome
});

test('performAutoUpdateCheck: installed above the range is left alone (never downgraded into range)', async t => {
  const { root } = fakeAppRoot('2.0.0'); // hand-installed @latest, range is ^1
  const bin = fakeNpmBin();
  withFakeNpm(
    t,
    bin,
    root,
    path.join(root, 'node_modules', PI, 'package.json'),
    '["1.0.1","1.1.0"]',
    '1.1.0',
  );
  const db = new StateDb(path.join(root, 'cybermole.db'));

  await performAutoUpdateCheck({ db, appRoot: root });
  assert.equal(fs.existsSync(path.join(root, 'install-args.log')), false);
  const check = value(lastCheck(db));
  assert.equal(check.outcome, 'up-to-date');
  assert.equal(check.detail, 'pi 2.0.0 is above the declared range ^1.0.1 — left alone');
});

test('performAutoUpdateCheck: an unparseable installed version is never touched', async t => {
  const { root } = fakeAppRoot('not-a-version'); // hand-mangled manifest
  const bin = fakeNpmBin();
  withFakeNpm(
    t,
    bin,
    root,
    path.join(root, 'node_modules', PI, 'package.json'),
    '["1.0.1","1.1.0"]',
    '1.1.0',
  );
  const db = new StateDb(path.join(root, 'cybermole.db'));

  await performAutoUpdateCheck({ db, appRoot: root });
  assert.equal(fs.existsSync(path.join(root, 'install-args.log')), false);
  const check = value(lastCheck(db));
  assert.equal(check.outcome, 'up-to-date');
  assert.equal(
    check.detail,
    'installed pi "not-a-version" does not compare as a version — left alone',
  );
});

test('performAutoUpdateCheck: npm view failure is recorded, nothing installed', async t => {
  const { root } = fakeAppRoot('1.0.1');
  const bin = fakeNpmBin();
  withFakeNpm(
    t,
    bin,
    root,
    path.join(root, 'node_modules', PI, 'package.json'),
    'npm error 404 No match found for version ^1.0.1',
    '1.1.0',
  );
  const db = new StateDb(path.join(root, 'cybermole.db'));

  await performAutoUpdateCheck({ db, appRoot: root });

  assert.equal(fs.existsSync(path.join(root, 'install-args.log')), false);
  const check = value(lastCheck(db));
  assert.equal(check.outcome, 'failed');
  assert.match(check.detail, /npm view failed/);
});

test('performAutoUpdateCheck: a concurrent update is refused by the busy guard', async t => {
  // The busy guard is shared with the manual button: an overlapping check
  // records the refusal rather than race npm.
  const { root } = fakeAppRoot('1.0.1');
  const bin = fakeNpmBin();
  withFakeNpm(
    t,
    bin,
    root,
    path.join(root, 'node_modules', PI, 'package.json'),
    '["1.0.1","1.0.2"]',
    '1.0.2',
    0.4 /* install takes a while */,
  );
  const db = new StateDb(path.join(root, 'cybermole.db'));

  const first = performAutoUpdateCheck({ db, appRoot: root }); // holds the lock
  // The fake writes argv when the install starts; poll for it so the second
  // check really overlaps.
  const log = path.join(root, 'install-args.log');
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(log) && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 10));
  }
  assert.equal(fs.existsSync(log), true, 'the first install never started');
  await performAutoUpdateCheck({ db, appRoot: root }); // refused (busy)
  assert.equal(value(lastUpdate(db)).ok, false);
  assert.match(value(lastUpdate(db)).detail, /already running/);
  assert.equal(value(lastCheck(db)).outcome, 'failed');

  await first; // the real update finishes and records its own outcome
  assert.equal(value(lastUpdate(db)).ok, true);
  assert.equal(value(lastCheck(db)).outcome, 'installed');
});

// ---------- scheduling (mock timers, injected check) ----------

test('AutoUpdater: OFF schedules nothing; ON checks after the first delay, then on the interval', async t => {
  t.mock.timers.enable({ now: 0 });
  const db = new StateDb(
    path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cybermole-au-')), 'cybermole.db'),
  );
  let checks = 0;
  const up = new AutoUpdater({
    db,
    appRoot: '/tmp',
    firstDelayMs: 1_000,
    intervalMs: 5_000,
    check: () => {
      checks++;
      return Promise.resolve();
    },
  });

  // Await each tick so the overlap guard's finally drains before the next.
  const tick = async ms => {
    t.mock.timers.tick(ms);
    await Promise.resolve();
    await Promise.resolve();
  };

  // Default off: the boot probe reads off and stays inert.
  up.start();
  await tick(60_000);
  assert.equal(checks, 0);

  // On: persisted, a first check one delay later, then every interval.
  up.setEnabled(true);
  assert.equal(value(autoUpdateEnabled(db)), true); // persisted
  assert.equal(checks, 0); // not before the delay
  await tick(1_000);
  assert.equal(checks, 1); // the first check
  await tick(4_999);
  assert.equal(checks, 1);
  await tick(1);
  assert.equal(checks, 2); // interval fire
  await tick(5_000);
  assert.equal(checks, 3);

  // Off stops everything.
  up.setEnabled(false);
  assert.equal(value(autoUpdateEnabled(db)), false);
  await tick(60_000);
  assert.equal(checks, 3);
});

test('AutoUpdater: boot with the setting already ON checks after the delay', async t => {
  t.mock.timers.enable({ now: 0 });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cybermole-au-'));
  const db = new StateDb(path.join(dir, 'cybermole.db'));
  setAutoUpdateEnabled(db, true); // e.g. the server restarted with it ON
  let checks = 0;
  const up = new AutoUpdater({
    db,
    appRoot: '/tmp',
    firstDelayMs: 1_000,
    intervalMs: 5_000,
    check: () => {
      checks++;
      return Promise.resolve();
    },
  });
  up.start();
  t.mock.timers.tick(999);
  assert.equal(checks, 0);
  t.mock.timers.tick(1);
  assert.equal(checks, 1);
  up.stop();
});

test('setEnabled: a failed save answers database_error and leaves the timers alone', async t => {
  t.mock.timers.enable({ now: 0 });
  // A db that can never open: its parent is a file.
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cybermole-au-')), 'not-a-dir');
  fs.writeFileSync(file, '');
  const db = new StateDb(path.join(file, 'cybermole.db'));
  let checks = 0;
  const up = new AutoUpdater({
    db,
    appRoot: '/tmp',
    firstDelayMs: 1_000,
    intervalMs: 5_000,
    check: () => {
      checks++;
      return Promise.resolve();
    },
  });
  const saved = up.setEnabled(true);
  assert.equal(saved.ok, false);
  assert.equal(saved.errorCode, 'database_error');
  assert.match(saved.errorMessage, /^could not save the setting: /);
  t.mock.timers.tick(10_000);
  assert.equal(checks, 0, 'nothing armed by a save that failed');
  up.stop();
});

test('setEnabled / setAutoUpdateEnabled: success is a database_update result', () => {
  const db = new StateDb(
    path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cybermole-au-')), 'cybermole.db'),
  );
  assert.deepEqual(setAutoUpdateEnabled(db, true), {
    ok: true,
    resultType: 'database_update',
    data: { changes: 1 },
  });
  const up = new AutoUpdater({ db, appRoot: '/tmp', check: () => Promise.resolve() });
  assert.equal(up.setEnabled(false).ok, true);
  assert.equal(value(autoUpdateEnabled(db)), false);
  up.stop();
});

test('reads: an unreadable db is database_error (never "off" / "never"); a corrupt row reads as never', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cybermole-au-')), 'not-a-dir');
  fs.writeFileSync(file, '');
  const broken = new StateDb(path.join(file, 'cybermole.db'));
  for (const r of [autoUpdateEnabled(broken), lastCheck(broken), lastUpdate(broken)]) {
    assert.equal(r.ok, false);
    assert.equal(r.resultType, 'database_read');
    assert.equal(r.errorCode, 'database_error');
  }
  assert.match(autoUpdateEnabled(broken).errorMessage, /^could not read the auto-update setting: /);

  const db = new StateDb(
    path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cybermole-au-')), 'cybermole.db'),
  );
  db.setSetting('piAutoUpdate.lastCheck', '{not json');
  db.setSetting('piAutoUpdate.lastUpdate', '"a string, not an outcome"');
  assert.equal(value(lastCheck(db)), null);
  assert.equal(value(lastUpdate(db)), null);
});

test('AutoUpdater: an unreadable setting at the probe neither checks nor gives up — it re-probes', async t => {
  t.mock.timers.enable({ now: 0 });
  const db = new StateDb(
    path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cybermole-au-')), 'cybermole.db'),
  );
  db.db().prepare('DROP TABLE settings').run(); // every settings read now fails
  let checks = 0;
  const up = new AutoUpdater({
    db,
    appRoot: '/tmp',
    firstDelayMs: 1_000,
    intervalMs: 5_000,
    check: () => {
      checks++;
      return Promise.resolve();
    },
  });
  const logged = mockLogSite(t);
  up.start();
  t.mock.timers.tick(1_000);
  await Promise.resolve();
  assert.equal(checks, 0, 'no npm on a guess');
  assert.ok(logged.mock.callCount() >= 1, 'the unreadable setting is reported');
  t.mock.timers.tick(1_000);
  await Promise.resolve();
  // No second log-count check: mocked timers freeze winston's deferred
  // writes. The recovery tick below proves the re-probe.

  // The db recovers with the setting on: the next probe runs the check.
  db.db().prepare('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)').run();
  setAutoUpdateEnabled(db, true);
  t.mock.timers.tick(1_000);
  assert.equal(checks, 1);
  up.stop();
});
