// The internal API over a real tmp-dir unix socket: every verb, the socket
// lifecycle (stale file rebound, live listener refused, 0660, close
// unlinking) and CYBERMOLE_SOCK resolution. A fake tmux on PATH stands in;
// the socket path is set before the import since tmux.ts reads it at load.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as http from 'node:http';
import * as net from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cybermole-internal-api-'));
const fakeBin = path.join(dir, 'bin');
fs.mkdirSync(fakeBin);
process.env.CYBERMOLE_TMUX_SOCKET = path.join(dir, 'tmux');
process.env.FAKE_TMUX_DIR = dir;
process.env.PATH = `${fakeBin}:${process.env.PATH}`;

const { startInternalApi, probeSocketFile, InternalSocketOwnedError } =
  await import('../../dist-server/server/internal-api.js');
const { Scheduler, runLogPaths } = await import('../../dist-server/src/lib/jobs/jobs.js');
const { StateDb } = await import('../../dist-server/src/lib/platform/db.js');
const { Apps } = await import('../../dist-server/src/lib/apps/apps.js');
const { internalSocketDefault } = await import('../../dist-server/src/lib/platform/env.js');

// Fake tmux (with kill-session): $dir/up marks the server up, $dir/sessions lists live sessions.
const FAKE_TMUX = `#!/bin/sh
dir="$FAKE_TMUX_DIR"; sessions="$dir/sessions"
[ -e "$sessions" ] || : > "$sessions"
while [ $# -gt 0 ]; do case "$1" in -f|-S|-L) shift 2 ;; *) break ;; esac; done
sub="$1"; shift
case "$sub" in
  list-sessions)
    [ -e "$dir/up" ] || { echo "error connecting to $CYBERMOLE_TMUX_SOCKET (No such file or directory)" >&2; exit 1; }
    while [ $# -gt 0 ]; do [ "$1" = "-F" ] && shift 2 && continue; shift; done
    cat "$sessions"
    ;;
  has-session)
    [ -e "$dir/up" ] || exit 1
    while [ $# -gt 0 ]; do [ "$1" = "-t" ] && { grep -qx "$2" "$sessions" && exit 0; exit 1; }; shift; done
    exit 1
    ;;
  new-session)
    [ -e "$dir/up" ] || { echo "error connecting to $CYBERMOLE_TMUX_SOCKET (No such file or directory)" >&2; exit 1; }
    while [ $# -gt 0 ]; do [ "$1" = "-s" ] && { echo "$2" >> "$sessions"; exit 0; }; shift; done
    exit 1
    ;;
  kill-session)
    [ -e "$dir/up" ] || exit 1
    [ -e "$dir/kill-fail" ] && exit 1
    while [ $# -gt 0 ]; do [ "$1" = "-t" ] && { grep -vx "$2" "$sessions" > "$sessions.x" 2>/dev/null || : > "$sessions.x"; mv "$sessions.x" "$sessions"; exit 0; }; shift; done
    exit 1
    ;;
  *) echo "fake-tmux: unsupported subcommand: $sub" >&2; exit 1 ;;
esac
`;
fs.writeFileSync(path.join(fakeBin, 'tmux'), FAKE_TMUX, { mode: 0o755 });

/** Reads need no tmux. */
function appsFor(db) {
  return new Apps({
    db,
    username: () => ({ ok: true, data: { value: 'unit' } }),
    killSession: async () => true,
  });
}

/** Fresh db, scheduler, apps domain and the API on its own socket. The fake
 *  tmux server starts up; cases wanting it down remove the marker. */
async function boot() {
  const root = fs.mkdtempSync(path.join(dir, 'case-'));
  const logDir = path.join(root, 'job-logs');
  const db = new StateDb(path.join(root, 'cybermole.db'));
  const scheduler = new Scheduler(db, { cwd: root, env: {}, logDir });
  const apps = appsFor(db);
  // The fake's session list is shared (one tmux server); start each case with none.
  fs.writeFileSync(path.join(dir, 'sessions'), '');
  fs.writeFileSync(path.join(dir, 'up'), '');
  const socketPath = path.join(root, 'cybermole.sock');
  const api = await startInternalApi({ socketPath, scheduler, apps });
  return { root, logDir, db, scheduler, apps, api, socketPath };
}

function call(socketPath, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath,
        method,
        path: urlPath,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
      },
      res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            /* the log route is text/plain */
          }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      },
    );
    req.on('error', reject);
    if (body === undefined) req.end();
    else req.end(typeof body === 'string' ? body : JSON.stringify(body));
  });
}

const GOOD = { name: 'nightly', schedule: '0 4 * * *', command: 'echo hello' };

// ---------- socket lifecycle ----------

test('startInternalApi: creates a missing socket parent dir (the state-dir default is otherwise never materialized)', async () => {
  // With CYBERMOLE_SOCK unset and the db and agent dir elsewhere, nothing
  // creates the state dir; listen() must not die on the missing parent.
  const root = fs.mkdtempSync(path.join(dir, 'case-'));
  const db = new StateDb(path.join(root, 'cybermole.db'));
  const scheduler = new Scheduler(db, { cwd: root, env: {}, logDir: path.join(root, 'job-logs') });
  const deep = path.join(root, 'state', 'cybermole', 'cybermole.sock');
  assert.ok(!fs.existsSync(path.dirname(deep)));
  const api = await startInternalApi({ socketPath: deep, scheduler, apps: appsFor(db) });
  try {
    assert.ok(fs.statSync(deep).isSocket(), 'listener bound on the created dir');
    const r = await call(deep, 'GET', '/jobs');
    assert.equal(r.status, 200);
  } finally {
    await api.close();
  }
});

// ---------- verbs ----------

test('GET /jobs: the browser shape, empty first', async () => {
  const w = await boot();
  try {
    const r = await call(w.socketPath, 'GET', '/jobs');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { available: true, detail: null, jobs: [] });
  } finally {
    await w.api.close();
  }
});

test('POST /jobs creates; GET /jobs lists; bodies match the browser API', async () => {
  const w = await boot();
  try {
    const created = await call(w.socketPath, 'POST', '/jobs', GOOD);
    assert.equal(created.status, 200);
    assert.deepEqual(created.json, { name: 'nightly', session: null });

    const listed = await call(w.socketPath, 'GET', '/jobs');
    assert.equal(listed.json.jobs.length, 1);
    const job = listed.json.jobs[0];
    assert.equal(job.name, 'nightly');
    assert.equal(job.schedule, '0 4 * * *');
    assert.equal(job.command, 'echo hello');
    assert.equal(job.appId, null);
    assert.equal(job.appName, null);
  } finally {
    await w.api.close();
  }
});

test('POST /jobs: a name that normalizes invalid is the browser 400 validation body', async () => {
  const w = await boot();
  try {
    // "cybermole-…" is reserved for run sessions and doesn't normalize away
    const r = await call(w.socketPath, 'POST', '/jobs', { ...GOOD, name: 'cybermole-nightly' });
    assert.equal(r.status, 400);
    assert.deepEqual(r.json, {
      error: 'name: use letters, digits, - and _ (and not cybermole-…)',
      code: 'validation_failure',
      issues: { name: 'use letters, digits, - and _ (and not cybermole-…)' },
    });
  } finally {
    await w.api.close();
  }
});

test('POST /jobs: an invalid schedule is the browser invalid_schedule 400', async () => {
  const w = await boot();
  try {
    const r = await call(w.socketPath, 'POST', '/jobs', { ...GOOD, schedule: '99 * * * *' });
    assert.equal(r.status, 400);
    assert.equal(r.json.code, 'invalid_schedule');
    assert.equal(r.json.detail, null);
    assert.ok(typeof r.json.error === 'string');
  } finally {
    await w.api.close();
  }
});

test('POST /jobs: non-JSON content type and oversized bodies are refused like the public API', async () => {
  const w = await boot();
  try {
    const wrongType = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          socketPath: w.socketPath,
          method: 'POST',
          path: '/jobs',
          headers: { 'content-type': 'text/plain' },
        },
        res => {
          const chunks = [];
          res.on('data', c => chunks.push(c));
          res.on('end', () =>
            resolve({
              status: res.statusCode,
              json: JSON.parse(Buffer.concat(chunks).toString('utf8')),
            }),
          );
        },
      );
      req.on('error', reject);
      req.end('{}');
    });
    assert.equal(wrongType.status, 415);
    assert.equal(wrongType.json.code, 'unsupported_content_type');

    const big = await call(w.socketPath, 'POST', '/jobs', {
      ...GOOD,
      command: 'x'.repeat(11 * 1024),
    });
    assert.equal(big.status, 413);
    assert.equal(big.json.code, 'body_too_large');

    // chunked with no Content-Length: 411
    const chunked = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          socketPath: w.socketPath,
          method: 'POST',
          path: '/jobs',
          headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' },
        },
        res => {
          const chunks = [];
          res.on('data', c => chunks.push(c));
          res.on('end', () =>
            resolve({
              status: res.statusCode,
              json: JSON.parse(Buffer.concat(chunks).toString('utf8')),
            }),
          );
        },
      );
      req.on('error', reject);
      req.end('{}');
    });
    assert.equal(chunked.status, 411);
    assert.equal(chunked.json.code, 'length_required');
  } finally {
    await w.api.close();
  }
});

test('POST /jobs/validate: cron + command checks; invalid values are answers, not errors', async () => {
  const w = await boot();
  try {
    const ok = await call(w.socketPath, 'POST', '/jobs/validate', {
      schedule: '*/5 * * * *',
      command: 'true',
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.schedule.valid, true);
    assert.equal(ok.json.schedule.validatedBy, 'cron-parser');
    assert.match(ok.json.schedule.next, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    assert.deepEqual(ok.json.command, { valid: true, error: null });

    const bad = await call(w.socketPath, 'POST', '/jobs/validate', {
      schedule: '99 * * * *',
      command: '',
    });
    assert.equal(bad.status, 200); // an answer, not a failed request
    assert.equal(bad.json.schedule.valid, false);
    assert.ok(bad.json.schedule.error.length > 0);
    assert.equal(bad.json.command.valid, false);

    const scheduleOnly = await call(w.socketPath, 'POST', '/jobs/validate', {
      schedule: '0 4 * * *',
    });
    assert.equal(scheduleOnly.json.schedule.valid, true);
    assert.equal(scheduleOnly.json.command, null);

    const empty = await call(w.socketPath, 'POST', '/jobs/validate', {});
    assert.equal(empty.status, 400);
    assert.equal(empty.json.code, 'validation_failure');
  } finally {
    await w.api.close();
  }
});

test('PATCH /jobs/:name: absent keeps, provided sets; saves through the same service', async () => {
  const w = await boot();
  try {
    await call(w.socketPath, 'POST', '/jobs', GOOD);

    const patched = await call(w.socketPath, 'PATCH', '/jobs/nightly', { schedule: '30 5 * * *' });
    assert.equal(patched.status, 200);
    assert.deepEqual(patched.json, { name: 'nightly', session: null });

    const listed = await call(w.socketPath, 'GET', '/jobs');
    const job = listed.json.jobs[0];
    assert.equal(job.schedule, '30 5 * * *'); // set
    assert.equal(job.command, 'echo hello'); // kept

    const badSchedule = await call(w.socketPath, 'PATCH', '/jobs/nightly', { schedule: 'nope' });
    assert.equal(badSchedule.status, 400);
    assert.equal(badSchedule.json.code, 'invalid_schedule');

    const missing = await call(w.socketPath, 'PATCH', '/jobs/ghost', { schedule: '0 4 * * *' });
    assert.equal(missing.status, 404);
    assert.equal(missing.json.code, 'job_not_found');
  } finally {
    await w.api.close();
  }
});

test('GET /jobs?app=<slug>: filters; unknown slug is a 404, bad slug a 400', async () => {
  const w = await boot();
  try {
    const app = await w.apps.saveApp('Deploy Tools');
    assert.equal(app.ok, true);
    await call(w.socketPath, 'POST', '/jobs', GOOD);
    await call(w.socketPath, 'POST', '/jobs', {
      name: 'rebuild',
      schedule: '0 6 * * *',
      command: 'make',
      appId: app.data.id,
    });

    const filtered = await call(w.socketPath, 'GET', '/jobs?app=deploy-tools');
    assert.equal(filtered.status, 200);
    assert.equal(filtered.json.jobs.length, 1);
    assert.equal(filtered.json.jobs[0].name, 'rebuild');
    assert.equal(filtered.json.jobs[0].appName, 'Deploy Tools');

    const untagged = await call(w.socketPath, 'GET', '/jobs');
    assert.equal(untagged.json.jobs.length, 2);

    const unknown = await call(w.socketPath, 'GET', '/jobs?app=no-such-app');
    assert.equal(unknown.status, 404);
    assert.equal(unknown.json.code, 'app_not_found');

    const invalid = await call(w.socketPath, 'GET', '/jobs?app=%2F%2F');
    assert.equal(invalid.status, 400);
    assert.equal(invalid.json.code, 'invalid_app_slug');
  } finally {
    await w.api.close();
  }
});

test('GET /apps: the picker rows over the socket; database_error when the apps db breaks', async () => {
  // The MCP's apps_list verb: the same rows the browser dialog renders.
  const w = await boot();
  try {
    const app = await w.apps.saveApp('Deploy Tools');
    const r = await call(w.socketPath, 'GET', '/apps');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, {
      apps: [{ id: app.data.id, name: 'Deploy Tools', slug: 'deploy-tools', cwd: null, order: 10 }],
    });
    // other methods on /apps exist; an unknown one is still a JSON 404
    const notAVerb = await call(w.socketPath, 'PUT', '/apps');
    assert.equal(notAVerb.status, 404);
  } finally {
    await w.api.close();
  }

  const root = fs.mkdtempSync(path.join(dir, 'broken-apps-'));
  const notADir = path.join(root, 'not-a-dir');
  fs.writeFileSync(notADir, '');
  const api = await startInternalApi({
    socketPath: path.join(root, 'cybermole.sock'),
    scheduler: w.scheduler,
    apps: appsFor(new StateDb(path.join(notADir, 'cybermole.db'))),
  });
  try {
    const broken = await call(path.join(root, 'cybermole.sock'), 'GET', '/apps');
    assert.equal(broken.status, 500);
    assert.equal(broken.json.code, 'database_error');
  } finally {
    await api.close();
  }
});

// App create/patch/delete, mirroring the console routes through the same
// Apps domain calls and mappers (byte-identical JSON).
test("POST /apps creates (name + optional cwd), the browser verb's bodies verbatim", async () => {
  const w = await boot();
  try {
    const made = await call(w.socketPath, 'POST', '/apps', {
      name: 'App Fixture',
      cwd: w.root,
    });
    assert.equal(made.status, 200);
    assert.equal(made.json.name, 'App Fixture');
    assert.equal(made.json.slug, 'app-fixture');
    assert.equal(made.json.cwd, w.root);
    assert.ok(typeof made.json.id === 'string');

    // the console's POST /api/apps success shape
    const listed = await call(w.socketPath, 'GET', '/apps');
    assert.equal(listed.json.apps.length, 1);
    assert.equal(listed.json.apps[0].slug, 'app-fixture');

    // closed codes, not messages
    const dup = await call(w.socketPath, 'POST', '/apps', { name: 'app fixture' });
    assert.equal(dup.status, 409);
    assert.equal(dup.json.code, 'duplicate_slug');
    assert.equal(dup.json.error, 'an app with the slug "app-fixture" already exists');

    const badName = await call(w.socketPath, 'POST', '/apps', { name: '!!' });
    assert.equal(badName.status, 400);
    assert.equal(badName.json.code, 'invalid_name');

    const badCwd = await call(w.socketPath, 'POST', '/apps', {
      name: 'Elsewhere',
      cwd: 'relative/x',
    });
    assert.equal(badCwd.status, 400);
    assert.equal(badCwd.json.code, 'invalid_cwd');

    const malformed = await call(w.socketPath, 'POST', '/apps', {});
    assert.equal(malformed.status, 400);
    assert.equal(malformed.json.code, 'validation_failure');
  } finally {
    await w.api.close();
  }
});

test('PATCH /apps/:slug: rename / set-cwd / clear-cwd; invalid slug and app_not_found are the browser bodies', async () => {
  const w = await boot();
  try {
    const made = await call(w.socketPath, 'POST', '/apps', { name: 'Notes', cwd: w.root });
    assert.equal(made.status, 200);

    const renamed = await call(w.socketPath, 'PATCH', '/apps/notes', { name: 'Journal' });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.json.name, 'Journal');
    assert.equal(renamed.json.slug, 'notes', 'the slug is stable');
    assert.equal(renamed.json.cwd, w.root);

    const cleared = await call(w.socketPath, 'PATCH', '/apps/notes', { cwd: null });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.json.cwd, null);

    const absent = await call(w.socketPath, 'PATCH', '/apps/notes', {});
    assert.equal(absent.status, 200); // a no-op returns the row as it stands
    assert.equal(absent.json.name, 'Journal');

    const notFound = await call(w.socketPath, 'PATCH', '/apps/never', { name: 'X' });
    assert.equal(notFound.status, 404);
    assert.equal(notFound.json.code, 'app_not_found');

    const badSlug = await call(w.socketPath, 'PATCH', '/apps/not%20a@slug', { name: 'X' });
    assert.equal(badSlug.status, 400);
    assert.equal(badSlug.json.code, 'invalid_app_slug');
  } finally {
    await w.api.close();
  }
});

test('DELETE /apps/:slug unregisters: the row + cascade through the same domain, app_not_found on repeat', async () => {
  const w = await boot();
  try {
    const made = await call(w.socketPath, 'POST', '/apps', { name: 'Poison', cwd: w.root });
    assert.equal(made.status, 200);
    const id = made.json.id;

    const gone = await call(w.socketPath, 'DELETE', '/apps/poison');
    assert.equal(gone.status, 200);
    assert.deepEqual(gone.json, { id });

    const repeat = await call(w.socketPath, 'DELETE', '/apps/poison');
    assert.equal(repeat.status, 404);
    assert.equal(repeat.json.code, 'app_not_found');

    const listed = await call(w.socketPath, 'GET', '/apps');
    assert.equal(listed.json.apps.length, 0, 'the row is gone');
  } finally {
    await w.api.close();
  }
});

test('the app tag: PATCH appId sets/null clears, like the browser save dialog', async () => {
  const w = await boot();
  try {
    const app = await w.apps.saveApp('Deploy Tools');
    await call(w.socketPath, 'POST', '/jobs', GOOD);
    await call(w.socketPath, 'PATCH', '/jobs/nightly', { appId: app.data.id });
    assert.equal((await call(w.socketPath, 'GET', '/jobs')).json.jobs[0].appId, app.data.id);
    await call(w.socketPath, 'PATCH', '/jobs/nightly', { appId: null });
    assert.equal((await call(w.socketPath, 'GET', '/jobs')).json.jobs[0].appId, null);
  } finally {
    await w.api.close();
  }
});

test('DELETE /jobs/:name: then job_not_found on repeat', async () => {
  const w = await boot();
  try {
    await call(w.socketPath, 'POST', '/jobs', GOOD);
    const deleted = await call(w.socketPath, 'DELETE', '/jobs/nightly');
    assert.equal(deleted.status, 200);
    assert.deepEqual(deleted.json, { name: 'nightly', session: null });
    const again = await call(w.socketPath, 'DELETE', '/jobs/nightly');
    assert.equal(again.status, 404);
    assert.equal(again.json.code, 'job_not_found');
  } finally {
    await w.api.close();
  }
});

test('run/kill/log: the run lifecycle over the socket', async () => {
  const w = await boot();
  try {
    await call(w.socketPath, 'POST', '/jobs', GOOD);

    const empty = await call(w.socketPath, 'GET', '/jobs/nightly/runs');
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.json, { runs: [] });

    const run = await call(w.socketPath, 'POST', '/jobs/nightly/run', {});
    assert.equal(run.status, 200);
    assert.deepEqual(run.json, { name: 'nightly', session: 'cybermole-nightly' });

    // the previous run is still live
    const busy = await call(w.socketPath, 'POST', '/jobs/nightly/run', {});
    assert.equal(busy.status, 409);
    assert.equal(busy.json.code, 'run_active');

    const runs = await call(w.socketPath, 'GET', '/jobs/nightly/runs');
    assert.equal(runs.json.runs.length, 1);
    const { firedAt, origin, hasLog } = runs.json.runs[0];
    assert.equal(origin, 'manual');
    assert.equal(hasLog, false);

    // A failing kill-session (session still live): tmux_error with the kill's own text.
    fs.writeFileSync(path.join(dir, 'kill-fail'), '');
    try {
      const failed = await call(w.socketPath, 'POST', `/jobs/nightly/runs/${firedAt}/kill`, {});
      assert.equal(failed.status, 500);
      assert.equal(failed.json.code, 'tmux_error');
      assert.equal(failed.json.error, 'could not kill the run session');
      assert.equal(failed.json.detail, 'could not kill the run session cybermole-nightly');
    } finally {
      fs.rmSync(path.join(dir, 'kill-fail'), { force: true });
    }

    // the live run dies; a repeat is run_not_active
    const killed = await call(w.socketPath, 'POST', `/jobs/nightly/runs/${firedAt}/kill`, {});
    assert.equal(killed.status, 200);
    assert.deepEqual(killed.json, { name: 'nightly', firedAt });
    const rekill = await call(w.socketPath, 'POST', `/jobs/nightly/runs/${firedAt}/kill`, {});
    assert.equal(rekill.status, 409);
    assert.equal(rekill.json.code, 'run_not_active');

    // an unrecorded firedAt: run_not_found (404), not run_active
    const noSuchRun = await call(w.socketPath, 'POST', '/jobs/nightly/runs/123/kill', {});
    assert.equal(noSuchRun.status, 404);
    assert.equal(noSuchRun.json.code, 'run_not_found');

    // A new run can start; killing the old firedAt must never hit the newer run.
    const second = await call(w.socketPath, 'POST', '/jobs/nightly/run', {});
    assert.equal(second.status, 200);
    const staleKill = await call(w.socketPath, 'POST', `/jobs/nightly/runs/${firedAt}/kill`, {});
    assert.equal(staleKill.status, 409);
    assert.equal(staleKill.json.code, 'run_not_active');
    const secondRuns = await call(w.socketPath, 'GET', '/jobs/nightly/runs');
    assert.equal(secondRuns.json.runs.length, 2); // the newer run survived

    // a log where the wrapper would write it, read back as the tail
    const secondFiredAt = secondRuns.json.runs[0].firedAt;
    const paths = runLogPaths(w.logDir, 'nightly', secondFiredAt);
    fs.mkdirSync(path.dirname(paths.log), { recursive: true });
    fs.writeFileSync(paths.log, 'line one\nline two\n');
    const log = await call(w.socketPath, 'GET', `/jobs/nightly/runs/${secondFiredAt}/log`);
    assert.equal(log.status, 200);
    assert.equal(log.headers['content-type'], 'text/plain; charset=utf-8');
    assert.equal(log.text, 'line one\nline two\n');
    assert.equal(log.headers['x-run-log-truncated'], undefined);

    const noRun = await call(w.socketPath, 'GET', '/jobs/nightly/runs/123/log');
    assert.equal(noRun.status, 404);
    assert.equal(noRun.json.code, 'run_not_found');
  } finally {
    await w.api.close();
  }
});

test('the 1 MiB log tail cap, same as the browser verb', async () => {
  const w = await boot();
  try {
    await call(w.socketPath, 'POST', '/jobs', GOOD);
    const run = await call(w.socketPath, 'POST', '/jobs/nightly/run', {});
    assert.equal(run.status, 200);
    const runs = await call(w.socketPath, 'GET', '/jobs/nightly/runs');
    const { firedAt } = runs.json.runs[0];
    const paths = runLogPaths(w.logDir, 'nightly', firedAt);
    fs.mkdirSync(path.dirname(paths.log), { recursive: true });
    const MiB = 1024 * 1024;
    fs.writeFileSync(paths.log, Buffer.alloc(MiB + 10, 0x61)); // 10 bytes over
    const log = await call(w.socketPath, 'GET', `/jobs/nightly/runs/${firedAt}/log`);
    assert.equal(log.status, 200);
    assert.equal(Buffer.byteLength(log.text), MiB);
    assert.equal(log.headers['x-run-log-truncated'], '1');
  } finally {
    await w.api.close();
  }
});

test('a broken state db answers 500 database_error on the read verbs', async () => {
  // The db's parent is a file, so every lazy open fails and the routes map
  // the resulting database_error like the browser API does.
  const root = fs.mkdtempSync(path.join(dir, 'broken-'));
  const notADir = path.join(root, 'not-a-dir');
  fs.writeFileSync(notADir, '');
  const scheduler = new Scheduler(new StateDb(path.join(notADir, 'cybermole.db')), {
    cwd: root,
    env: {},
    logDir: path.join(root, 'job-logs'),
  });
  const socketPath = path.join(root, 'cybermole.sock');
  const api = await startInternalApi({
    socketPath,
    scheduler,
    apps: appsFor(new StateDb(path.join(root, 'good.db'))),
  });
  try {
    for (const [method, urlPath] of [
      ['GET', '/jobs'],
      ['PATCH', '/jobs/nightly'],
      ['POST', '/jobs/nightly/runs/123/kill'],
    ]) {
      const r = await call(
        socketPath,
        method,
        urlPath,
        method === 'PATCH' ? { schedule: '0 4 * * *' } : undefined,
      );
      assert.equal(r.status, 500, `${method} ${urlPath}`);
      assert.equal(r.json.code, 'database_error', `${method} ${urlPath}`);
    }
  } finally {
    await api.close();
  }
});

test('unknown job on the run verbs: the browser job_not_found body', async () => {
  const w = await boot();
  try {
    for (const [method, urlPath] of [
      ['GET', '/jobs/ghost/runs'],
      ['POST', '/jobs/ghost/run'],
      ['POST', '/jobs/ghost/runs/123/kill'],
      ['GET', '/jobs/ghost/runs/123/log'],
    ]) {
      const r = await call(w.socketPath, method, urlPath);
      assert.equal(r.status, 404, `${method} ${urlPath}`);
      assert.equal(r.json.code, 'job_not_found', `${method} ${urlPath}`);
    }
  } finally {
    await w.api.close();
  }
});

test('unknown paths and verbs answer 404 with a Result body, never HTML', async () => {
  const w = await boot();
  try {
    for (const [method, urlPath] of [
      ['GET', '/nope'],
      ['GET', '/api/jobs'],
      ['PUT', '/jobs'],
      ['GET', '/jobs/validate'], // the validate route is POST-only
      ['GET', '/jobs/a/b/c/d/e/f'],
      ['POST', '/jobs/nightly/runs/123/restart'],
    ]) {
      const r = await call(w.socketPath, method, urlPath);
      assert.equal(r.status, 404, `${method} ${urlPath}`);
      assert.deepEqual(r.json, { error: 'not found', detail: null, code: 'not_found' });
    }
    // a bad %-escape: 400
    const badEscape = await call(w.socketPath, 'GET', '/jobs/%E0/runs');
    assert.equal(badEscape.status, 400);
    // not a JobName: invalid_job_name
    const badName = await call(w.socketPath, 'DELETE', '/jobs/cybermole-x');
    assert.equal(badName.status, 400);
    assert.deepEqual(badName.json, {
      error: 'invalid job name',
      detail: null,
      code: 'invalid_job_name',
    });
    // not an integer: invalid_fired_at
    const badFiredAt = await call(w.socketPath, 'GET', '/jobs/nightly/runs/abc/log');
    assert.equal(badFiredAt.status, 400);
    assert.equal(badFiredAt.json.code, 'invalid_fired_at');
  } finally {
    await w.api.close();
  }
});

// ---------- socket lifecycle ----------

test('after listen the socket file is 0660; close() unlinks it', async () => {
  const w = await boot();
  const mode = fs.statSync(w.socketPath).mode & 0o777;
  assert.equal(mode, 0o660);
  await w.api.close();
  assert.equal(fs.existsSync(w.socketPath), false);
  await assert.rejects(call(w.socketPath, 'GET', '/jobs'));
});

test('a stale socket file is unlinked and rebound at boot', async () => {
  const w = await boot();
  await w.api.close();
  // a stale file (the crash case): ECONNREFUSED
  fs.writeFileSync(w.socketPath, '');
  assert.equal(await probeSocketFile(w.socketPath), 'stale');
  const again = await startInternalApi({
    socketPath: w.socketPath,
    scheduler: w.scheduler,
    apps: w.apps,
  });
  try {
    const r = await call(w.socketPath, 'GET', '/jobs');
    assert.equal(r.status, 200);
  } finally {
    await again.close();
  }
});

test('a live listener owns the socket: the typed error main.ts degrades on', async () => {
  const w = await boot();
  try {
    await assert.rejects(
      startInternalApi({ socketPath: w.socketPath, scheduler: w.scheduler, apps: w.apps }),
      err => {
        // main.ts serves on without the listener only for this typed
        // error; anything else stops the boot.
        assert.ok(
          err instanceof InternalSocketOwnedError,
          'the typed marker, not just the message',
        );
        assert.equal(err.socketPath, w.socketPath);
        assert.match(err.message, /another cybermole server owns the socket/);
        return true;
      },
    );
  } finally {
    await w.api.close();
  }
});

test('probeSocketFile: a plain foreign server on the socket counts as live', async () => {
  const socketPath = path.join(fs.mkdtempSync(path.join(dir, 'probe-')), 'cybermole.sock');
  const server = net.createServer(() => {});
  await new Promise(resolve => server.listen(socketPath, resolve));
  try {
    assert.equal(await probeSocketFile(socketPath), 'live');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

// ---------- CYBERMOLE_SOCK resolution ----------

/** In a child process: env.ts reads CYBERMOLE_* at module load. */
function readSock(env) {
  const clean = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => k !== 'CYBERMOLE_SOCK'),
  );
  try {
    const out = execFileSync(
      process.execPath,
      [
        '-e',
        "process.stdout.write(JSON.stringify(require('./dist-server/src/lib/platform/env.js').readInternalApiSocket()))",
      ],
      { env: { ...clean, ...env }, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return { value: JSON.parse(out.toString()) };
  } catch (err) {
    return { error: err.stderr.toString() };
  }
}

test('env: a non-absolute CYBERMOLE_SOCK stops the boot, like the S3 vars', () => {
  const r = readSock({ CYBERMOLE_SOCK: 'cybermole.sock' });
  assert.match(r.error, /CYBERMOLE_SOCK="cybermole.sock" must be an absolute socket path/);
});

test('env: EMPTY CYBERMOLE_SOCK is off — the listener is disabled', () => {
  assert.deepEqual(readSock({ CYBERMOLE_SOCK: '' }).value, null);
  assert.deepEqual(readSock({ CYBERMOLE_SOCK: '   ' }).value, null);
});

test('env: unset = the shape default; an absolute path wins', () => {
  const stateDir = fs.mkdtempSync(path.join(dir, 'state-'));
  const runCybermole = fs.existsSync('/run/cybermole');
  const expected = runCybermole
    ? '/run/cybermole/cybermole.sock'
    : path.join(stateDir, 'cybermole.sock');
  assert.equal(readSock({ CYBERMOLE_STATE_DIR: stateDir }).value, expected);
  assert.equal(readSock({ CYBERMOLE_SOCK: '/tmp/other.sock' }).value, '/tmp/other.sock');
});

test('internalSocketDefault: /run/cybermole when the shared dir exists, else the state dir', () => {
  assert.equal(internalSocketDefault('/state', true), '/run/cybermole/cybermole.sock');
  assert.equal(internalSocketDefault('/state', false), path.join('/state', 'cybermole.sock'));
});
