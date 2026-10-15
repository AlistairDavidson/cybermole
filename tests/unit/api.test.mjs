// api.test.mjs — request-body schemas for the JSON endpoints
// (src/schemas/api.ts): shape-level acceptance and the exact parse outputs
// the handlers consume, and the 400 text a failure renders as
// (parseZod → firstIssueText, src/lib/web). Domain rules that stay with the domain code (job-name
// regex, cron schedules in jobs.ts) are covered by jobs.test.mjs, not here.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  loginBody, loginForm, jobValidateBody, updatePiBody, autoUpdateBody,
  appCreateBody, appPatchBody, workspaceCreateBody, workspacePatchBody,
  terminalCreateBody, terminalPatchBody, appForm, workspaceForm,
} from '../../dist-server/src/schemas/api.js';
import { JobSaveSchema } from '../../dist-server/src/schemas/jobs.js';
import { parseZod } from '../../dist-server/src/lib/web/parsing.service.js';
import { firstIssueText } from '../../dist-server/src/lib/web/responses.service.js';

/** The one-line 400 text a failed body renders as. */
const issueText = (schema, v) => {
  const r = parseZod(v, schema);
  assert.equal(r.ok, false, JSON.stringify(v));
  return firstIssueText(r.issues);
};

const ok = (schema, v) => schema.safeParse(v).success;
const parse = (schema, v) => {
  const r = schema.safeParse(v);
  assert.ok(r.success, JSON.stringify(v));
  return r.data;
};

test('loginBody: string username + password, extra keys stripped', () => {
  assert.deepEqual(parse(loginBody, { username: 'u', password: 'p', junk: 1 }),
    { username: 'u', password: 'p' });
  // empty strings are strings — verify() decides those, not the schema
  assert.equal(ok(loginBody, { username: '', password: '' }), true);
  for (const bad of [{}, { username: 'u' }, { password: 'p' },
    { username: 5, password: 'p' }, { username: 'u', password: null }, null, []]) {
    assert.equal(ok(loginBody, bad), false, JSON.stringify(bad));
  }
});

test('JobSaveSchema: normalizes the name, trims, and names each failing field', () => {
  assert.deepEqual(parse(JobSaveSchema, { name: '  Nightly Check ', schedule: ' */5 * * * * ', command: ' true ', extra: 1 }),
    { name: 'nightly-check', schedule: '*/5 * * * *', command: 'true' });
  // exactly 40 as typed passes
  assert.equal(parse(JobSaveSchema, { name: 'x'.repeat(40), schedule: 's', command: 'c' }).name, 'x'.repeat(40));
  // the cron *validity* is saveJob's (cron-parser stays server-side)
  assert.equal(ok(JobSaveSchema, { name: 'n', schedule: 'daily 08:00', command: 'true' }), true);
  const cases = [
    [{ name: '!!!', schedule: 's', command: 'c' }, 'name: name is required'],
    [{ name: 'webpi-x', schedule: 's', command: 'c' }, /^name: use letters/],
    // too long as typed: rejected, never silently cut to 40
    [{ name: 'x'.repeat(41), schedule: 's', command: 'c' }, 'name: name is too long (max 40)'],
    [{ name: 'n', schedule: '  ', command: 'c' }, 'schedule: schedule is required'],
    [{ name: 'n', schedule: 'x'.repeat(121), command: 'c' }, /^schedule: schedule is too long/],
    [{ name: 'n', schedule: 'a\nb', command: 'c' }, 'schedule: schedule must be one line'],
    [{ name: 'n', schedule: 's', command: '   ' }, 'command: command is required'],
    [{ name: 'n', schedule: 's', command: 'a\nb' }, 'command: command must be one line'],
    [{ name: 'n', schedule: 's', command: 'x'.repeat(4001) }, /^command: command is too long/],
    [{ name: 5, schedule: 's', command: 'c' }, /^name: /],
  ];
  for (const [input, expected] of cases) {
    const text = issueText(JobSaveSchema, input);
    if (expected instanceof RegExp) assert.match(text, expected, JSON.stringify(input));
    else assert.equal(text, expected, JSON.stringify(input));
  }
});

test('jobValidateBody: one string', () => {
  // validate: '' passes — checkCron reports 'schedule is required' with a 200
  assert.deepEqual(parse(jobValidateBody, { schedule: '' }), { schedule: '' });
  assert.equal(ok(jobValidateBody, {}), false);
  assert.equal(ok(jobValidateBody, { schedule: 5 }), false);
});

test('loginForm: stricter than loginBody — empty fields fail in the browser', () => {
  assert.equal(ok(loginForm, { username: 'u', password: 'p' }), true);
  assert.equal(issueText(loginForm, { username: '', password: 'p' }), 'username: enter your username');
  assert.equal(issueText(loginForm, { username: 'u', password: '' }), 'password: enter your password');
  assert.equal(ok(loginBody, { username: '', password: '' }), true); // the server stays permissive
});

test('updatePiBody: dryRun defaults false; only booleans pass', () => {
  assert.deepEqual(parse(updatePiBody, {}), { dryRun: false });
  assert.deepEqual(parse(updatePiBody, { dryRun: true }), { dryRun: true });
  assert.deepEqual(parse(updatePiBody, { dryRun: false }), { dryRun: false });
  // a truthy non-boolean used to fall through to a REAL update — now a 400
  for (const bad of [{ dryRun: 1 }, { dryRun: 'true' }, { dryRun: null }, { dryRun: [] }]) {
    assert.equal(ok(updatePiBody, bad), false, JSON.stringify(bad));
  }
});

test('autoUpdateBody: one boolean; anything else names the field', () => {
  assert.deepEqual(parse(autoUpdateBody, { enabled: true }), { enabled: true });
  for (const bad of [{}, { enabled: 'yes' }, { enabled: 1 }]) {
    assert.equal(ok(autoUpdateBody, bad), false, JSON.stringify(bad));
  }
  assert.equal(issueText(autoUpdateBody, { enabled: 'yes' }), 'enabled: enabled must be a boolean');
});

test('a failed body renders "field: message" (the 400 text)', () => {
  assert.match(issueText(appCreateBody, { name: 5 }), /^name: /);
});

// ---------- the console dialogs' forms (task/ws-console, plan §8) ----------

test('appForm: trimmed non-empty name capped at 80; optional cwd — empty passes (an empty wa-input is null, parsed as "")', () => {
  assert.deepEqual(parse(appForm, { name: '  My App! ' }), { name: 'My App!' });
  assert.deepEqual(parse(appForm, { name: 'My App! ', cwd: '' }), { name: 'My App!', cwd: '' }); // unset
  assert.deepEqual(parse(appForm, { name: 'My App!', cwd: ' /srv/app ' }), { name: 'My App!', cwd: '/srv/app' });
  assert.equal(issueText(appForm, { name: '   ' }), 'name: name is required');
  assert.equal(issueText(appForm, { name: 'x'.repeat(81) }), 'name: name is too long (max 80)');
  assert.equal(issueText(appForm, { name: 'w', cwd: 'x'.repeat(4097) }), 'cwd: cwd is too long');
  for (const bad of [{}, { name: 5 }, null, { name: 'w', cwd: 5 }]) {
    assert.equal(ok(appForm, bad), false, JSON.stringify(bad));
  }
});

test('workspaceForm: name only (task/app-cwd — no folder setting; the dialog shows the derived start dir as a hint)', () => {
  assert.deepEqual(parse(workspaceForm, { name: ' scratch ' }), { name: 'scratch' });
  // a cwd key is stripped, never honored — the server derives the dir
  assert.deepEqual(parse(workspaceForm, { name: 'scratch', cwd: '/workspace' }), { name: 'scratch' });
  assert.equal(issueText(workspaceForm, { name: '' }), 'name: name is required');
  assert.equal(issueText(workspaceForm, { name: 'x'.repeat(121) }), 'name: name is too long (max 120)');
  for (const bad of [null, {}, { name: 5 }, { name: '' }, { name: '   ' }]) {
    assert.equal(ok(workspaceForm, bad), false, JSON.stringify(bad));
  }
});

// ---------- workspaces-plan §6 bodies (task/ws-schema) ----------

test('appCreateBody: any string name (the domain slugs it); cwd optional (task/app-cwd); over-longs are named 400s', () => {
  assert.deepEqual(parse(appCreateBody, { name: '  My App!' }), { name: '  My App!' });
  assert.deepEqual(parse(appCreateBody, { name: '' }), { name: '' }); // emptiness is the domain's call
  assert.deepEqual(parse(appCreateBody, { name: 'x', cwd: '/srv/app' }), { name: 'x', cwd: '/srv/app' });
  for (const bad of [
    {}, { name: 5 }, null, { name: null },
    { name: 'x', cwd: 5 }, { name: 'x', cwd: 'x'.repeat(4097) },
  ]) {
    assert.equal(ok(appCreateBody, bad), false, JSON.stringify(bad));
  }
  assert.equal(issueText(appCreateBody, { name: 'x'.repeat(81) }), 'name: name is too long (max 80)');
  assert.equal(issueText(appCreateBody, { name: 'x', cwd: 'x'.repeat(4097) }), 'cwd: cwd is too long');
});

test('appPatchBody: name optional; cwd per terminalPatchBody (absent keeps, null clears, string sets)', () => {
  assert.deepEqual(parse(appPatchBody, {}), {});
  assert.deepEqual(parse(appPatchBody, { name: 'New' }), { name: 'New' });
  assert.deepEqual(parse(appPatchBody, { cwd: '/srv/app' }), { cwd: '/srv/app' });
  assert.deepEqual(parse(appPatchBody, { cwd: null }), { cwd: null }); // null clears (task/app-cwd)
  assert.equal(ok(appPatchBody, { name: 5 }), false);
  assert.equal(ok(appPatchBody, { cwd: 5 }), false);
  assert.equal(issueText(appPatchBody, { name: 'x'.repeat(81) }), 'name: name is too long (max 80)');
  assert.equal(issueText(appPatchBody, { cwd: 'x'.repeat(4097) }), 'cwd: cwd is too long');
});

test('workspaceCreateBody: appId null/absent/uuid v4; name required; NO cwd (task/app-cwd — the server derives it, an app carries it)', () => {
  const ID = '123e4567-e89b-42d3-a456-426614174000';
  assert.deepEqual(parse(workspaceCreateBody, { name: 'scratch' }), { name: 'scratch' });
  // a cwd on the wire is stripped, never honored — the create derives it
  assert.deepEqual(parse(workspaceCreateBody, { appId: null, name: 'x', cwd: '/tmp', junk: 1 }),
    { appId: null, name: 'x' });
  assert.deepEqual(parse(workspaceCreateBody, { appId: ID, name: 'x' }), { appId: ID, name: 'x' });
  for (const bad of [
    {}, { name: 5 }, { appId: 'nope', name: 'x' }, { appId: 7, name: 'x' },
  ]) {
    assert.equal(ok(workspaceCreateBody, bad), false, JSON.stringify(bad));
  }
  assert.deepEqual(parse(workspaceCreateBody, { name: '' }), { name: '' }); // emptiness is the domain's call
  assert.equal(issueText(workspaceCreateBody, { appId: 'nope', name: 'x' }), 'appId: invalid app id');
});

test('workspacePatchBody: either field alone, both optional', () => {
  assert.deepEqual(parse(workspacePatchBody, {}), {});
  assert.deepEqual(parse(workspacePatchBody, { name: 'n' }), { name: 'n' });
  assert.deepEqual(parse(workspacePatchBody, { cwd: '/tmp' }), { cwd: '/tmp' });
  assert.equal(ok(workspacePatchBody, { name: 5, cwd: '/tmp' }), false);
});

test('terminalCreateBody: optional non-empty title, capped at 120', () => {
  assert.deepEqual(parse(terminalCreateBody, {}), {});
  assert.deepEqual(parse(terminalCreateBody, { title: ' build ' }), { title: 'build' }); // trimmed
  for (const bad of [{ title: '' }, { title: '   ' }, { title: 'x'.repeat(121) }, { title: 5 }]) {
    assert.equal(ok(terminalCreateBody, bad), false, JSON.stringify(bad));
  }
  assert.equal(issueText(terminalCreateBody, { title: '' }), 'title: title is required');
});

test('terminalPatchBody: non-empty string, null (clear), or absent (no-op); empty is a 400', () => {
  assert.deepEqual(parse(terminalPatchBody, { title: 'build' }), { title: 'build' });
  assert.deepEqual(parse(terminalPatchBody, { title: null }), { title: null });
  assert.deepEqual(parse(terminalPatchBody, {}), {}); // absent = no-op, like the other patches
  for (const bad of [{ title: '' }, { title: 'x'.repeat(121) }, { title: 5 }]) {
    assert.equal(ok(terminalPatchBody, bad), false, JSON.stringify(bad));
  }
});

test('JobSaveSchema now accepts an optional appId tag (stored by task/ws-jobs)', () => {
  const ID = '123e4567-e89b-42d3-a456-426614174000';
  assert.deepEqual(parse(JobSaveSchema, { name: 'n', schedule: 's', command: 'c' }).appId, undefined);
  assert.deepEqual(parse(JobSaveSchema, { name: 'n', schedule: 's', command: 'c', appId: null }).appId, null);
  assert.deepEqual(parse(JobSaveSchema, { name: 'n', schedule: 's', command: 'c', appId: ID }).appId, ID);
  assert.equal(ok(JobSaveSchema, { name: 'n', schedule: 's', command: 'c', appId: 'nope' }), false);
});
