// The shared serving plumbing (src/lib/platform/http-serve.ts, compiled):
// the send helpers' header shapes, hardenResponse fill-without-override,
// logAccess quiet routing, resolveUnderDir containment, and sendStaticFile's
// MIME/cache semantics and miss paths.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';

const {
  send,
  sendText,
  sendJSON,
  hardenResponse,
  securityHeaderBlock,
  logAccess,
  resolveUnderDir,
  sendStaticFile,
} = await import('../../dist-server/src/lib/platform/http-serve.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cybermole-http-serve-'));

/** Minimal ServerResponse stand-in: captures writeHead/end, emits finish. */
function fakeRes() {
  const res = new EventEmitter();
  res.headers = {};
  res.statusCode = 0;
  res.body = undefined;
  res.headersSent = false;
  res.writeHead = (code, headers) => {
    res.statusCode = code;
    Object.assign(res.headers, headers);
    res.headersSent = true;
    return res;
  };
  res.end = body => {
    if (body !== undefined) res.body = body;
    res.headersSent = true;
    res.emit('finish');
    return res;
  };
  res.hasHeader = name => Object.hasOwn(res.headers, name);
  res.setHeader = (name, value) => {
    res.headers[name] = value;
  };
  return res;
}

/** sendStaticFile reads async; poll until the response's head is written. */
const whenServed = res =>
  new Promise(resolve => {
    const check = () => {
      if (res.headersSent) resolve();
      else setImmediate(check);
    };
    check();
  });

// ---------- send helpers ----------

test('send sets no content-type; extra headers ride, cache-control is no-store', () => {
  const res = fakeRes();
  send(res, 200, 'ok', { 'Set-Cookie': 'a=b' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, 'ok');
  assert.deepEqual(res.headers, { 'Cache-Control': 'no-store', 'Set-Cookie': 'a=b' });
});

test('sendText and sendJSON pin their content-type, still no-store', () => {
  const text = fakeRes();
  sendText(text, 404, 'not found');
  assert.deepEqual(text.headers, {
    'Cache-Control': 'no-store',
    'Content-Type': 'text/plain; charset=utf-8',
  });
  const json = fakeRes();
  sendJSON(json, 200, { error: 'not found', detail: null, code: 'not_found' });
  assert.deepEqual(json.headers, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json',
  });
  assert.equal(json.body, '{"error":"not found","detail":null,"code":"not_found"}');
});

// ---------- security headers ----------

test('securityHeaderBlock is one CRLF-terminated line per header', () => {
  const block = securityHeaderBlock();
  for (const line of block.split('\r\n').slice(0, -1)) {
    assert.match(line, /^[!#$%&'*+.^_|~0-9A-Za-z-]+: \S/);
  }
  assert.equal(
    block,
    "Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
      "connect-src 'self' wss:; frame-ancestors 'none'\r\n" +
      'X-Frame-Options: DENY\r\n' +
      'X-Content-Type-Options: nosniff\r\n' +
      'Referrer-Policy: same-origin\r\n',
  );
});

test('hardenResponse fills absent headers and never overrides a set one', () => {
  const res = fakeRes();
  res.setHeader('Content-Security-Policy', "default-src 'self'");
  hardenResponse(res);
  res.end('x');
  assert.equal(res.headers['Content-Security-Policy'], "default-src 'self'");
  assert.equal(res.headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(res.headers['X-Frame-Options'], 'DENY');
  assert.equal(res.headers['Referrer-Policy'], 'same-origin');

  // applied at writeHead when end never explicitly runs first
  const viaHead = fakeRes();
  hardenResponse(viaHead);
  viaHead.writeHead(302, { Location: '/' });
  assert.equal(viaHead.headers['X-Content-Type-Options'], 'nosniff');
});

// ---------- access log ----------

test('logAccess: one line at http, quiet paths drop to debug, query stripped', () => {
  const lines = { http: [], debug: [] };
  const log = { http: l => lines.http.push(l), debug: l => lines.debug.push(l) };
  const loud = fakeRes();
  logAccess({ method: 'GET', url: '/api/workspaces?x=1' }, loud, log, p => p === '/api/state');
  loud.emit('finish');
  assert.equal(lines.http.length, 1);
  assert.match(lines.http[0], /^GET \/api\/workspaces 0 in \d+ms$/);

  const quiet = fakeRes();
  logAccess({ method: 'GET', url: '/api/state?since=1' }, quiet, log, p => p === '/api/state');
  quiet.emit('finish');
  assert.equal(lines.debug.length, 1);
  assert.match(lines.debug[0], /^GET \/api\/state 0 in \d+ms$/);
  assert.equal(lines.http.length, 1);
});

// ---------- static files ----------

test('resolveUnderDir normalizes and rejects escapes (and the bare dir itself)', () => {
  assert.equal(
    resolveUnderDir('/srv/client', '/_astro/app.abc.js'),
    '/srv/client/_astro/app.abc.js',
  );
  assert.equal(resolveUnderDir('/srv/client', 'icons/../..'), null);
  assert.equal(resolveUnderDir('/srv/client', ''), null);
  // a sibling that shares the prefix only by name must not pass
  assert.equal(resolveUnderDir('/srv/client', '/../client-dist/x'), null);
});

test('sendStaticFile: MIME + cache policy; unknown extensions are octet-stream', async () => {
  fs.writeFileSync(path.join(dir, 'app.HASH.css'), 'body{}');
  fs.writeFileSync(path.join(dir, 'data.bin'), '\x00');

  const hashed = fakeRes();
  sendStaticFile(hashed, path.join(dir, 'app.HASH.css'), true);
  await whenServed(hashed);
  assert.equal(hashed.statusCode, 200);
  assert.equal(hashed.headers['Content-Type'], 'text/css; charset=utf-8');
  assert.equal(hashed.headers['Cache-Control'], 'public, max-age=3600');

  const plain = fakeRes();
  sendStaticFile(plain, path.join(dir, 'app.HASH.css'), false);
  await whenServed(plain);
  assert.equal(plain.headers['Cache-Control'], 'no-store');

  const bin = fakeRes();
  sendStaticFile(bin, path.join(dir, 'data.bin'), false);
  await whenServed(bin);
  assert.equal(bin.headers['Content-Type'], 'application/octet-stream');
});

test('sendStaticFile: the default miss is a bare 404; onMiss decides its own shape', async () => {
  const gone = fakeRes();
  sendStaticFile(gone, path.join(dir, 'missing.css'), false);
  await whenServed(gone);
  assert.equal(gone.statusCode, 404);
  assert.equal(gone.body, 'not found');
  assert.equal(gone.headers['Content-Type'], undefined);

  const custom = fakeRes();
  const seen = [];
  sendStaticFile(custom, path.join(dir, 'missing.css'), false, res2 => {
    seen.push(res2 === custom);
    sendText(res2, 404, 'not found');
  });
  await whenServed(custom);
  assert.deepEqual(seen, [true]);
  assert.equal(custom.headers['Content-Type'], 'text/plain; charset=utf-8');
});
