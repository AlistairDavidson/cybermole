// The shared HTTP-over-unix-socket client: real verbs against an internal API
// fixture, plus the transport-failure and timeout contracts.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import * as net from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cybermole-internal-api-client-'));
process.env.CYBERMOLE_TMUX_SOCKET = path.join(dir, 'tmux');

const { startInternalApi } = await import('../../dist-server/server/internal-api.js');
const { Scheduler } = await import('../../dist-server/src/lib/jobs/jobs.js');
const { StateDb } = await import('../../dist-server/src/lib/platform/db.js');
const { Apps } = await import('../../dist-server/src/lib/apps/apps.js');
const { requestInternalApi } =
  await import('../../dist-server/src/lib/platform/internal-api-client.js');

/** A db, a scheduler and the apps domain: enough for the verbs. */
async function boot() {
  const root = fs.mkdtempSync(path.join(dir, 'case-'));
  const db = new StateDb(path.join(root, 'cybermole.db'));
  const scheduler = new Scheduler(db, { cwd: root, env: {}, logDir: path.join(root, 'job-logs') });
  const apps = new Apps({
    db,
    username: () => ({ ok: true, data: { value: 'unit' } }),
    killSession: async () => true,
  });
  const internalSocket = path.join(root, 'cybermole.sock');
  const api = await startInternalApi({ socketPath: internalSocket, scheduler, apps });
  return { root, db, scheduler, apps, api, internalSocket };
}

test('GET /apps over the socket: status + body verbatim, headers along', async () => {
  const w = await boot();
  try {
    const app = await w.apps.saveApp('Deploy Tools');
    const answer = await requestInternalApi(w.internalSocket, { method: 'GET', path: '/apps' });
    assert.equal(answer.status, 200);
    assert.deepEqual(JSON.parse(answer.body), {
      apps: [
        {
          id: app.data.id,
          name: 'Deploy Tools',
          slug: 'deploy-tools',
          cwd: null,
          icon: 'cubes',
          order: 10,
        },
      ],
    });
    assert.equal(answer.headers['content-type'], 'application/json');
  } finally {
    await w.api.close();
  }
});

test('a body verb: POST /jobs with Content-Length always (the 411 contract)', async () => {
  const w = await boot();
  try {
    const answer = await requestInternalApi(w.internalSocket, {
      method: 'POST',
      path: '/jobs',
      body: JSON.stringify({ name: 'nightly', schedule: '0 4 * * *', command: 'echo hello' }),
    });
    assert.equal(answer.status, 200);
    assert.deepEqual(JSON.parse(answer.body), { name: 'nightly', session: null });
    const listed = await requestInternalApi(w.internalSocket, { method: 'GET', path: '/jobs' });
    assert.equal(listed.status, 200);
    assert.equal(JSON.parse(listed.body).jobs.length, 1);

    const deleted = await requestInternalApi(w.internalSocket, {
      method: 'DELETE',
      path: '/jobs/nightly',
    });
    assert.equal(deleted.status, 200);
  } finally {
    await w.api.close();
  }
});

test('a domain failure arrives as a normal answer (status + Result body), never a rejection', async () => {
  const w = await boot();
  try {
    const answer = await requestInternalApi(w.internalSocket, {
      method: 'DELETE',
      path: '/jobs/ghost',
    });
    assert.equal(answer.status, 404);
    assert.equal(JSON.parse(answer.body).code, 'job_not_found');
  } finally {
    await w.api.close();
  }
});

test('transport failure: nothing answering on the socket rejects (ENOENT/ECONNREFUSED)', async () => {
  await assert.rejects(
    requestInternalApi(path.join(dir, 'no-such.sock'), { method: 'GET', path: '/apps' }),
    err => {
      const code = err.code;
      return code === 'ENOENT' || code === 'ECONNREFUSED';
    },
  );
  // a stale socket file (the app host's boot race): the same rejection
  const stale = path.join(fs.mkdtempSync(path.join(dir, 'stale-')), 'cybermole.sock');
  fs.writeFileSync(stale, '');
  await assert.rejects(requestInternalApi(stale, { method: 'GET', path: '/apps' }), err =>
    ['ECONNREFUSED', 'ENOENT'].includes(err.code),
  );
});

test('timeoutMs: a listener that accepted but never answers rejects instead of hanging', async () => {
  const socketPath = path.join(fs.mkdtempSync(path.join(dir, 'mute-')), 'cybermole.sock');
  const mute = http.createServer(() => {
    /* accepts, never answers */
  });
  await new Promise(resolve => mute.listen(socketPath, resolve));
  try {
    await assert.rejects(
      requestInternalApi(socketPath, { method: 'GET', path: '/apps' }, { timeoutMs: 150 }),
      err => /timed out after 150ms/.test(err.message),
    );
  } finally {
    await new Promise(resolve => mute.close(resolve));
  }
});

test('one-shot sockets: nothing is held open between calls (agent: false)', async () => {
  const w = await boot();
  try {
    for (let i = 0; i < 3; i++) {
      const answer = await requestInternalApi(w.internalSocket, { method: 'GET', path: '/apps' });
      assert.equal(answer.status, 200);
    }
  } finally {
    await w.api.close(); // would hang on keep-alive sockets held by the client
  }
});

test('a plain (non-internal-api) HTTP server on a socket answers through the client', async () => {
  const socketPath = path.join(fs.mkdtempSync(path.join(dir, 'foreign-')), 'x.sock');
  const server = net.createServer(socket => {
    socket.on('data', () => {
      socket.write("HTTP/1.1 418 I'm a teapot\r\nContent-Length: 7\r\n\r\nteapot!");
    });
  });
  await new Promise(resolve => server.listen(socketPath, resolve));
  try {
    const answer = await requestInternalApi(socketPath, { method: 'GET', path: '/' });
    assert.equal(answer.status, 418);
    assert.equal(answer.body, 'teapot!');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
