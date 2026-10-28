// The job-run finish webhook: config resolution (db override → env → off),
// the /settings save family, and the notifier's delivery contract against
// an injected client (no unit ever touches a real network): payload shape,
// fire-on-finish, timeout cap, failure logging (rate-sane), off when
// unconfigured. The env contract is checked in a fresh process (RAW_ENV is
// read at load), like grafana.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cybermole-webhook-'));

const { StateDb } = await import('../../dist-server/src/lib/platform/db.js');
const {
  createRunFinishNotifier,
  jobWebhook,
  nodeWebhookClient,
  saveJobWebhook,
  WEBHOOK_TIMEOUT_MS,
} = await import('../../dist-server/src/lib/jobs/notify.js');

function freshDb() {
  return new StateDb(path.join(fs.mkdtempSync(path.join(dir, 'db-')), 'cybermole.db'));
}

/** Its state db can never open (the parent is a file). */
function brokenDb() {
  const file = path.join(fs.mkdtempSync(path.join(dir, 'broken-')), 'not-a-dir');
  fs.writeFileSync(file, '');
  return new StateDb(path.join(file, 'cybermole.db'));
}

const PAYLOAD = {
  event: 'job_run_finished',
  job: 'nightly',
  origin: 'schedule',
  firedAt: 1712_345_678_901,
  finishedAt: 1712_345_699_999,
  exitCode: 2,
};

const UNKNOWN_EXIT = { ...PAYLOAD, exitCode: null };

/** Records every call; `behavior` lets a test hang, reject or answer. */
function fakeClient(behavior = 'ok') {
  const calls = [];
  const client = (url, init) => {
    calls.push({ url, body: init.body, signal: init.signal instanceof AbortSignal });
    if (behavior === 'hang') return new Promise(() => {});
    if (behavior === 'reject') return Promise.reject(new Error('connection refused'));
    if (behavior === 'status') return Promise.resolve({ ok: false, status: 503 });
    return Promise.resolve({ ok: true, status: 200 });
  };
  return { calls, client };
}

// ---------- env contract (fresh process: RAW_ENV reads at load) ----------

function bootRead(env) {
  const clean = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => k !== 'CYBERMOLE_JOB_WEBHOOK_URL'),
  );
  try {
    const out = execFileSync(
      process.execPath,
      [
        '-e',
        "process.stdout.write(JSON.stringify(require('./dist-server/src/lib/platform/env.js').readJobWebhookUrl()))",
      ],
      { env: { ...clean, ...env }, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return { url: JSON.parse(out.toString()) };
  } catch (err) {
    return { error: err.stderr.toString() };
  }
}

test('the CYBERMOLE_JOB_WEBHOOK_URL env contract is declared in the shared schema', async () => {
  const { envSchema } = await import('../../dist-server/src/lib/platform/env-schema.js');
  assert.deepEqual(envSchema.CYBERMOLE_JOB_WEBHOOK_URL, {
    type: 'string',
    context: 'server',
    access: 'secret',
    optional: true,
  });
});

test('readJobWebhookUrl: unset/empty is null (off); a valid http(s) URL passes through', () => {
  assert.deepEqual(bootRead({}), { url: null });
  assert.deepEqual(bootRead({ CYBERMOLE_JOB_WEBHOOK_URL: '' }), { url: null });
  assert.deepEqual(bootRead({ CYBERMOLE_JOB_WEBHOOK_URL: 'http://hooks:9/t' }), {
    url: 'http://hooks:9/t',
  });
  assert.deepEqual(bootRead({ CYBERMOLE_JOB_WEBHOOK_URL: 'https://example.com/a?b=c' }), {
    url: 'https://example.com/a?b=c',
  });
});

test('readJobWebhookUrl: a malformed value stops the boot', () => {
  assert.match(bootRead({ CYBERMOLE_JOB_WEBHOOK_URL: 'ftp://x' }).error, /is not an http\(s\) URL/);
  assert.match(
    bootRead({ CYBERMOLE_JOB_WEBHOOK_URL: 'not a url' }).error,
    /is not an http\(s\) URL/,
  );
});

// ---------- effective config + the save family ----------

const OFF = { url: null, overridden: false };

test('jobWebhook: off when unconfigured; env default; the db override wins', async () => {
  const db = freshDb();
  assert.deepEqual(jobWebhook(db, () => null).data.value, OFF);
  assert.deepEqual(jobWebhook(db, () => 'http://env:9/t').data.value, {
    url: 'http://env:9/t',
    overridden: false,
  });
  saveJobWebhook(db, { jobWebhookUrl: 'http://db:9/t' });
  assert.deepEqual(jobWebhook(db, () => 'http://env:9/t').data.value, {
    url: 'http://db:9/t',
    overridden: true,
  });
});

test('jobWebhook: a corrupt or empty row reads as unset; database_error on a broken db', () => {
  const db = freshDb();
  db.setSetting('jobs.webhookUrl', '{not json');
  assert.deepEqual(jobWebhook(db, () => null).data.value, OFF);
  db.setSetting('jobs.webhookUrl', JSON.stringify(''));
  assert.deepEqual(jobWebhook(db, () => null).data.value, OFF);
  const failed = jobWebhook(brokenDb(), () => null);
  assert.equal(failed.ok, false);
  assert.equal(failed.errorCode, 'database_error');
});

test('saveJobWebhook: sets, clears (null and ""), keeps when absent; database_error', async () => {
  const db = freshDb();
  const saved = saveJobWebhook(db, { jobWebhookUrl: 'http://db:9/t' });
  assert.deepEqual(saved, {
    ok: true,
    resultType: 'save_job_webhook',
    data: { url: 'http://db:9/t', overridden: true },
  });
  // Absent keeps (the terminal-defaults form sends only its own fields).
  saveJobWebhook(db, {});
  assert.equal(jobWebhook(db, () => null).data.value.url, 'http://db:9/t');
  assert.deepEqual(saveJobWebhook(db, { jobWebhookUrl: null }).data, OFF);
  saveJobWebhook(db, { jobWebhookUrl: 'http://db:9/t' });
  assert.deepEqual(saveJobWebhook(db, { jobWebhookUrl: '' }).data, OFF);
  assert.equal(
    saveJobWebhook(brokenDb(), { jobWebhookUrl: 'http://x:9/t' }).errorCode,
    'database_error',
  );
});

// ---------- the notifier ----------

function notifier(db, { client, envUrl = () => null, warns = [], timeoutMs, warnEveryMs } = {}) {
  const warn = message => warns.push(message);
  const notify = createRunFinishNotifier({
    db,
    envUrl,
    warn,
    ...(client ? { client } : {}),
    timeoutMs,
    warnEveryMs,
  });
  return { notify, warns };
}

test('the notifier POSTs the run-finished payload once per finish, successes included', async () => {
  const db = freshDb();
  saveJobWebhook(db, { jobWebhookUrl: 'http://hooks:9/runs' });
  const shared = fakeClient();
  const { notify } = notifier(db, { client: shared.client });
  await notify(PAYLOAD);
  await notify(UNKNOWN_EXIT);
  assert.equal(shared.calls.length, 2, 'one POST per finish, unknown exit included');
  const body = JSON.parse(shared.calls[0].body);
  assert.deepEqual(Object.keys(body).sort(), [
    'event',
    'exitCode',
    'finishedAt',
    'firedAt',
    'job',
    'origin',
  ]);
  assert.deepEqual(body, PAYLOAD);
  assert.deepEqual(JSON.parse(shared.calls[1].body), UNKNOWN_EXIT);
  assert.ok(shared.calls.every(c => c.url === 'http://hooks:9/runs' && c.signal));
});

test('unconfigured (no override, no env): no POST, no warn, resolves', async () => {
  const db = freshDb();
  const shared = fakeClient();
  const { notify, warns } = notifier(db, { client: shared.client });
  await notify(PAYLOAD);
  assert.equal(shared.calls.length, 0);
  assert.deepEqual(warns, []);
});

test('the env default is used when no override is set, and the override wins', async () => {
  const db = freshDb();
  const env = fakeClient();
  const fromEnv = notifier(db, { client: env.client, envUrl: () => 'http://env:9/t' });
  await fromEnv.notify(PAYLOAD);
  assert.equal(env.calls.length, 1);
  assert.equal(env.calls[0].url, 'http://env:9/t');
  saveJobWebhook(db, { jobWebhookUrl: 'http://db:9/t' });
  const shared = fakeClient();
  const overridden = notifier(db, { client: shared.client, envUrl: () => 'http://env:9/t' });
  await overridden.notify(PAYLOAD);
  assert.equal(shared.calls[0].url, 'http://db:9/t');
});

test('a rejected delivery warns once and never rejects the notify promise', async () => {
  const db = freshDb();
  saveJobWebhook(db, { jobWebhookUrl: 'http://dead:9/t' });
  const { client } = fakeClient('reject');
  const { notify, warns } = notifier(db, { client });
  await notify(PAYLOAD);
  assert.equal(warns.length, 1);
  assert.match(warns[0], /unreachable \(connection refused\)/);
});

test('a non-2xx answer warns with the status', async () => {
  const db = freshDb();
  saveJobWebhook(db, { jobWebhookUrl: 'http://hooks:9/t' });
  const { client } = fakeClient('status');
  const { notify, warns } = notifier(db, { client });
  await notify(PAYLOAD);
  assert.match(warns[0], /answered HTTP 503/);
});

test('a hanging client is capped by the timeout and reported', async () => {
  const db = freshDb();
  saveJobWebhook(db, { jobWebhookUrl: 'http://slow:9/t' });
  const { client } = fakeClient('hang');
  const { notify, warns } = notifier(db, { client, timeoutMs: 40 });
  const started = Date.now();
  await notify(PAYLOAD);
  assert.ok(Date.now() - started < 5_000, 'the race capped the wait, not the 5 s default');
  assert.equal(warns.length, 1);
  assert.match(warns[0], /timed out after 40ms/);
});

test('failure warnings are rate-sane: one line per window', async () => {
  const db = freshDb();
  saveJobWebhook(db, { jobWebhookUrl: 'http://dead:9/t' });
  const { client } = fakeClient('reject');
  const { notify, warns } = notifier(db, { client, warnEveryMs: 10 * 60_000 });
  await notify(PAYLOAD);
  await notify({ ...PAYLOAD, job: 'other' });
  assert.equal(warns.length, 1);
});

test('the default timeout is the documented cap', () => {
  assert.equal(WEBHOOK_TIMEOUT_MS, 5_000);
});

// ---------- the real client's wire shape, against a local one-shot server ----------

test('nodeWebhookClient: POST, application/json, the payload as the body', async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => {
      body += c;
    });
    req.on('end', () => {
      seen.push({ method: req.method, type: req.headers['content-type'], body });
      res.writeHead(204);
      res.end();
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/hook`;
    const answer = await nodeWebhookClient(url, {
      body: JSON.stringify(PAYLOAD),
      signal: new AbortController().signal,
    });
    assert.deepEqual(answer, { ok: true, status: 204 });
    assert.deepEqual(seen, [
      { method: 'POST', type: 'application/json', body: JSON.stringify(PAYLOAD) },
    ]);
  } finally {
    server.close();
  }
});

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
