// mcp.test.mjs — task/jobs-mcp (docs/jobs-agent-plan.md §6) units: the
// jobs MCP server as a REAL child process over stdio (node
// dist-server/server/mcp.js, CYBERMOLE_SOCK pointed at a real internal API
// booted in-process on a tmp socket — the internal-api.test.mjs world +
// its fake-tmux stand-in), spoken to with the SDK's client: the
// initialize handshake, tools/list (the full tool set, the input schemas
// rendered from the same zod definitions the API validates with), one
// happy call + one failure-code call per tool — asserting the tool text
// carries the internal API's Result JSON verbatim (its `code` field is
// the vocabulary; no second MCP result set) — and the transport failures
// (socket gone, CYBERMOLE_SOCK empty). The Content-Length discipline is
// asserted from the far side: every body the tools send is lengthed, so
// no request is refused 411 — an oversized body answers the 413
// body_too_large code that only a DECLARED over-cap length produces.
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
const { requestInternalApi } = await import('../../dist-server/server/mcp.js');
const { Scheduler, runLogPaths } = await import('../../dist-server/src/lib/jobs.js');
const { StateDb } = await import('../../dist-server/src/lib/db.js');
const { Apps } = await import('../../dist-server/src/lib/apps.js');

const MCP_CHILD = fileURLToPath(new URL('../../dist-server/server/mcp.js', import.meta.url));

// The jobs-runs stand-in tmux (internal-api.test.mjs's, kill-session
// included — the run/kill verbs need it): $dir/up marks the server up,
// $dir/sessions lists live session names.
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

/** The app domain over a db (light deps: apps.ts needs no tmux for
 *  reads). */
function appsFor(db) {
  return new Apps({
    db,
    username: () => ({ ok: true, data: { value: 'unit' } }),
    killSession: async () => true,
  });
}

/** One case's world: fresh db + scheduler + apps domain + the API booted
 *  on its own socket (the fake tmux server up from the start, no live
 *  sessions) + an MCP child over that socket, SDK client connected (the
 *  initialize handshake is connect()'s own work). */
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

/** An MCP child pointed at a world whose APPS db is broken (jobs verbs
 *  fine — apps_list's database_error code is the one failure its family
 *  has). */
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

/** One tool call: the concatenated text content plus the isError flag.
 *  A domain failure comes back a normal result (isError false) — the
 *  API's Result JSON is the answer. */
async function call(client, name, args = {}) {
  const r = await client.callTool({ name, arguments: args });
  assert.ok(Array.isArray(r.content) && r.content.length > 0, `${name}: text content`);
  for (const block of r.content) assert.equal(block.type, 'text', `${name}: text block`);
  return { isError: r.isError === true, text: r.content.map(b => b.text).join('') };
}

/** A call whose text must be the API's JSON answer (success or failure —
 *  the body is the assertion's either way). */
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

// ---------- the handshake + the tool set ----------

test('initialize handshake + tools/list: the full tool set, schemas from the shared definitions', async () => {
  const w = await boot();
  try {
    // connect() did the MCP initialize; the server's identity rode it back
    assert.deepEqual(w.client.getServerVersion(), {
      name: 'cybermole-jobs',
      version: '0.1.0',
    });
    const { tools } = await w.client.listTools();
    assert.deepEqual(
      tools.map(t => t.name).sort(),
      [
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
      ],
    );
    // Every tool documents itself — the descriptions are the agent-facing
    // docs (there is no --help round-trip here; §6: the tool IS the doc).
    for (const t of tools) {
      assert.ok(typeof t.description === 'string' && t.description.length > 20, t.name);
    }
    // The input schemas are the SAME zod definitions the internal API
    // validates with (src/schemas/*): the wire contract an agent sees in
    // tools/list is the rule the server enforces.
    const create = tools.find(t => t.name === 'jobs_create');
    assert.deepEqual(create.inputSchema.required, ['name', 'schedule', 'command']);
    assert.equal(create.inputSchema.properties.name.maxLength, 40); // MAX_JOB_NAME
    assert.equal(create.inputSchema.properties.command.maxLength, 4000); // MAX_COMMAND
    // jobs_list's app filter is OPTIONAL (no required array at all)
    const list = tools.find(t => t.name === 'jobs_list');
    assert.equal(list.inputSchema.required, undefined);
    assert.equal(list.inputSchema.properties.app.pattern, '^[a-z0-9][a-z0-9\\-]{0,39}$');
    // the run id: a JSON number (jobs_runs' firedAt) or its digit-string
    const kill = tools.find(t => t.name === 'jobs_kill');
    assert.deepEqual(kill.inputSchema.properties.firedAt.anyOf, [
      { type: 'number' },
      { type: 'string', pattern: '^\\d{1,15}$' },
    ]);
    // the zero-argument picker
    assert.deepEqual(tools.find(t => t.name === 'apps_list').inputSchema.properties, {});
  } finally {
    await w.client.close();
    await w.api.close();
  }
});

// ---------- the read verbs ----------

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

    // an unknown slug is the 404 ANSWER (never an empty list, plan §4)
    const unknown = await callJson(w.client, 'jobs_list', { app: 'no-such-app' });
    assert.equal(unknown.isError, false); // the API's answer, not a tool error
    assert.equal(unknown.json.code, 'app_not_found');

    const apps = await callJson(w.client, 'apps_list', {});
    assert.equal(apps.isError, false);
    assert.deepEqual(apps.json, {
      apps: [{ id: app.data.id, name: 'Deploy Tools', slug: 'deploy-tools', cwd: null, order: 10 }],
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
    // the jobs surface on the same world still answers (the failure is
    // the apps family's, not the transport's)
    const jobs = await callJson(w.client, 'jobs_list', {});
    assert.equal(jobs.isError, false);
    assert.deepEqual(jobs.json.jobs, []);
  } finally {
    await w.client.close();
    await w.api.close();
  }
});

// ---------- the write verbs ----------

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

    const patched = await callJson(w.client, 'jobs_set', { name: 'nightly', schedule: '30 5 * * *' });
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

    // the fake tmux session is live → the 409 answer, the plan's no-pile-up rule
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
    // the failure code path: a job that doesn't exist
    const noJob = await callJson(w.client, 'jobs_runs', { name: 'ghost' });
    assert.equal(noJob.isError, false);
    assert.equal(noJob.json.code, 'job_not_found');

    await callJson(w.client, 'jobs_run_now', { name: 'nightly' });
    const runs = await callJson(w.client, 'jobs_runs', { name: 'nightly' });
    assert.equal(runs.json.runs.length, 1);
    const { firedAt, origin, hasLog } = runs.json.runs[0];
    assert.equal(origin, 'manual');
    assert.equal(hasLog, false);

    // the log the wrapper would have written, read back through the tool
    const paths = runLogPaths(w.logDir, 'nightly', firedAt);
    fs.mkdirSync(path.dirname(paths.log), { recursive: true });
    fs.writeFileSync(paths.log, 'line one\nline two\n');
    const log = await call(w.client, 'jobs_log', { name: 'nightly', firedAt });
    assert.equal(log.isError, false);
    assert.equal(log.text, 'line one\nline two\n'); // plain text, not JSON

    const noRun = await callJson(w.client, 'jobs_log', { name: 'nightly', firedAt: 123 });
    assert.equal(noRun.json.code, 'run_not_found');

    // the firedAt as the digit STRING the routes take — same run
    const logString = await call(w.client, 'jobs_log', { name: 'nightly', firedAt: String(firedAt) });
    assert.equal(logString.text, 'line one\nline two\n');

    const killed = await callJson(w.client, 'jobs_kill', { name: 'nightly', firedAt });
    assert.deepEqual(killed.json, { name: 'nightly', firedAt });
    const rekill = await callJson(w.client, 'jobs_kill', { name: 'nightly', firedAt });
    assert.equal(rekill.json.code, 'run_not_active');
    const noSuchRun = await callJson(w.client, 'jobs_kill', { name: 'nightly', firedAt: 123 });
    assert.equal(noSuchRun.json.code, 'run_not_found');

    // a second run can start now; the runs history kept both
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
    const ok = await callJson(w.client, 'jobs_validate', { schedule: '*/5 * * * *', command: 'true' });
    assert.equal(ok.json.schedule.valid, true);
    assert.match(ok.json.schedule.next, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    assert.deepEqual(ok.json.command, { valid: true, error: null });

    const bad = await callJson(w.client, 'jobs_validate', { schedule: '99 * * * *', command: '' });
    assert.equal(bad.isError, false); // 200: the ANSWER, not a failed request
    assert.equal(bad.json.schedule.valid, false);
    assert.ok(bad.json.schedule.error.length > 0);
    assert.equal(bad.json.command.valid, false);

    // {} passes the tool's loose shape on purpose: the API's
    // validation_failure is validate's one real failure code (the refine
    // is the schema's ROOT-level rule — its issue rides under '')
    const nothing = await callJson(w.client, 'jobs_validate', {});
    assert.equal(nothing.json.code, 'validation_failure');
    assert.equal(
      nothing.json.issues[''],
      'nothing to validate — send schedule and/or command',
    );

    // a candidate OVER the 10 KiB body cap reaches the API too (the
    // validate inputs are raw by design — invalid values are for the
    // API to judge): the API answers its own 413 body_too_large code,
    // never a tool-boundary rejection
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

// ---------- the Content-Length discipline (plan §6's protocol note) ----------

test('the Content-Length discipline: lengthed bodies reach the cap check, never 411', async () => {
  const w = await boot();
  try {
    // A body-carrying request WITHOUT Content-Length is refused 411 before
    // a byte is read (internal-api.ts bodyCapStatus). Every body the MCP
    // client sends is lengthed. A >10 KiB body answers the API's 413
    // body_too_large — the answer ONLY a declared over-cap length can
    // produce (asserted at the transport here, and THROUGH a tool in the
    // jobs_validate test — its raw candidate strings are the one tool
    // input that can exceed the cap; jobs_create/jobs_set cap their
    // fields far below it):
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

    // every ordinary body-carrying tool call in this suite answers the
    // domain codes asserted above — a 411 would have failed them all
    const happy = await callJson(w.client, 'jobs_create', GOOD);
    assert.deepEqual(happy.json, { name: 'nightly', session: null });
  } finally {
    await w.client.close();
    await w.api.close();
  }
});

// ---------- the transport failures (the only isError results) ----------

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
  // no world needed — the server is up with the listener off (§3)
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
  // env.ts's absolute-path rule (§3): the same operator-wiring-mistake
  // stance main.ts takes — stderr + exit 1, never a silent no-tools serve
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

// ---------- the input contract ----------

test("the input contract: a value the shared schema rejects never leaves the client", async () => {
  const w = await boot();
  try {
    // 'cybermole-…' is reserved for run sessions (JobNameSchema/JobSaveSchema's
    // name rule) — the SAME definition the API validates with rejects it
    // at the tool boundary, with the rule's own text, not a new vocabulary
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
    // and nothing landed in the API's store
    assert.deepEqual((await callJson(w.client, 'jobs_list', {})).json.jobs, []);
  } finally {
    await w.client.close();
    await w.api.close();
  }
});
