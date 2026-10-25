// settings.test.mjs — runPiUpdate's PiUpdateResult (src/lib/platform/settings.ts):
// one case per error code (npm_missing, npm_check_failed, busy, npm_failed)
// plus success, and the wire body /api/update-pi answers with
// (updateResultBody). npm is a fake on PATH — never the real one.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runPiUpdate, PI_PACKAGE } from '../../dist-server/src/lib/platform/settings.js';
import { updateResultBody } from '../../dist-server/src/lib/web/responses.service.js';

/** An app tree with pi installed at `installed`. */
function fakeAppRoot(installed) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cybermole-settings-'));
  const manifest = path.join(root, 'node_modules', PI_PACKAGE, 'package.json');
  fs.mkdirSync(path.dirname(manifest), { recursive: true });
  fs.writeFileSync(manifest, JSON.stringify({ name: PI_PACKAGE, version: installed }));
  return { root, manifest };
}

/** A fake npm: `--version` answers per FAKE_NPM_VERSION_EXIT; `install`
 *  sleeps FAKE_NPM_SLEEP, then bumps the manifest to FAKE_NPM_INSTALLS_TO
 *  and exits FAKE_NPM_EXIT. */
function withFakeNpm(t, env) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'cybermole-npmbin-'));
  fs.writeFileSync(
    path.join(bin, 'npm'),
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo 10.9.0; exit "\${FAKE_NPM_VERSION_EXIT:-0}"; fi
sleep "\${FAKE_NPM_SLEEP:-0}"
echo "installed $2"
node -e 'const fs=require("fs");const m=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));m.version=process.env.FAKE_NPM_INSTALLS_TO;fs.writeFileSync(process.argv[1],JSON.stringify(m))' "$FAKE_NPM_MANIFEST"
exit "\${FAKE_NPM_EXIT:-0}"
`,
  );
  fs.chmodSync(path.join(bin, 'npm'), 0o755);
  const saved = { ...process.env };
  process.env.PATH = `${bin}${path.delimiter}${saved.PATH}`;
  Object.assign(process.env, env);
  t.after(() => {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- restoring the saved env
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  });
}

test('npm_missing: no npm on PATH (real and dry run)', async t => {
  const { root } = fakeAppRoot('1.0.1');
  const saved = process.env.PATH;
  process.env.PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'cybermole-emptypath-'));
  t.after(() => {
    process.env.PATH = saved;
  });
  for (const dryRun of [false, true]) {
    const r = await runPiUpdate(root, dryRun);
    assert.equal(r.ok, false);
    assert.equal(r.errorCode, 'npm_missing');
    assert.equal(r.data.dryRun, dryRun);
    assert.equal(r.data.before, '1.0.1');
  }
});

test('dry run: success proves npm runs; npm_check_failed when it does not', async t => {
  const { root, manifest } = fakeAppRoot('1.0.1');
  withFakeNpm(t, { FAKE_NPM_MANIFEST: manifest, FAKE_NPM_INSTALLS_TO: '9.9.9' });
  const ok = await runPiUpdate(root, true);
  assert.equal(ok.ok, true);
  assert.match(ok.data.output, /would run `npm install @earendil-works\/pi-coding-agent@latest`/);
  assert.equal(
    JSON.parse(fs.readFileSync(manifest, 'utf8')).version,
    '1.0.1',
    'a dry run installs nothing',
  );
  process.env.FAKE_NPM_VERSION_EXIT = '1';
  const failed = await runPiUpdate(root, true);
  assert.equal(failed.errorCode, 'npm_check_failed');
});

test('real run: success reports before/after; npm_failed on a non-zero exit keeps the output', async t => {
  const { root, manifest } = fakeAppRoot('1.0.1');
  withFakeNpm(t, { FAKE_NPM_MANIFEST: manifest, FAKE_NPM_INSTALLS_TO: '1.2.0' });
  const ok = await runPiUpdate(root, false, `${PI_PACKAGE}@^1.0.1`);
  assert.equal(ok.ok, true);
  assert.equal(ok.data.before, '1.0.1');
  assert.equal(ok.data.after, '1.2.0');
  assert.match(ok.data.output, /installed @earendil-works\/pi-coding-agent@\^1\.0\.1/);

  process.env.FAKE_NPM_EXIT = '3';
  const failed = await runPiUpdate(root, false);
  assert.equal(failed.errorCode, 'npm_failed');
  assert.equal(failed.errorMessage, 'npm exited with code 3');
  assert.match(failed.data.output, /installed/);
});

test('busy: a second real run while one is in flight', async t => {
  const { root, manifest } = fakeAppRoot('1.0.1');
  withFakeNpm(t, {
    FAKE_NPM_MANIFEST: manifest,
    FAKE_NPM_INSTALLS_TO: '1.2.0',
    FAKE_NPM_SLEEP: '0.4',
  });
  const first = runPiUpdate(root, false);
  const second = await runPiUpdate(root, false);
  assert.equal(second.errorCode, 'busy');
  assert.equal(second.errorMessage, 'an update is already running');
  assert.equal((await first).ok, true);
});

test('updateResultBody: the /api/update-pi wire shape for success and failure', () => {
  const data = {
    dryRun: false,
    command: 'npm install x',
    before: '1.0.1',
    after: '1.2.0',
    output: 'out',
  };
  assert.deepEqual(updateResultBody({ ok: true, resultType: 'pi_update', data }), {
    ok: true,
    ...data,
  });
  assert.deepEqual(
    updateResultBody({
      ok: false,
      resultType: 'pi_update',
      data,
      errorCode: 'busy',
      errorMessage: 'an update is already running',
    }),
    { ok: false, ...data, error: 'an update is already running' },
  );
});
