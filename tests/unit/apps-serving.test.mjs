// apps-serving.test.mjs — task/app-web (apps-plan §4) units: GET
// /api/state's serving flag source — the app host /_admin/status ping
// over a REAL tmp-dir unix socket (a stub host, counting requests),
// plus the pure join. Covers: the snapshot parse, the single-flight +
// TTL cache (one attempt per window — concurrent callers share it), the
// NEGATIVE cache (a failure answers from cache until the window passes,
// then retries), the off surface (socketPath null: serving:false
// forever, zero requests), malformed host answers degrading to
// failures, and joinServing's honest reasons (mounted / the host's own
// skip reason / not-mounted / unreachable).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cybermole-apps-serving-'));

const { AppsServing, joinServing } = await import('../../dist-server/src/lib/apps-serving.js');

/** A stub app host serving GET /_admin/status with the given payload,
 *  counting requests. */
function stubHost(socketPath, payload) {
  const state = { requests: 0 };
  const server = http.createServer((_req, res) => {
    state.requests++;
    if (payload instanceof Error) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end('{}');
      return;
    }
    if (payload === 'garbage') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('this is not json');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
  return {
    state,
    listen: () =>
      new Promise(resolve => {
        fs.mkdirSync(path.dirname(socketPath), { recursive: true });
        server.listen(socketPath, resolve);
      }),
    close: () =>
      new Promise(resolve => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

const STATUS_OK = {
  me: 'app-host',
  booted: true,
  mounted: [{ slug: 'fixture', base: '/apps/fixture' }],
  skipped: [{ slug: 'half-built', reason: 'app.json missing' }],
};

const APPS = [
  { id: '1', name: 'Fixture', slug: 'fixture', cwd: null, order: 10 },
  { id: '2', name: 'Half Built', slug: 'half-built', cwd: '/tmp/x', order: 20 },
  { id: '3', name: 'Group Row', slug: 'group-row', cwd: null, order: 30 },
];

test('info(): reachable snapshot from a real host ping; cached within the window (one request)', async () => {
  const socketPath = path.join(dir, 'ok.sock');
  const host = stubHost(socketPath, STATUS_OK);
  await host.listen();
  const serving = new AppsServing({ socketPath, ttlMs: 10_000 });
  try {
    const info = await serving.info();
    assert.equal(info.reachable, true);
    assert.equal(info.failureReason, null);
    assert.equal(info.status.booted, true);
    assert.equal(info.status.mounted.has('fixture'), true);
    assert.equal(info.status.skipped.get('half-built'), 'app.json missing');
    // The cached window: a second caller (another tab's poll) does not ping.
    const again = await serving.info();
    assert.equal(again.reachable, true);
    assert.equal(host.state.requests, 1);
  } finally {
    await host.close();
  }
});

test('the failure is NEGATIVELY cached: a dead host answers from cache until the window passes, then retries', async () => {
  const socketPath = path.join(dir, 'down.sock');
  // Nothing on the socket yet.
  const serving = new AppsServing({ socketPath, ttlMs: 80, timeoutMs: 200 });
  const dead = await serving.info();
  assert.equal(dead.reachable, false);
  assert.ok(dead.failureReason.includes('unreachable'), dead.failureReason);

  // The host comes up; the cached failure still answers (no request made).
  const host = stubHost(socketPath, STATUS_OK);
  await host.listen();
  try {
    const cached = await serving.info();
    assert.equal(cached.reachable, false, 'the failure is still cached');
    assert.equal(host.state.requests, 0);
    // Past the window the next poll retries — and succeeds.
    await new Promise(resolve => setTimeout(resolve, 100));
    const retried = await serving.info();
    assert.equal(retried.reachable, true);
    assert.equal(host.state.requests, 1);
  } finally {
    await host.close();
  }
});

test('off surface (socketPath null): serving:false with the empty-env reason, zero requests, forever stable', async () => {
  const serving = new AppsServing({ socketPath: null });
  for (let i = 0; i < 2; i++) {
    const info = await serving.info();
    assert.equal(info.reachable, false);
    assert.equal(info.failureReason, 'apps surface off (CYBERMOLE_APPS_SOCK is empty)');
    assert.equal(info.status, null);
  }
});

test('malformed host answers degrade to failures, never throws', async () => {
  for (const [label, payload] of [
    ['non-200', new Error('boom')],
    ['non-JSON body', 'garbage'],
    ['no mounted array', { me: 'app-host', booted: true, skipped: [] }],
    ['no skipped array', { me: 'app-host', booted: true, mounted: [] }],
  ]) {
    const socketPath = path.join(dir, `${label.replace(/[^a-z]+/g, '-')}.sock`);
    const host = stubHost(socketPath, payload);
    await host.listen();
    const serving = new AppsServing({ socketPath, ttlMs: 0, timeoutMs: 500 });
    try {
      const info = await serving.info();
      assert.equal(info.reachable, false, label);
      assert.ok(typeof info.failureReason === 'string' && info.failureReason !== '', label);
    } finally {
      await host.close();
    }
  }
});

test('joinServing: mounted → true; the skip reason verbatim; not mounted; unreachable', () => {
  const reachable = joinServing(APPS, {
    reachable: true,
    status: {
      booted: true,
      mounted: new Set(['fixture']),
      skipped: new Map([['half-built', 'app.json missing']]),
    },
    failureReason: null,
  });
  assert.deepEqual(
    reachable.map(a => [a.slug, a.serving, a.servingReason]),
    [
      ['fixture', true, null],
      ['half-built', false, 'app.json missing'],
      [
        'group-row',
        false,
        'not mounted — no build served for this app (build it, then reload the host)',
      ],
    ],
  );

  const down = joinServing(APPS, {
    reachable: false,
    status: null,
    failureReason: 'app host unreachable (connection refused)',
  });
  assert.equal(down[0].serving, false);
  assert.equal(down[0].servingReason, 'app host unreachable (connection refused)');

  const off = joinServing(APPS, {
    reachable: false,
    status: null,
    failureReason: 'apps surface off (CYBERMOLE_APPS_SOCK is empty)',
  });
  assert.equal(off[2].serving, false);
  assert.equal(off[2].servingReason, 'apps surface off (CYBERMOLE_APPS_SOCK is empty)');
});
