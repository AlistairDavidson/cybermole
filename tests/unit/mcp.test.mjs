// The jobs MCP server as a real stdio child (dist-server/server/mcp.js)
// against an in-process internal API on a tmp socket: the handshake,
// tools/list, a happy and a failure call per tool (tool text is the API's
// JSON verbatim), and transport failures. Every body the tools send is
// lengthed, so nothing gets 411; an oversized one gets the 413 only a
// declared length produces.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cybermole-mcp-'));
const fakeBin = path.join(dir, 'bin');
fs.mkdirSync(fakeBin);
process.env.CYBERMOLE_TMUX_SOCKET = path.join(dir, 'tmux');
process.env.FAKE_TMUX_DIR = dir;
process.env.PATH = `${fakeBin}:${process.env.PATH}`;

const { startInternalApi } = await import('../../dist-server/server/internal-api.js');
const { requestInternalApi } =
  await import('../../dist-server/src/lib/platform/internal-api-client.js');
const { Scheduler, runLogPaths } = await import('../../dist-server/src/lib/jobs/jobs.js');
const { StateDb } = await import('../../dist-server/src/lib/platform/db.js');
const { Apps } = await import('../../dist-server/src/lib/apps/apps.js');

const MCP_CHILD = fileURLToPath(new URL('../../dist-server/server/mcp.js', import.meta.url));

// Fake tmux: $dir/up marks the server up, $dir/sessions lists live sessions.
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

/** Fresh db, scheduler, apps domain, the API on its own socket (fake tmux
 *  up, no sessions), and a connected MCP client. */
async function boot() {
  const root = fs.mkdtempSync(path.join(dir, 'case-'));
  const logDir = path.join(root, 'job-logs');
  const db = new StateDb(path.join(root, 'cybermole.db'));
  const scheduler = new Scheduler(db, { cwd: root, env: {}, logDir });
  const apps = appsFor(db);
  fs.writeFileSync(path.join(dir, 'sessions'), '');
  fs.writeFileSync(path.join(dir, 'up'), '');
  const socketPath = path.join(root, 'cybermole.sock');
  const api = await startInternalApi({ socketPath, scheduler, apps });
  const client = new Client({ name: 'mcp-unit', version: '0' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [MCP_CHILD],
      env: { CYBERMOLE_SOCK: socketPath },
    }),
  );
  return { root, logDir, db, scheduler, apps, api, socketPath, client };
}

/** The apps db is broken; jobs verbs are fine. */
async function bootBrokenApps() {
  const root = fs.mkdtempSync(path.join(dir, 'broken-apps-'));
  const notADir = path.join(root, 'not-a-dir');
  fs.writeFileSync(notADir, '');
  const scheduler = new Scheduler(new StateDb(path.join(root, 'good.db')), {
    cwd: root,
    env: {},
    logDir: path.join(root, 'job-logs'),
  });
  const socketPath = path.join(root, 'cybermole.sock');
  const api = await startInternalApi({
    socketPath,
    scheduler,
    apps: appsFor(new StateDb(path.join(notADir, 'cybermole.db'))),
  });
  const client = new Client({ name: 'mcp-unit', version: '0' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [MCP_CHILD],
      env: { CYBERMOLE_SOCK: socketPath },
    }),
  );
  return { api, socketPath, client };
}

/** A domain failure is a normal result (isError false). */
async function call(client, name, args = {}) {
  const r = await client.callTool({ name, arguments: args });
  assert.ok(Array.isArray(r.content) && r.content.length > 0, `${name}: text content`);
  for (const block of r.content) assert.equal(block.type, 'text', `${name}: text block`);
  return { isError: r.isError === true, text: r.content.map(b => b.text).join('') };
}

/** The text must be the API's JSON (success or failure). */
async function callJson(client, name, args) {
  const { isError, text } = await call(client, name, args);
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    assert.fail(`${name}: the API's JSON body, got ${JSON.stringify(text)}`);
  }
  return { isError, text, json };
}

const GOOD = { name: 'nightly', schedule: '0 4 * * *', command: 'echo hello' };

// ---------- handshake + tool set ----------

test('initialize handshake + tools/list: the full tool set, schemas from the shared definitions', async () => {
  const w = await boot();
  try {
    // connect() did the initialize; the server's identity came back with it
    assert.deepEqual(w.client.getServerVersion(), {
      name: 'cybermole-jobs',
      version: '0.1.0',
    });
    const { tools } = await w.client.listTools();
    assert.deepEqual(tools.map(t => t.name).sort(), [
      'apps_list',
      'jobs_create',
      'jobs_delete',
      'jobs_kill',
      'jobs_list',
      'jobs_log',
      'jobs_run_now',
      'jobs_runs',
      'jobs_set',
      'jobs_validate',
    ]);
    // Every tool has a description: they're the agent-facing docs.
    for (const t of tools) {
      assert.ok(typeof t.description === 'string' && t.description.length > 20, t.name);
    }
    // Input schemas are the same zod definitions the API validates with.
    const create = tools.find(t => t.name === 'jobs_create');
    assert.deepEqual(create.inputSchema.required, ['name', 'schedule', 'command']);
    assert.equal(create.inputSchema.properties.name.maxLength, 40); // MAX_JOB_NAME
    assert.equal(create.inputSchema.properties.command.maxLength, 4000); // MAX_COMMAND
    // the app filter is optional (no required array)
    const list = tools.find(t => t.name === 'jobs_list');
    assert.equal(list.inputSchema.required, undefined);
    assert.equal(list.inputSchema.properties.app.pattern, '^[a-z0-9][a-z0-9\\-]{0,39}$');
    // a JSON number or a digit string
    const kill = tools.find(t => t.name === 'jobs_kill');
    assert.deepEqual(kill.inputSchema.properties.firedAt.anyOf, [
      { type: 'number' },
      { type: 'string', pattern: '^\\d{1,15}$' },
    ]);
    assert.deepEqual(tools.find(t => t.name === 'apps_list').inputSchema.properties, {});
  } finally {
    await w.client.close();
    await w.api.close();
  }
});

// ---------- read verbs ----------

test('jobs_list + apps_list: the API JSON verbatim; the app filter and its app_not_found', async () => {
  const w = await boot();
  try {
    const app = await w.apps.saveApp('Deploy Tools');
    assert.equal(app.ok, true);
    const created = await callJson(w.client, 'jobs_create', GOOD);
    assert.deepEqual(created.json, { name: 'nightly', session: null });
    await callJson(w.client, 'jobs_create', {
      name: 'rebuild',
      schedule: '0 6 * * *',
      command: 'make',
      appId: app.data.id,
    });

    const all = await callJson(w.client, 'jobs_list', {});
    assert.equal(all.isError, false);
    assert.equal(all.json.jobs.length, 2);
    const job = all.json.jobs[0];
    assert.equal(job.name, 'nightly');
    assert.equal(job.schedule, '0 4 * * *');
    assert.equal(job.command, 'echo hello');
    assert.equal(job.appId, null);

    const filtered = await callJson(w.client, 'jobs_list', { app: 'deploy-tools' });
    assert.equal(filtered.json.jobs.length, 1);
    assert.equal(filtered.json.jobs[0].name, 'rebuild');
    assert.equal(filtered.json.jobs[0].appName, 'Deploy Tools');

    // an unknown slug is a 404, never an empty list
    const unknown = await callJson(w.client, 'jobs_list', { app: 'no-such-app' });
    assert.equal(unknown.isError, false); // the API's answer, not a tool error
    assert.equal(unknown.json.code, 'app_not_found');

    const apps = await callJson(w.client, 'apps_list', {});
    assert.equal(apps.isError, false);
    assert.deepEqual(apps.json, {
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
  } finally {
    await w.client.close();
    await w.api.close();
  }
});

test('apps_list: a broken apps db answers the family database_error code', async () => {
  const w = await bootBrokenApps();
  try {
    const r = await callJson(w.client, 'apps_list', {});
    assert.equal(r.isError, false);
    assert.equal(r.json.code, 'database_error');
    // the jobs surface still answers: the failure is the apps family's
    const jobs = await callJson(w.client, 'jobs_list', {});
    assert.equal(jobs.isError, false);
    assert.deepEqual(jobs.json.jobs, []);
  } finally {
    await w.client.close();
    await w.api.close();
  }
});

// ---------- write verbs ----------

test('jobs_create: the browser save body; invalid_schedule carries the code', async () => {
  const w = await boot();
  try {
    const happy = await callJson(w.client, 'jobs_create', {
      name: 'Nightly Check', // normalized, exactly like the dialog
      schedule: '0 4 * * *',
      command: 'echo hello',
    });
    assert.deepEqual(happy.json, { name: 'nightly-check', session: null });

    const bad = await callJson(w.client, 'jobs_create', {
      name: 'x2',
      schedule: '99 * * * *', // shape-valid; the cron check is the API's
      command: 'echo hello',
    });
    assert.equal(bad.isError, false); // an API answer, not a tool error
    assert.equal(bad.json.code, 'invalid_schedule');
    assert.equal(bad.json.detail, null);
    assert.ok(typeof bad.json.error === 'string');
  } finally {
    await w.client.close();
    await w.api.close();
  }
});

test('jobs_set: absent keeps, provided sets; job_not_found on a ghost', async () => {
  const w = await boot();
  try {
    await callJson(w.client, 'jobs_create', GOOD);
    const app = await w.apps.saveApp('Deploy Tools');

    const patched = await callJson(w.client, 'jobs_set', {
      name: 'nightly',
      schedule: '30 5 * * *',
    });
    assert.deepEqual(patched.json, { name: 'nightly', session: null });

    const listed = await callJson(w.client, 'jobs_list', {});
    const job = listed.json.jobs[0];
    assert.equal(job.schedule, '30 5 * * *'); // set
    assert.equal(job.command, 'echo hello'); // kept

    await callJson(w.client, 'jobs_set', { name: 'nightly', appId: app.data.id });
    assert.equal((await callJson(w.client, 'jobs_list', {})).json.jobs[0].appId, app.data.id);
    await callJson(w.client, 'jobs_set', { name: 'nightly', appId: null }); // null clears
    assert.equal((await callJson(w.client, 'jobs_list', {})).json.jobs[0].appId, null);

    const missing = await callJson(w.client, 'jobs_set', { name: 'ghost', schedule: '0 4 * * *' });
    assert.equal(missing.json.code, 'job_not_found');
  } finally {
    await w.client.close();
    await w.api.close();
  }
});

test('jobs_delete: the delete body, then job_not_found on repeat', async () => {
  const w = await boot();
  try {
    await callJson(w.client, 'jobs_create', GOOD);
    const deleted = await callJson(w.client, 'jobs_delete', { name: 'nightly' });
    assert.deepEqual(deleted.json, { name: 'nightly', session: null });
    const again = await callJson(w.client, 'jobs_delete', { name: 'nightly' });
    assert.equal(again.json.code, 'job_not_found');
  } finally {
    await w.client.close();
    await w.api.close();
  }
});

test('jobs_run_now: the session answer; run_active while the previous run lives', async () => {
  const w = await boot();
  try {
    await callJson(w.client, 'jobs_create', GOOD);
    const run = await callJson(w.client, 'jobs_run_now', { name: 'nightly' });
    assert.deepEqual(run.json, { name: 'nightly', session: 'cybermole-nightly' });

    // the session is live → 409
    const busy = await callJson(w.client, 'jobs_run_now', { name: 'nightly' });
    assert.equal(busy.isError, false);
    assert.equal(busy.json.code, 'run_active');
    assert.ok(/still active/.test(busy.json.error));
  } finally {
    await w.client.close();
    await w.api.close();
  }
});

test('jobs_runs / jobs_log / jobs_kill: the run lifecycle over the tools', async () => {
  const w = await boot();
  try {
    await callJson(w.client, 'jobs_create', GOOD);

    const empty = await callJson(w.client, 'jobs_runs', { name: 'nightly' });
    assert.deepEqual(empty.json, { runs: [] });
    const noJob = await callJson(w.client, 'jobs_runs', { name: 'ghost' });
    assert.equal(noJob.isError, false);
    assert.equal(noJob.json.code, 'job_not_found');

    await callJson(w.client, 'jobs_run_now', { name: 'nightly' });
    const runs = await callJson(w.client, 'jobs_runs', { name: 'nightly' });
    assert.equal(runs.json.runs.length, 1);
    const { firedAt, origin, hasLog } = runs.json.runs[0];
    assert.equal(origin, 'manual');
    assert.equal(hasLog, false);

    // a log as the wrapper would write it, read back through the tool
    const paths = runLogPaths(w.logDir, 'nightly', firedAt);
    fs.mkdirSync(path.dirname(paths.log), { recursive: true });
    fs.writeFileSync(paths.log, 'line one\nline two\n');
    const log = await call(w.client, 'jobs_log', { name: 'nightly', firedAt });
    assert.equal(log.isError, false);
    assert.equal(log.text, 'line one\nline two\n'); // plain text, not JSON

    const noRun = await callJson(w.client, 'jobs_log', { name: 'nightly', firedAt: 123 });
    assert.equal(noRun.json.code, 'run_not_found');

    // the same run by its digit-string firedAt
    const logString = await call(w.client, 'jobs_log', {
      name: 'nightly',
      firedAt: String(firedAt),
    });
    assert.equal(logString.text, 'line one\nline two\n');

    const killed = await callJson(w.client, 'jobs_kill', { name: 'nightly', firedAt });
    assert.deepEqual(killed.json, { name: 'nightly', firedAt });
    const rekill = await callJson(w.client, 'jobs_kill', { name: 'nightly', firedAt });
    assert.equal(rekill.json.code, 'run_not_active');
    const noSuchRun = await callJson(w.client, 'jobs_kill', { name: 'nightly', firedAt: 123 });
    assert.equal(noSuchRun.json.code, 'run_not_found');

    // a second run can start; the history kept both
    await callJson(w.client, 'jobs_run_now', { name: 'nightly' });
    assert.equal((await callJson(w.client, 'jobs_runs', { name: 'nightly' })).json.runs.length, 2);
  } finally {
    await w.client.close();
    await w.api.close();
  }
});

test('jobs_validate: invalid values are answers; nothing sent is the API 400', async () => {
  const w = await boot();
  try {
    const ok = await callJson(w.client, 'jobs_validate', {
      schedule: '*/5 * * * *',
      command: 'true',
    });
    assert.equal(ok.json.schedule.valid, true);
    assert.match(ok.json.schedule.next, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    assert.deepEqual(ok.json.command, { valid: true, error: null });

    const bad = await callJson(w.client, 'jobs_validate', { schedule: '99 * * * *', command: '' });
    assert.equal(bad.isError, false); // 200: the ANSWER, not a failed request
    assert.equal(bad.json.schedule.valid, false);
    assert.ok(bad.json.schedule.error.length > 0);
    assert.equal(bad.json.command.valid, false);

    // {} passes the tool's loose shape; the API's root-level refine answers
    // validation_failure (issue under '').
    const nothing = await callJson(w.client, 'jobs_validate', {});
    assert.equal(nothing.json.code, 'validation_failure');
    assert.equal(nothing.json.issues[''], 'nothing to validate — send schedule and/or command');

    // An over-cap candidate reaches the API, which answers its own 413.
    const oversized = await callJson(w.client, 'jobs_validate', {
      command: 'x'.repeat(11 * 1024),
    });
    assert.equal(oversized.isError, false);
    assert.equal(oversized.json.code, 'body_too_large');
  } finally {
    await w.client.close();
    await w.api.close();
  }
});

// ---------- Content-Length ----------

test('the Content-Length discipline: lengthed bodies reach the cap check, never 411', async () => {
  const w = await boot();
  try {
    // A body without Content-Length gets 411 before a byte is read. A >10 KiB
    // body answering 413 proves the length was declared (validate's raw
    // strings are the one tool input that can exceed the cap).
    const big = await requestInternalApi(w.socketPath, {
      method: 'POST',
      path: '/jobs',
      body: JSON.stringify({
        name: 'big',
        schedule: '0 4 * * *',
        command: `x`.repeat(11 * 1024),
      }),
    });
    assert.equal(big.status, 413);
    assert.equal(JSON.parse(big.body).code, 'body_too_large');

    // Every other body-carrying call answered its domain codes; a 411 would have failed them.
    const happy = await callJson(w.client, 'jobs_create', GOOD);
    assert.deepEqual(happy.json, { name: 'nightly', session: null });
  } finally {
    await w.client.close();
    await w.api.close();
  }
});

// ---------- transport failures (the only isError results) ----------

test('the socket gone: the tool answers an isError transport message', async () => {
  const w = await boot();
  try {
    await w.api.close(); // the socket file is unlinked with the listener
    const r = await call(w.client, 'jobs_list', {});
    assert.equal(r.isError, true);
    assert.match(r.text, /could not reach the internal API at .*\(ENOENT\)/);
    assert.match(r.text, /is the cybermole server running/);
  } finally {
    await w.client.close();
  }
});

test('CYBERMOLE_SOCK empty: every tool answers the clear disabled error', async () => {
  // the server is up with the listener off
  const client = new Client({ name: 'mcp-unit', version: '0' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [MCP_CHILD],
      env: { CYBERMOLE_SOCK: '' },
    }),
  );
  try {
    for (const [name, args] of [
      ['jobs_list', {}],
      ['apps_list', {}],
      ['jobs_create', GOOD],
    ]) {
      const r = await call(client, name, args);
      assert.equal(r.isError, true, name);
      assert.match(r.text, /the internal API is disabled \(CYBERMOLE_SOCK is empty/, name);
    }
  } finally {
    await client.close();
  }
});

test('a bad CYBERMOLE_SOCK stops the MCP server at boot, like the web server', async () => {
  // A non-absolute value: stderr and exit 1, never a silent no-tools server.
  const child = spawn(process.execPath, [MCP_CHILD], {
    env: { ...process.env, CYBERMOLE_SOCK: 'cybermole.sock' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', c => {
    stderr += c;
  });
  const code = await new Promise(resolve => child.on('close', resolve));
  assert.equal(code, 1);
  assert.match(stderr, /CYBERMOLE_SOCK="cybermole.sock" must be an absolute socket path/);
});

// ---------- input contract ----------

test('the input contract: a value the shared schema rejects never leaves the client', async () => {
  const w = await boot();
  try {
    // 'cybermole-…' is reserved for run sessions; the API's own schema
    // rejects it at the tool boundary, with its own text.
    const r = await call(w.client, 'jobs_delete', { name: 'cybermole-x' });
    assert.equal(r.isError, true);
    assert.match(r.text, /invalid job name/);

    const create = await call(w.client, 'jobs_create', {
      name: 'cybermole-x',
      schedule: '0 4 * * *',
      command: 'echo hello',
    });
    assert.equal(create.isError, true);
    assert.match(create.text, /use letters, digits, - and _/);
    // nothing landed in the store
    assert.deepEqual((await callJson(w.client, 'jobs_list', {})).json.jobs, []);
  } finally {
    await w.client.close();
    await w.api.close();
  }
});
