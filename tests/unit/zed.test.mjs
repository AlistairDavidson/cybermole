// zed.test.mjs — src/lib/zed.ts against a stub launcher (node:http):
// one test per ZedOpenResult error code (docs/CODE_STYLE.md §9), plus
// the wire the real launcher (zed/zed-launcher.py) serves, and the
// statuses zedOpenFailureResponse maps them to.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { openInZed } from '../../dist-server/src/lib/zed.js';
import { zedOpenFailureResponse } from '../../dist-server/src/lib/web/responses.service.js';

/** The launcher zed/zed-launcher.py serves: Bearer token, {"path": …},
 *  200/400/401/404. Records what it was asked. */
async function startStubLauncher({ token = 'unit-token', status = 200 } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      seen.push({ url: req.url, auth: req.headers.authorization, body });
      if (req.method === 'GET' && req.url === '/healthz') {
        res.writeHead(200).end('{"ok":true}');
        return;
      }
      const auth = req.headers.authorization ?? '';
      if (auth !== `Bearer ${token}`) { res.writeHead(401).end('{"error":"bad token"}'); return; }
      if (status === 400) { res.writeHead(400).end('{"error":"not a workspace directory: /etc"}'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"opened":true}');
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/open`;
  return { url, seen, close: () => new Promise(r => server.close(r)) };
}

const cfg = url => ({ url: 'https://zed.example.com', launchUrl: url, token: 'unit-token' });

test('zed_not_configured without a config (503)', async () => {
  const r = await openInZed(null, '/workspace/web-pi');
  assert.equal(r.ok, false);
  assert.equal(r.errorCode, 'zed_not_configured');
  const res = zedOpenFailureResponse(r);
  assert.equal(res.status, 503);
  assert.equal((await res.json()).code, 'zed_not_configured');
});

test('invalid_path: relative, missing and non-directory paths never reach the launcher', async t => {
  const stub = await startStubLauncher();
  t.after(() => stub.close());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zed-unit-'));
  fs.writeFileSync(path.join(dir, 'file.txt'), 'x');

  for (const bad of ['workspace/web-pi', '/no/such/dir', path.join(dir, 'file.txt')]) {
    const r = await openInZed(cfg(stub.url), bad);
    assert.equal(r.ok, false, bad);
    assert.equal(r.errorCode, 'invalid_path', bad);
    assert.equal(zedOpenFailureResponse(r).status, 400);
  }
  assert.equal(stub.seen.length, 0, 'nothing was sent to the launcher');
});

test('a directory reaches the launcher with the bearer token and path (200)', async t => {
  const stub = await startStubLauncher();
  t.after(() => stub.close());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zed-unit-'));

  const r = await openInZed(cfg(stub.url), dir);
  assert.equal(r.ok, true, r.errorMessage);
  assert.deepEqual(r.data, { path: dir });
  assert.equal(stub.seen.length, 1);
  assert.equal(stub.seen[0].auth, 'Bearer unit-token');
  assert.deepEqual(JSON.parse(stub.seen[0].body), { path: dir });
});

test('launcher_unreachable: no listener on the port (502)', async () => {
  const stub = await startStubLauncher();
  const url = stub.url; // a port that had a listener, then didn't
  await stub.close();
  // the directory check runs first, so give it one that exists
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zed-unit-'));

  const r = await openInZed(cfg(url), dir);
  assert.equal(r.ok, false);
  assert.equal(r.errorCode, 'launcher_unreachable');
  const res = zedOpenFailureResponse(r);
  assert.equal(res.status, 502);
  assert.equal((await res.json()).code, 'launcher_unreachable');
});

test('launch_failed: the launcher answers 401 for a bad token (502)', async t => {
  const stub = await startStubLauncher({ token: 'a-different-token' });
  t.after(() => stub.close());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zed-unit-'));

  const r = await openInZed(cfg(stub.url), dir);
  assert.equal(r.ok, false);
  assert.equal(r.errorCode, 'launch_failed');
  assert.equal(zedOpenFailureResponse(r).status, 502);
});

test('invalid_path echoed back when the launcher rejects it (400)', async t => {
  const stub = await startStubLauncher({ status: 400 });
  t.after(() => stub.close());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zed-unit-'));

  // the web side's checks pass (it IS a directory), the launcher's don't
  const r = await openInZed(cfg(stub.url), dir);
  assert.equal(r.ok, false);
  assert.equal(r.errorCode, 'invalid_path');
  assert.match(r.errorMessage, /launcher rejected|workspace/);
  const res = zedOpenFailureResponse(r);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, 'invalid_path');
});

// ---------- WEB_PI_ZED_* boot checks (src/lib/env.ts) ----------

/** readZedConfig() in a fresh process (RAW_ENV is read at module load), or its error. */
function bootConfig(env) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('WEB_PI_ZED_')));
  try {
    const out = execFileSync(process.execPath, ['-e',
      "process.stdout.write(JSON.stringify(require('./dist-server/src/lib/env.js').readZedConfig()))"],
      { env: { ...clean, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    return { config: JSON.parse(out.toString()) };
  } catch (err) {
    return { error: err.stderr.toString() };
  }
}

test('env: no WEB_PI_ZED_URL is off, whatever plumbing is present (the compose states)', () => {
  // plain `docker compose up -d`, the zed profile never deployed: URL
  // empty, launch URL defaulted by compose, no token — must boot off.
  assert.deepEqual(
    bootConfig({ WEB_PI_ZED_URL: '', WEB_PI_ZED_LAUNCH_URL: 'http://zed:7999/open' }),
    { config: null });
  // the zed profile deployed once, then the console link removed: the
  // launch pair lingers (compose default + zed-init's token file) — must
  // still boot off, not crash on the leftovers.
  assert.deepEqual(
    bootConfig({ WEB_PI_ZED_LAUNCH_URL: 'http://zed:7999/open', WEB_PI_ZED_LAUNCH_TOKEN: 't' }),
    { config: null });
});

test('env: URL + launcher pair configure the webapp', () => {
  assert.deepEqual(bootConfig({
    WEB_PI_ZED_URL: 'https://zed.example.com',
    WEB_PI_ZED_LAUNCH_URL: 'http://zed:7999/open',
    WEB_PI_ZED_LAUNCH_TOKEN: 't',
  }), { config: { url: 'https://zed.example.com', launchUrl: 'http://zed:7999/open', token: 't' } });
});

test('env: a URL without the launcher pair stops the boot (zed profile not deployed?)', () => {
  assert.match(bootConfig({ WEB_PI_ZED_URL: 'https://zed.example.com', WEB_PI_ZED_LAUNCH_URL: 'http://zed:7999/open' }).error,
    /WEB_PI_ZED_URL is set but WEB_PI_ZED_LAUNCH_TOKEN is not/);
  assert.match(bootConfig({ WEB_PI_ZED_URL: 'https://zed.example.com', WEB_PI_ZED_LAUNCH_TOKEN: 't' }).error,
    /WEB_PI_ZED_URL is set but WEB_PI_ZED_LAUNCH_URL is not/);
});

test('env: non-http(s) URLs stop the boot', () => {
  const pair = { WEB_PI_ZED_LAUNCH_URL: 'http://zed:7999/open', WEB_PI_ZED_LAUNCH_TOKEN: 't' };
  assert.match(bootConfig({ ...pair, WEB_PI_ZED_URL: 'zed.example.com' }).error,
    /WEB_PI_ZED_URL="zed.example.com" is not an http\(s\) URL/);
  assert.match(
    bootConfig({ ...pair, WEB_PI_ZED_URL: 'https://zed.example.com', WEB_PI_ZED_LAUNCH_URL: 'ftp://zed:7999' }).error,
    /WEB_PI_ZED_LAUNCH_URL="ftp:\/\/zed:7999" is not an http\(s\) URL/);
});
