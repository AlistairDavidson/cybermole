// editor.ts's proxy policy and the CYBERMOLE_EDITOR_UPSTREAM checks: path
// routing, the header set overriding DENY, the body cap, the upstream WS
// handshake headers, per-token tunnel tracking. The handshake is tested pure
// because detached upgrade sockets are unreliable under node:test here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  EditorTunnelTracker,
  EDITOR_HTML_REWRITE_MAX_BYTES,
  EDITOR_MAX_BODY_BYTES,
  EDITOR_THEME_CONFIGURATION_DEFAULTS,
  editorBodyCapStatus,
  editorSecurityHeaders,
  editorUpgradeHeaders,
  injectWorkbenchThemeDefaults,
  isEditorHttpPath,
  isEditorUpgradePath,
} from '../../dist-server/src/lib/terminals/editor.js';

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
    // /editorial must not match, nor paths outside the base
    assert.ok(!isEditorHttpPath(base, p('/editorial')), `${base} /editorial`);
    assert.ok(!isEditorHttpPath(base, p('/api/editor')), `${base} /api/editor`);
    assert.ok(!isEditorHttpPath(base, p('/')), `${base} app root`);
  }
  // outside the base (base=/foo, plain /editor)
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

// ---------- header set ----------

test('editorSecurityHeaders: framable + the VS Code web CSP the spike pinned', () => {
  const h = editorSecurityHeaders();
  // The console frames the editor: DENY must be overridden and
  // frame-ancestors allow same-origin.
  assert.equal(h['X-Frame-Options'], 'SAMEORIGIN');
  const csp = h['Content-Security-Policy'];
  assert.match(csp, /frame-ancestors 'self'/);
  // blob workers (the extension host) and data/blob images
  assert.match(csp, /worker-src 'self' blob:/);
  assert.match(csp, /img-src 'self' data: blob:/);
  // same-origin frames: the extension host iframe
  assert.match(csp, /frame-src 'self'/);
  // no marketplace in connect-src: gallery queries go via the editor container
  assert.match(csp, /connect-src 'self' ws: wss:/);
  assert.ok(!csp.includes('open-vsx'), 'open-vsx.org must not be in the browser CSP');
  assert.ok(!csp.includes('githubusercontent'), 'raw.githubusercontent.com must not be either');
});

// ---------- body cap: large, chunked accepted, never 411 ----------

test('editorBodyCapStatus: sized to a big save, chunked accepted, small bodies pass', () => {
  assert.equal(
    EDITOR_MAX_BODY_BYTES,
    5 * 1024 * 1024 * 1024 + 1024 * 1024,
    'the upload cap — a large editor save',
  );
  const post = headers => ({ method: 'POST', headers });
  // chunked is accepted and stall-guarded
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
  assert.equal(
    editorBodyCapStatus({ method: 'GET', headers: { 'content-length': '999999999999' } }),
    null,
  );
  assert.equal(editorBodyCapStatus({ method: 'HEAD', headers: {} }), null);
});

// ---------- boot document colour-scheme injection ----------

/** The real boot document's shape: construction options in an
 *  HTML-escaped meta tag. The workbench reads no ?theme= param. */
const BOOT_DOC = `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta id="vscode-workbench-web-configuration" data-settings="{&quot;remoteAuthority&quot;:&quot;127.0.0.1:3999&quot;,&quot;serverBasePath&quot;:&quot;/&quot;,&quot;enableWorkspaceTrust&quot;:false,&quot;callbackRoute&quot;:&quot;/stable-807/callback&quot;}">
  </head>
  <body aria-label="">
  </body>
</html>`;

const injectedDoc = injectWorkbenchThemeDefaults(BOOT_DOC);
const injectedMeta = /data-settings="([^"]*)"/.exec(injectedDoc)?.[1] ?? '';
const injectedConfig = JSON.parse(injectedMeta.replaceAll('&quot;', '"').replaceAll('&amp;', '&'));

test('injectWorkbenchThemeDefaults: the color-scheme defaults land in the construction options, everything else intact', () => {
  assert.equal(
    injectedConfig.configurationDefaults['window.autoDetectColorScheme'],
    true,
    'the workbench must follow the browser scheme (verified against a real boot)',
  );
  assert.equal(
    injectedConfig.configurationDefaults['workbench.preferredDarkColorTheme'],
    EDITOR_THEME_CONFIGURATION_DEFAULTS['workbench.preferredDarkColorTheme'],
  );
  assert.equal(
    injectedConfig.configurationDefaults['workbench.preferredLightColorTheme'],
    EDITOR_THEME_CONFIGURATION_DEFAULTS['workbench.preferredLightColorTheme'],
  );
  // the rest survives verbatim (remoteAuthority is how the browser dials back)
  assert.equal(injectedConfig.remoteAuthority, '127.0.0.1:3999');
  assert.equal(injectedConfig.serverBasePath, '/');
  assert.equal(injectedConfig.enableWorkspaceTrust, false);
  assert.equal(injectedConfig.callbackRoute, '/stable-807/callback');
  // the document around the meta is untouched
  assert.ok(injectedDoc.startsWith('<!DOCTYPE html>\n<html>\n  <head>'));
  assert.ok(injectedDoc.endsWith('  </body>\n</html>'));
});

test('injectWorkbenchThemeDefaults: attribute escaping round-trips (&amp; in, &amp; out)', () => {
  // & in the JSON survives as & (no double escape)
  const doc = BOOT_DOC.replace(
    '&quot;serverBasePath&quot;:&quot;/&quot;',
    '&quot;serverBasePath&quot;:&quot;/a&amp;b&quot;',
  );
  const out = JSON.parse(
    (/data-settings="([^"]*)"/.exec(injectWorkbenchThemeDefaults(doc))?.[1] ?? '')
      .replaceAll('&quot;', '"')
      .replaceAll('&amp;', '&'),
  );
  assert.equal(out.serverBasePath, '/a&b');
});

test('injectWorkbenchThemeDefaults: existing configurationDefaults are kept (a default never clobbers an embedder setting)', () => {
  const doc = BOOT_DOC.replace(
    'enableWorkspaceTrust&quot;:false',
    'enableWorkspaceTrust&quot;:false,&quot;configurationDefaults&quot;:{&quot;workbench.preferredDarkColorTheme&quot;:&quot;Abyss&quot;,&quot;editor.fontSize&quot;:14}',
  );
  const out = JSON.parse(
    (/data-settings="([^"]*)"/.exec(injectWorkbenchThemeDefaults(doc))?.[1] ?? '')
      .replaceAll('&quot;', '"')
      .replaceAll('&amp;', '&'),
  );
  assert.equal(out.configurationDefaults['editor.fontSize'], 14, 'unrelated keys pass through');
  // ours win for our keys only, on top of the embedder's
  assert.equal(
    out.configurationDefaults['workbench.preferredDarkColorTheme'],
    EDITOR_THEME_CONFIGURATION_DEFAULTS['workbench.preferredDarkColorTheme'],
  );
});

test('injectWorkbenchThemeDefaults: no meta tag / invalid JSON degrades to the input untouched (upstream shape change, never a dead editor)', () => {
  // no meta at all (an error page)
  const noMeta = '<!DOCTYPE html><html><head><title>502</title></head></html>';
  assert.equal(injectWorkbenchThemeDefaults(noMeta), noMeta);
  // the meta with broken JSON
  const badJson = BOOT_DOC.replace(
    /data-settings="[^"]*"/,
    'data-settings="{&quot;remoteAuthority&quot;:,&quot;}',
  );
  assert.equal(injectWorkbenchThemeDefaults(badJson), badJson);
  // a real byte cap: the boot doc is a few KiB
  assert.ok(EDITOR_HTML_REWRITE_MAX_BYTES >= 4096);
  assert.ok(EDITOR_HTML_REWRITE_MAX_BYTES < 1_000_000);
});

// ---------- upstream WS handshake headers ----------

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
  // Without Connection: Upgrade no upstream answers 101.
  assert.equal(h.connection, 'Upgrade');
  assert.equal(h.upgrade, 'websocket');
  assert.equal(h['keep-alive'], undefined);
  assert.equal(h['transfer-encoding'], undefined);
  assert.equal(h.host, 'cybermole.example.com');
  assert.equal(h['sec-websocket-key'], 'dGhlIHNhbXBsZSBub25jZQ==');
  assert.equal(h.cookie, 'cybermole_session=t');
  // no Upgrade incoming: default to websocket
  const bare = editorUpgradeHeaders({ host: 'x' });
  assert.equal(bare.connection, 'Upgrade');
  assert.equal(bare.upgrade, 'websocket');
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
  // idempotent on an empty token
  tracker.closeToken('token-a');
  assert.equal(closed.length, 2);

  // a tunnel that ended on its own isn't closed again (close() destroys sockets)
  tracker.untrack('token-b', t3);
  tracker.closeAll();
  assert.deepEqual(closed.sort(), ['a1', 'a2'], 'the untracked tunnel was not re-closed');
  assert.equal(tracker.count(), 0);

  // re-track after closeAll (new windows on the same token)
  tracker.track('token-b', t3);
  assert.equal(tracker.count(), 1);
  tracker.closeToken('token-b');
  assert.deepEqual(closed, ['a1', 'a2', 'b1']);
});

// ---------- CYBERMOLE_EDITOR_UPSTREAM ----------

/** In a fresh process: RAW_ENV is read at module load. */
function bootUpstream(env) {
  const clean = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => k !== 'CYBERMOLE_EDITOR_UPSTREAM'),
  );
  try {
    const out = execFileSync(
      process.execPath,
      [
        '-e',
        "process.stdout.write(JSON.stringify(require('./dist-server/src/lib/platform/env.js').readEditorUpstream()))",
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
  // the origin-only proxy would drop a path silently: refuse it
  assert.match(
    bootUpstream({ CYBERMOLE_EDITOR_UPSTREAM: 'http://editor:3000/editor' }).error,
    /must be an origin only/,
  );
  assert.match(
    bootUpstream({ CYBERMOLE_EDITOR_UPSTREAM: 'http://editor:3000/?tkn=x' }).error,
    /must be an origin only/,
  );
});
