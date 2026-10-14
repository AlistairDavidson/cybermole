// responses.test.mjs — src/lib/web/responses.service.ts: every error code
// of every family maps to its status and the body the browser reads. The
// wire statuses are the ones server/main.ts answered before the API moved
// into Astro routes (the e2e suite asserts them too).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appFailureResponse, consoleStateFailureResponse, databaseUpdateFailureResponse, failureResponse,
  firstIssueText, invalidAppSlugResponse, invalidFiredAtResponse, invalidJobNameResponse, invalidTerminalIdResponse,
  invalidWorkspaceIdResponse, jobFailureResponse, managementFailureResponse, piUpdateResponse, runLogResponse,
  piUpdateStatus, settingsStateFailureResponse, terminalFailureResponse,
  workspaceFailureResponse,
} from '../../dist-server/src/lib/web/responses.service.js';

const failure = (resultType, errorCode, extra = {}) => ({ ok: false, resultType, errorCode, ...extra });

test('failureResponse: parse, validation and upload codes', () => {
  const cases = [
    [failure('parse_request', 'invalid_form_data'), 400],
    [failure('parse_request', 'invalid_json'), 400],
    [failure('parse_request', 'unsupported_content_type'), 415],
    [failure('file_upload', 'unsupported_content_type'), 415],
    [failure('file_upload', 'invalid_form_data'), 400],
    [failure('file_upload', 'no_file_provided'), 400],
    [failure('file_upload', 'file_too_large', { errorMessage: 'too big' }), 413],
    [failure('file_upload', 'unsupported_file_type', { errorMessage: 'nope' }), 400],
    [failure('validation', 'validation_failure', { issues: { name: 'required' } }), 400],
  ];
  for (const [f, status] of cases) assert.equal(failureResponse(f).status, status, f.errorCode);
});

test('jobFailureResponse: every jobs code → status, with the { error, detail } body /jobs reads', async () => {
  const session = 'webpi-nightly';
  const cases = [
    ['invalid_schedule', 400],
    ['app_not_found', 404],
    ['job_not_found', 404], ['run_active', 409], ['tmux_error', 500], ['database_error', 500],
    // task/ws-jobs (plan §9): the runs families ride the same mapper.
    ['run_not_found', 404], ['log_missing', 404], ['read_error', 500],
  ];
  for (const [code, status] of cases) {
    const res = jobFailureResponse(failure('run_job', code, { errorMessage: `msg ${code}`, data: { name: 'nightly', session } }));
    assert.equal(res.status, status, code);
    const body = await res.json();
    assert.equal(body.code, code);
    assert.ok('detail' in body, code);
  }
  // run_active points at the live session; tmux_error carries tmux's reason as the detail
  assert.equal((await jobFailureResponse(failure('run_job', 'run_active', { data: { name: 'n', session } })).json()).detail, session);
  assert.deepEqual(await jobFailureResponse(failure('run_job', 'tmux_error', { errorMessage: 'boom' })).json(),
    { error: 'could not open run session', detail: 'boom', code: 'tmux_error' });
  const invalid = invalidJobNameResponse();
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), { error: 'invalid job name', detail: null, code: 'invalid_job_name' });

  // task/ws-jobs (plan §9): the :fired_at param guard and the log tail
  // response — text/plain, no-store, truncation disclosed only when cut.
  const badAt = invalidFiredAtResponse();
  assert.equal(badAt.status, 400);
  assert.deepEqual(await badAt.json(), { error: 'invalid fired_at (integer epoch ms)', detail: null, code: 'invalid_fired_at' });
  const log = runLogResponse({ text: 'tail\n', truncated: false });
  assert.equal(log.status, 200);
  assert.equal(log.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.equal(log.headers.get('cache-control'), 'no-store');
  assert.equal(log.headers.get('x-run-log-truncated'), null);
  assert.equal(await log.text(), 'tail\n');
  const cut = runLogResponse({ text: 'x', truncated: true });
  assert.equal(cut.headers.get('x-run-log-truncated'), '1');
});

test('piUpdateStatus / piUpdateResponse: busy is 409, the rest 500, success 200 with the UpdateResult body', async () => {
  for (const [code, status] of [['busy', 409], ['npm_missing', 500], ['npm_check_failed', 500], ['npm_failed', 500]]) {
    assert.equal(piUpdateStatus(failure('pi_update', code)), status, code);
  }
  const data = { dryRun: false, command: 'npm install x', before: '1.0.0', after: '1.1.0', output: 'ok' };
  const ok = piUpdateResponse({ ok: true, resultType: 'pi_update', data });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true, ...data });
  const busy = piUpdateResponse(failure('pi_update', 'busy', { data, errorMessage: 'an update is already running' }));
  assert.equal(busy.status, 409);
  assert.equal((await busy.json()).error, 'an update is already running');
});

test('databaseUpdateFailureResponse: 500 with the caller’s message', async () => {
  const res = databaseUpdateFailureResponse(failure('database_update', 'database_error', { errorMessage: 'disk' }),
    'could not save hidden state');
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { error: 'could not save hidden state', code: 'database_error' });
});

test('consoleState / settingsState failures: database_error is a 500 with the read’s message', async () => {
  for (const [res, resultType] of [
    [consoleStateFailureResponse(failure('console_state', 'database_error', { errorMessage: 'could not read hidden state: x' })), 'console_state'],
    [settingsStateFailureResponse(failure('settings_state', 'database_error', { errorMessage: 'could not read hidden state: x' })), 'settings_state'],
  ]) {
    assert.equal(res.status, 500, resultType);
    assert.deepEqual(await res.json(), { error: 'could not read hidden state: x', code: 'database_error' });
  }
});

test('firstIssueText: "field: message", the bare message at the root, a fallback when empty', () => {
  assert.equal(firstIssueText({ name: 'required', other: 'x' }), 'name: required');
  assert.equal(firstIssueText({ '': 'invalid session id' }), 'invalid session id');
  assert.equal(firstIssueText({}), 'bad request');
});

// task/mgmt-page: every management code → its status + the { error, code }
// body /management reads (docs/management-page.md §5). The families share
// the mapper, so the codes are exercised through the union directly.
test('managementFailureResponse: every code → status, with the { error, code } body', async () => {
  const cases = [
    ['management_state', 'database_error', 500],
    ['list_commits', 'checkout_missing', 404],
    ['list_commits', 'git_error', 500],
    ['enforcement_preview', 'base_unknown', 409],
    ['enforcement_preview', 'base_not_in_checkout', 409],
    ['enforcement_preview', 'target_not_found', 404],
    ['enforcement_preview', 'checkout_missing', 404],
    ['enforcement_preview', 'git_error', 500],
    ['request_build', 'invalid_credentials', 401],
    ['request_build', 'reauth_limited', 429],
    ['request_build', 'enforcement_rejected', 422],
    ['request_build', 'releases_not_configured', 503],
    ['request_build', 'build_active', 409],
    ['request_build', 'marker_error', 500],
    ['request_build', 'database_error', 500],
    ['activate_release', 'invalid_credentials', 401],
    ['activate_release', 'reauth_limited', 429],
    ['activate_release', 'release_not_built', 404],
    ['activate_release', 'release_invalid', 409],
  ];
  for (const [resultType, code, status] of cases) {
    const res = managementFailureResponse(failure(resultType, code, { errorMessage: `msg ${code}` }));
    assert.equal(res.status, status, code);
    const body = await res.json();
    assert.equal(body.code, code);
    assert.equal(body.error, `msg ${code}`);
  }
  // THE refusal carries the offending paths in its message
  const refused = managementFailureResponse(failure('request_build', 'enforcement_rejected',
    { errorMessage: 'refused: changes the protected set (compose.yaml, Dockerfile)' }));
  assert.equal(refused.status, 422);
  assert.match((await refused.json()).error, /compose\.yaml/);
});

// ---------- workspaces-plan §6: apps / workspaces / terminals (task/ws-schema) ----------

test('appFailureResponse: every apps code → status, { error, code } body', async () => {
  const cases = [
    ['save_app', 'invalid_name', 400],
    ['save_app', 'duplicate_slug', 409],
    ['save_app', 'app_not_found', 404],
    ['delete_app', 'app_not_found', 404],
    ['delete_app', 'database_error', 500],
  ];
  for (const [resultType, code, status] of cases) {
    const res = appFailureResponse(failure(resultType, code, { errorMessage: `msg ${code}` }));
    assert.equal(res.status, status, code);
    const body = await res.json();
    assert.equal(body.code, code, code);
    assert.equal(body.error, `msg ${code}`, code);
  }
  const slug = invalidAppSlugResponse();
  assert.equal(slug.status, 400);
  assert.deepEqual(await slug.json(), { error: 'invalid app slug', code: 'invalid_app_slug' });
});

test('workspaceFailureResponse: every workspaces code → status', async () => {
  const cases = [
    ['save_workspace', 'invalid_name', 400],
    ['save_workspace', 'invalid_cwd', 400],
    ['save_workspace', 'app_not_found', 404],
    ['save_workspace', 'workspace_not_found', 404],
    ['delete_workspace', 'workspace_not_found', 404],
    ['delete_workspace', 'database_error', 500],
  ];
  for (const [resultType, code, status] of cases) {
    const res = workspaceFailureResponse(failure(resultType, code));
    assert.equal(res.status, status, code);
    assert.equal((await res.json()).code, code, code);
  }
  const id = invalidWorkspaceIdResponse();
  assert.equal(id.status, 400);
  assert.deepEqual(await id.json(), { error: 'invalid workspace id', code: 'invalid_workspace_id' });
});

test('terminalFailureResponse: every terminals code → status; a spawn failure carries its row', async () => {
  const cases = [
    ['new_terminal', 'workspace_not_found', 404],
    ['new_terminal', 'server_not_running', 503], // the spawn's guard — reachable since task/ws-terminal
    ['new_terminal', 'tmux_error', 500],
    ['new_terminal', 'database_error', 500],
    ['close_terminal', 'terminal_not_found', 404],
    ['close_terminal', 'database_error', 500],
    ['rename_terminal', 'terminal_not_found', 404],
    ['rename_terminal', 'database_error', 500],
  ];
  for (const [resultType, code, status] of cases) {
    const res = terminalFailureResponse(failure(resultType, code));
    assert.equal(res.status, status, code);
    const body = await res.json();
    assert.equal(body.code, code, code);
    assert.equal(body.terminal, undefined, `${code}: no row on this failure`);
  }
  // The §4 contract: a spawn-failed create still returns its row (a dead
  // tab, live:false) on the 503/500 body — the UI renders the tab and the
  // first attach retries the spawn.
  const row = { id: '123e4567-e89b-42d3-a456-426614174000', workspaceId: '99999999-9999-4999-8999-999999999999',
    title: null, live: false };
  for (const code of ['server_not_running', 'tmux_error']) {
    const res = terminalFailureResponse(failure('new_terminal', code, { data: { ...row } }));
    const body = await res.json();
    assert.deepEqual(body.terminal, row, code);
  }
  const id = invalidTerminalIdResponse();
  assert.equal(id.status, 400);
  assert.deepEqual(await id.json(), { error: 'invalid terminal id', code: 'invalid_terminal_id' });
});
