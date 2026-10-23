// editor.test.mjs — src/lib/editor.ts (the same-origin editor proxy's
// policy surface, docs/editor-webapp.md) + the CYBERMOLE_EDITOR_UPSTREAM boot
// checks (src/lib/env.ts). One test per behavior the proxy relies on: path
// routing (HTTP + WS), the header set that overrides the global DENY, the
// body-cap/chunked policy, the upstream WS handshake headers (the
// regression guard: a stripped-header request never gets a 101 — verified
// against a live upgrade server during review; kept pure here because
// detached upgrade sockets are unreliable under this sandbox's node:test),
// per-token tunnel tracking, and the env var's shape validation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  EditorTunnelTracker,
  EDITOR_MAX_BODY_BYTES,
  editorBodyCapStatus,
  editorSecurityHeaders,
  editorUpgradeHeaders,
  isEditorHttpPath,
  isEditorUpgradePath,
} from '../../dist-server/src/lib/editor.js';

// ---------- path routing ----------

test('isEditorHttpPath: /editor and below, under any base — nothing else', () => {
  for (const base of ['/', '/foo']) {
    const p = s => (base === '/' ? s : base + s);
    assert.ok(isEditorHttpPath(base, p('/editor')), `${base} exact`);
    assert.ok(isEditorHttpPath(base, p('/editor/')), `${base} root slash`);
    assert.ok(
      isEditorHttpPath(
        base,
        p('/editor/stable-807ba2d/out/vs/code/browser/workbench/workbench.js'),
      ),
      `${base} asset`,
    );
    assert.ok(
      isEditorHttpPath(base, p('/editor/foo?folder=%2Fworkspace')),
      `${base} query split upstream`,
    );
    // /editorial must NOT match; nor paths outside the base.
    assert.ok(!isEditorHttpPath(base, p('/editorial')), `${base} /editorial`);
    assert.ok(!isEditorHttpPath(base, p('/api/editor')), `${base} /api/editor`);
    assert.ok(!isEditorHttpPath(base, p('/')), `${base} app root`);
  }
  // outside the base entirely (base=/foo, plain /editor)
  assert.ok(!isEditorHttpPath('/foo', '/editor'));
  assert.ok(!isEditorHttpPath('/foo', '/editoredit'));
});

test('isEditorUpgradePath: prefix under /editor/, for the stable-<commit> WS dial', () => {
  assert.ok(isEditorUpgradePath('/', '/editor/stable-807ba2d6075c29587f884698cd7370c81ab0724c'));
  assert.ok(isEditorUpgradePath('/foo', '/foo/editor/stable-807ba2d'));
  assert.ok(!isEditorUpgradePath('/', '/editor'), 'bare /editor is not a workbench WS');
  assert.ok(!isEditorUpgradePath('/', '/editorial'));
  assert.ok(!isEditorUpgradePath('/foo', '/editor/stable-x'), 'outside the base');
});

// ---------- the editor header set ----------

test('editorSecurityHeaders: framable + the VS Code web CSP the spike pinned', () => {
  const h = editorSecurityHeaders();
  // The console frames the editor: the global X-Frame-Options DENY must be
  // overridden (hardenResponse keeps handler-set headers), and CSP
  // frame-ancestors must allow same-origin framing.
  assert.equal(h['X-Frame-Options'], 'SAMEORIGIN');
  const csp = h['Content-Security-Policy'];
  assert.match(csp, /frame-ancestors 'self'/);
  // blob workers (the web-worker extension host) and data/blob images —
  // verified against a real browser (docs/editor-spike.md).
  assert.match(csp, /worker-src 'self' blob:/);
  assert.match(csp, /img-src 'self' data: blob:/);
  // same-origin frames: the webWorkerExtensionHostIframe
  assert.match(csp, /frame-src 'self'/);
  // the marketplace is deliberately NOT in connect-src: gallery queries
  // ride the remote tunnel (server-side egress), and the browser-side
  // advisory fetches degrade gracefully when refused (spike-verified)
  assert.match(csp, /connect-src 'self' ws: wss:/);
  assert.ok(!csp.includes('open-vsx'), 'open-vsx.org must not be in the browser CSP');
  assert.ok(!csp.includes('githubusercontent'), 'raw.githubusercontent.com must not be either');
});

// ---------- body cap: large saves, chunked accepted, never 411 ----------

test('editorBodyCapStatus: sized to a big save, chunked accepted, small bodies pass', () => {
  assert.equal(
    EDITOR_MAX_BODY_BYTES,
    5 * 1024 * 1024 * 1024 + 1024 * 1024,
    'the upload cap — a large editor save',
  );
  const post = headers => ({ method: 'POST', headers });
  // never 411: a length-less (chunked) body is accepted and stall-guarded
  assert.equal(editorBodyCapStatus(post({ 'transfer-encoding': 'chunked' })), null);
  assert.equal(editorBodyCapStatus(post({})), null);
  assert.equal(editorBodyCapStatus(post({ 'content-length': '2048' })), null);
  assert.equal(
    editorBodyCapStatus(post({ 'content-length': String(EDITOR_MAX_BODY_BYTES) })),
    null,
  );
  assert.equal(
    editorBodyCapStatus(post({ 'content-length': String(EDITOR_MAX_BODY_BYTES + 1) })),
    413,
  );
  assert.equal(
    editorBodyCapStatus({
      method: 'PUT',
      headers: { 'content-length': String(EDITOR_MAX_BODY_BYTES + 1) },
    }),
    413,
  );
  // GET/HEAD carry no body
  assert.equal(
    editorBodyCapStatus({ method: 'GET', headers: { 'content-length': '999999999999' } }),
    null,
  );
  assert.equal(editorBodyCapStatus({ method: 'HEAD', headers: {} }), null);
});

// ---------- the upstream WS handshake headers ----------

test('editorUpgradeHeaders: hop-by-hop out, the upgrade pair in, the load-bearing rest preserved', () => {
  const incoming = {
    host: 'cybermole.example.com', // load-bearing: the editor embeds it
    connection: 'keep-alive', // hop-by-hop: must go...
    'keep-alive': 'timeout=5',
    'transfer-encoding': 'chunked',
    upgrade: 'websocket', // ...and come back as the explicit pair
    'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
    'sec-websocket-version': '13',
    cookie: 'cybermole_session=t',
  };
  const h = editorUpgradeHeaders(incoming);
  // Without Connection: Upgrade no upstream ever answers 101 — every editor
  // tunnel dial fails — which is the regression this guards (found in
  // review: the transport once sent the stripped headers verbatim).
  assert.equal(h.connection, 'Upgrade');
  assert.equal(h.upgrade, 'websocket');
  assert.equal(h['keep-alive'], undefined);
  assert.equal(h['transfer-encoding'], undefined);
  assert.equal(h.host, 'cybermole.example.com');
  assert.equal(h['sec-websocket-key'], 'dGhlIHNhbXBsZSBub25jZQ==');
  assert.equal(h.cookie, 'cybermole_session=t');
  // no Upgrade in the incoming (a bare probe): default to websocket
  const bare = editorUpgradeHeaders({ host: 'x' });
  assert.equal(bare.connection, 'Upgrade');
  assert.equal(bare.upgrade, 'websocket');
  // the input is not mutated
  assert.equal(incoming.connection, 'keep-alive');
});

// ---------- per-token tunnel tracking ----------

test('EditorTunnelTracker: logout cuts only that token; closeAll cuts everything; untrack cleans up', () => {
  const tracker = new EditorTunnelTracker();
  const closed = [];
  const mk = name => ({
    name,
    close() {
      closed.push(name);
    },
  });
  const t1 = mk('a1'),
    t2 = mk('a2'),
    t3 = mk('b1');
  tracker.track('token-a', t1);
  tracker.track('token-a', t2);
  tracker.track('token-b', t3);
  assert.equal(tracker.count(), 3);

  tracker.closeToken('token-a');
  assert.deepEqual(closed.sort(), ['a1', 'a2'], "token-a's tunnels die, token-b's live");
  assert.equal(tracker.count(), 1);
  // idempotent: a second closeToken on an empty token set is a no-op
  tracker.closeToken('token-a');
  assert.equal(closed.length, 2);

  // a tunnel that ends on its own is untracked: a later closeAll won't
  // call close() on it again (close() destroys sockets — keep it once)
  tracker.untrack('token-b', t3);
  tracker.closeAll();
  assert.deepEqual(closed.sort(), ['a1', 'a2'], 'the untracked tunnel was not re-closed');
  assert.equal(tracker.count(), 0);

  // re-track after closeAll works (new windows on the same token)
  tracker.track('token-b', t3);
  assert.equal(tracker.count(), 1);
  tracker.closeToken('token-b');
  assert.deepEqual(closed, ['a1', 'a2', 'b1']);
});

// ---------- CYBERMOLE_EDITOR_UPSTREAM boot checks (src/lib/env.ts) ----------

/** readEditorUpstream() in a fresh process (RAW_ENV is read at module load). */
function bootUpstream(env) {
  const clean = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => k !== 'CYBERMOLE_EDITOR_UPSTREAM'),
  );
  try {
    const out = execFileSync(
      process.execPath,
      [
        '-e',
        "process.stdout.write(JSON.stringify(require('./dist-server/src/lib/env.js').readEditorUpstream()))",
      ],
      { env: { ...clean, ...env }, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return { config: JSON.parse(out.toString()) };
  } catch (err) {
    return { error: err.stderr.toString() };
  }
}

test('env: unset or empty CYBERMOLE_EDITOR_UPSTREAM is off (compose `VAR: ""` states)', () => {
  assert.deepEqual(bootUpstream({}), { config: null });
  assert.deepEqual(bootUpstream({ CYBERMOLE_EDITOR_UPSTREAM: '' }), { config: null });
  assert.deepEqual(bootUpstream({ CYBERMOLE_EDITOR_UPSTREAM: '   ' }), { config: null });
});

test('env: a clean http(s) origin configures the proxy', () => {
  assert.deepEqual(bootUpstream({ CYBERMOLE_EDITOR_UPSTREAM: 'http://editor:3000' }), {
    config: { origin: 'http://editor:3000' },
  });
  assert.deepEqual(bootUpstream({ CYBERMOLE_EDITOR_UPSTREAM: 'https://editor.internal:8443' }), {
    config: { origin: 'https://editor.internal:8443' },
  });
});

test('env: malformed values stop the boot (operator mistake, like object storage)', () => {
  assert.match(
    bootUpstream({ CYBERMOLE_EDITOR_UPSTREAM: 'editor:3000' }).error,
    /is not an http\(s\) URL/,
  );
  assert.match(
    bootUpstream({ CYBERMOLE_EDITOR_UPSTREAM: 'ftp://editor:3000' }).error,
    /is not an http\(s\) URL/,
  );
  // a path would be silently dropped by the origin-only proxy — refuse it
  assert.match(
    bootUpstream({ CYBERMOLE_EDITOR_UPSTREAM: 'http://editor:3000/editor' }).error,
    /must be an origin only/,
  );
  assert.match(
    bootUpstream({ CYBERMOLE_EDITOR_UPSTREAM: 'http://editor:3000/?tkn=x' }).error,
    /must be an origin only/,
  );
});
