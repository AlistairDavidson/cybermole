// /ws/events: every branch of the upgrade gate, and the relay end to end
// (one frame per bus event; a dead token closes with signed-out) over a real
// http server and ws client.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import { WebSocket } from 'ws';

const { checkEventsUpgrade, EventsRelay } =
  await import('../../dist-server/src/lib/platform/events-ws.js');
const { emitDomainEvent } = await import('../../dist-server/src/lib/platform/events.js');

const TOKEN = 'tok-1';
const noSession = {
  ok: false,
  resultType: 'session_check',
  errorCode: 'no_session',
  errorMessage: 'no such session',
};
const storeDown = {
  ok: false,
  resultType: 'session_check',
  errorCode: 'database_error',
  errorMessage: 'store down',
};
const session = { ok: true, resultType: 'session_check', data: { token: TOKEN } };

const reqWith = headers => ({ headers });

/** A missed frame would otherwise hang the suite. */
const within = (promise, ms, label) =>
  Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout: ${label}`)), ms)),
  ]);

test('checkEventsUpgrade: allow, and every refusal branch', () => {
  const checks = over => ({
    shuttingDown: () => over?.down ?? false,
    allow: () => over?.limited !== true,
    originOk: () => over?.badOrigin !== true,
    validSession: () => over?.session ?? session,
  });
  const origin = { origin: 'https://console.example' };

  assert.deepEqual(checkEventsUpgrade(reqWith(origin), '1.1.1.1', checks()), {
    ok: true,
    token: TOKEN,
  });
  assert.deepEqual(checkEventsUpgrade(reqWith(origin), '1.1.1.1', checks({ down: true })), {
    ok: false,
    reply: 'destroy',
    why: 'server shutting down',
  });
  assert.deepEqual(checkEventsUpgrade(reqWith(origin), '1.1.1.1', checks({ limited: true })), {
    ok: false,
    reply: 'destroy',
    why: 'rate-limited',
  });
  // Browser-only: a missing or mismatched Origin is destroyed.
  assert.deepEqual(checkEventsUpgrade(reqWith({}), '1.1.1.1', checks()), {
    ok: false,
    reply: 'destroy',
    why: 'missing or mismatched Origin',
  });
  assert.deepEqual(checkEventsUpgrade(reqWith(origin), '1.1.1.1', checks({ badOrigin: true })), {
    ok: false,
    reply: 'destroy',
    why: 'missing or mismatched Origin',
  });
  // no session → 401, an unreadable store → 503
  assert.deepEqual(checkEventsUpgrade(reqWith(origin), '1.1.1.1', checks({ session: noSession })), {
    ok: false,
    reply: 'status',
    status: '401 Unauthorized',
    why: 'no valid session',
  });
  assert.deepEqual(checkEventsUpgrade(reqWith(origin), '1.1.1.1', checks({ session: storeDown })), {
    ok: false,
    reply: 'status',
    status: '503 Service Unavailable',
    why: 'store down',
  });
});

/** Wired as main.ts wires it, on a private port. `alive` flips when the token dies. */
function bootRelay() {
  let tokenAlive = true;
  const relay = new EventsRelay({
    alive: () => (tokenAlive ? session : noSession),
    log: { info() {}, warn() {}, error() {} },
    pingMs: 40,
  });
  relay.start();
  const server = http.createServer((_req, res) => {
    res.destroy();
  });
  server.on('upgrade', (req, socket, head) => {
    const decision = checkEventsUpgrade(req, '127.0.0.1', {
      shuttingDown: () => false,
      allow: () => true,
      originOk: () => req.headers.origin === 'http://console.test',
      validSession: () => (req.headers.cookie === `cybermole=${TOKEN}` ? session : noSession),
    });
    if (!decision.ok) {
      if (decision.reply === 'status')
        socket.write(`HTTP/1.1 ${decision.status}\r\nX-Test: gated\r\n\r\n`);
      socket.destroy();
      return;
    }
    relay.handleUpgrade(req, socket, head, decision.token);
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () =>
      resolve({
        relay,
        server,
        url: `ws://127.0.0.1:${server.address().port}/ws/events`,
        killToken: () => {
          tokenAlive = false;
        },
      }),
    );
  });
}

const openClient = url =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(url, {
      origin: 'http://console.test',
      headers: { cookie: `cybermole=${TOKEN}` },
    });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });

const frames = ws =>
  new Promise((resolve, reject) => {
    ws.once('message', data => {
      try {
        resolve(JSON.parse(String(data)));
      } catch (e) {
        reject(e);
      }
    });
    ws.once('close', () => reject(new Error('closed before a frame')));
  });

test('relay: boot, connect, forward — one frame per event, then signed-out closes', async () => {
  const { relay, server, url, killToken } = await bootRelay();
  try {
    const ws = await openClient(url);
    const next = frames(ws);
    emitDomainEvent({ topic: 'jobs', type: 'run_started', job: 'nightly', firedAt: 7 });
    assert.deepEqual(await within(next, 2000, 'first frame'), {
      topic: 'jobs',
      type: 'run_started',
      job: 'nightly',
      firedAt: 7,
    });

    // start() is idempotent: subscribing twice would double the frames
    relay.start();
    let received = 0;
    const counted = new Promise(resolve =>
      ws.on('message', () => {
        received++;
        setTimeout(resolve, 120);
      }),
    );
    emitDomainEvent({ topic: 'jobs', type: 'job_updated', job: 'nightly' });
    await counted;
    assert.equal(received, 1, 'exactly one frame per event');

    // A dead token: signed-out, then close (not a reconnectable drop).
    killToken();
    const final = await within(frames(ws), 2000, 'signed-out frame');
    assert.deepEqual(final, { type: 'signed-out' });
    await within(
      new Promise((resolve, reject) => {
        ws.once('close', resolve);
        ws.once('error', reject);
      }),
      2000,
      'socket closed',
    );
    ws.close();
  } finally {
    relay.stop({ type: 'restart' });
    server.close();
    await new Promise(resolve => server.once('close', resolve));
  }
});

test('relay: a second authenticated client receives the same event', async () => {
  const { relay, server, url } = await bootRelay();
  try {
    const a = await openClient(url);
    const b = await openClient(url);
    const nextA = frames(a);
    const nextB = frames(b);
    emitDomainEvent({ topic: 'jobs', type: 'job_deleted', job: 'gone' });
    assert.deepEqual(await nextA, { topic: 'jobs', type: 'job_deleted', job: 'gone' });
    assert.deepEqual(await nextB, { topic: 'jobs', type: 'job_deleted', job: 'gone' });
    a.close();
    b.close();
  } finally {
    relay.stop({ type: 'restart' });
    server.close();
    await new Promise(resolve => server.once('close', resolve));
  }
});

test('the cookie gate refuses an upgrade without a session (401), destroys without an Origin', async () => {
  const { relay, server, url } = await bootRelay();
  const { port } = new URL(url);
  try {
    // no cookie: 401, a failed upgrade
    const refused = await within(
      new Promise((resolve, reject) => {
        const r = http.request({
          host: '127.0.0.1',
          port,
          path: '/ws/events',
          headers: {
            Connection: 'Upgrade',
            Upgrade: 'websocket',
            'Sec-WebSocket-Version': '13',
            'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
            Origin: 'http://console.test',
          },
        });
        r.on('response', resolve);
        r.on('upgrade', () => reject(new Error('upgraded without a session')));
        r.on('error', reject);
        r.end();
      }),
      2000,
      '401 answer',
    );
    assert.equal(refused.statusCode, 401);

    // no Origin: destroyed with no HTTP answer
    const destroyed = await within(
      new Promise((resolve, reject) => {
        const r = http.request({
          host: '127.0.0.1',
          port,
          path: '/ws/events',
          headers: {
            Connection: 'Upgrade',
            Upgrade: 'websocket',
            'Sec-WebSocket-Version': '13',
            'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
          },
        });
        r.on('response', () => reject(new Error('answered a missing-Origin upgrade')));
        r.on('upgrade', () => reject(new Error('upgraded without an Origin')));
        r.on('error', () => resolve('refused'));
        r.end();
      }),
      2000,
      'missing-Origin refusal',
    );
    assert.equal(destroyed, 'refused');
  } finally {
    relay.stop({ type: 'restart' });
    server.close();
    await new Promise(resolve => server.once('close', resolve));
  }
});
