// apps.test.mjs — the app domain (src/lib/apps.ts, workspaces-plan §3):
// every Result family at every error code, plus the slug rules it hangs
// on (src/schemas/patterns.ts: normalizeSlug, APP_SLUG_RE). Runs against
// the compiled dist-server (npm run test:unit).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { StateDb, qb } from '../../dist-server/src/lib/db.js';
import { Apps } from '../../dist-server/src/lib/apps.js';
import { Workspaces } from '../../dist-server/src/lib/workspaces.js';
import { terminalSessionName } from '../../dist-server/src/lib/tmux.js';
import { APP_SLUG_RE, UUID_RE, normalizeSlug } from '../../dist-server/src/schemas/patterns.js';
import { AppIdSchema, AppSlugSchema } from '../../dist-server/src/schemas/ids.js';

const USERNAME = { ok: true, resultType: 'database_read', data: { value: 'tester' } };
const USERNAME_FAIL = {
  ok: false, resultType: 'database_read', errorCode: 'database_error', errorMessage: 'could not read the credential',
};

function freshDb() {
  return new StateDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'webpi-apps-')), 'webpi.db'));
}

/** A db that cannot open: a path under a regular file (mkdir of its parent
 *  fails inside db()) — every read/write becomes database_error. */
function brokenDb() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'webpi-apps-')), 'not-a-dir');
  fs.writeFileSync(file, '');
  return new StateDb(path.join(file, 'webpi.db'));
}

function recorder() {
  const killed = [];
  return { killed, killSession: async name => (killed.push(name), true) };
}

function apps(db, username = USERNAME, killSession = async () => true) {
  return new Apps({ db, username: () => username, killSession });
}

const appRow = (db, slug) =>
  db.get(qb.selectFrom('apps').select(['id', 'name', 'slug', 'sort_order', 'created_by', 'updated_by']).where('slug', '=', slug));
const rows = (db, table) => db.all(qb.selectFrom(table).selectAll());

// ---------- slug rules ----------

test('normalizeSlug: lowercase, collapse junk (underscores included) to -, strip edges, cap 40', () => {
  assert.equal(normalizeSlug('My App!'), 'my-app');
  assert.equal(normalizeSlug('  spaced   out  '), 'spaced-out');
  assert.equal(normalizeSlug('under_score'), 'under-score'); // app slugs admit no _
  assert.equal(normalizeSlug('--leading--and--trailing--'), 'leading-and-trailing');
  assert.equal(normalizeSlug('x'.repeat(50)), 'x'.repeat(40));
  assert.equal(normalizeSlug('!!!'), '');
  assert.equal(normalizeSlug('   '), '');
});

test('normalizeSlug\'s output always satisfies APP_SLUG_RE or is empty', () => {
  for (const raw of ['A', '9lives', 'My App!', 'a_b', '  x  ', 'ümlaut app', 'x'.repeat(80), '-x-', '42']) {
    const slug = normalizeSlug(raw);
    assert.ok(slug === '' || APP_SLUG_RE.test(slug), `${raw} → ${slug}`);
  }
});

test('APP_SLUG_RE: lowercase start, then lowercase/digits/dashes, up to 40; UUID_RE: lowercase v4 pinned', () => {
  for (const good of ['a', 'my-app', 'a'.repeat(40), '9lives', 'a-1']) assert.equal(APP_SLUG_RE.test(good), true, good);
  for (const bad of ['', 'A', '-a', '_a', 'a_b', 'a'.repeat(41), 'a B', 'ä']) {
    assert.equal(APP_SLUG_RE.test(bad), false, bad);
  }
  const v4 = '123e4567-e89b-42d3-a456-426614174000';
  assert.equal(UUID_RE.test(v4), true);
  assert.equal(UUID_RE.test('123e4567-e89b-72d3-a456-426614174000'), false); // v7: version nibble
  assert.equal(UUID_RE.test(v4.toUpperCase()), false);                        // lowercase only
  assert.equal(UUID_RE.test('123e4567-e89b-42d3-c456-426614174000'), false); // bad variant nibble
  assert.equal(UUID_RE.test('019f4706-0000-7000-8000-00000000000a'), false); // a pi session id shape
});

test('AppSlugSchema / AppIdSchema: pass unchanged (brand is type-only), reject junk with the named message', () => {
  assert.equal(AppSlugSchema.parse('my-app'), 'my-app');
  for (const bad of ['', 'Nope', '-x', 'a_b', 'x'.repeat(41)]) {
    assert.equal(AppSlugSchema.safeParse(bad).success, false, bad);
  }
  assert.equal(AppSlugSchema.safeParse('Nope').error.issues[0].message, 'invalid app slug');
  const id = '123e4567-e89b-42d3-a456-426614174000';
  assert.equal(AppIdSchema.parse(id), id);
  for (const bad of ['', 'nope', id.toUpperCase(), '123e4567-e89b-72d3-a456-426614174000', 5, null]) {
    assert.equal(AppIdSchema.safeParse(bad).success, false, String(bad));
  }
  assert.equal(AppIdSchema.safeParse('nope').error.issues[0].message, 'invalid app id');
});

// ---------- save_app ----------

test('save_app: derives the slug, allocates order in steps of 10, stamps the credential username', async () => {
  const db = freshDb();
  const a = apps(db);
  const first = await a.saveApp('My App!');
  assert.equal(first.ok, true, first.errorMessage);
  assert.equal(first.resultType, 'save_app');
  assert.equal(first.data.slug, 'my-app');
  assert.equal(first.data.name, 'My App!');
  assert.match(first.data.id, UUID_RE);
  const row = appRow(db, 'my-app');
  assert.equal(row.sort_order, 10);
  assert.equal(row.created_by, 'tester');
  assert.equal(row.updated_by, 'tester');
  const second = await a.saveApp('another');
  assert.equal(appRow(db, 'another').sort_order, 20);
  assert.equal(second.data.slug, 'another');
});

test('save_app: invalid_name — empty or nothing that slugs', async () => {
  const a = apps(freshDb());
  for (const name of ['', '   ', '!!!']) {
    const r = await a.saveApp(name);
    assert.equal(r.ok, false, name);
    assert.equal(r.resultType, 'save_app');
    assert.equal(r.errorCode, 'invalid_name', name);
  }
  assert.equal((await a.saveApp('   ')).errorMessage, 'name is required');
});

test('save_app: duplicate_slug on a taken slug, whatever the display name', async () => {
  const a = apps(freshDb());
  assert.equal((await a.saveApp('scratch')).ok, true);
  const dup = await a.saveApp('Scratch!');
  assert.equal(dup.ok, false);
  assert.equal(dup.errorCode, 'duplicate_slug');
  assert.match(dup.errorMessage, /scratch/);
});

test('save_app: database_error — unwritable db, or the username read failing', async () => {
  const broken = await apps(brokenDb()).saveApp('nope');
  assert.equal(broken.ok, false);
  assert.equal(broken.errorCode, 'database_error');
  const noUser = await apps(freshDb(), USERNAME_FAIL).saveApp('nope');
  assert.equal(noUser.ok, false);
  assert.equal(noUser.errorCode, 'database_error');
  assert.match(noUser.errorMessage, /credential/);
});

// ---------- rename (the save_app family's second entry point) ----------

test('rename: changes the display name, never the slug; absent name is a no-op read-back', async () => {
  const db = freshDb();
  const a = apps(db);
  const { slug } = (await a.saveApp('Old Name')).data;
  const renamed = await a.renameApp(slug, 'New Name');
  assert.equal(renamed.ok, true, renamed.errorMessage);
  assert.equal(renamed.data.name, 'New Name');
  assert.equal(renamed.data.slug, 'old-name');
  assert.equal(appRow(db, 'old-name').name, 'New Name');
  const noop = await a.renameApp('old-name', undefined);
  assert.equal(noop.ok, true);
  assert.deepEqual(noop.data, { id: renamed.data.id, name: 'New Name', slug: 'old-name' });
});

test('rename: invalid_name on an empty name; app_not_found on a slug that does not resolve', async () => {
  const a = apps(freshDb());
  const { slug } = (await a.saveApp('x')).data;
  assert.equal((await a.renameApp(slug, '  ')).errorCode, 'invalid_name');
  assert.equal((await a.renameApp('missing', 'y')).errorCode, 'app_not_found');
  assert.equal((await a.renameApp('missing', 'y')).resultType, 'save_app');
});

// ---------- delete_app ----------

test('delete_app: cascades workspaces and terminals, un-tags jobs, best-effort-kills the terminals\' sessions', async () => {
  const db = freshDb();
  const { killed, killSession } = recorder();
  const a = apps(db, USERNAME, killSession);
  const w = new Workspaces({
    db, username: () => USERNAME, killSession, defaultCwd: os.tmpdir(),
    spawnSession: async name => ({ ok: true, resultType: 'tmux_session', data: { name } }),
  });
  const app = (await a.saveApp('gone')).data;
  const ws = (await w.saveWorkspace({ appId: app.id, name: 'under it' })).data;
  const t1 = (await w.newTerminal(ws.id, 'one')).data;
  const t2 = (await w.newTerminal(ws.id, undefined)).data;
  const consoleWs = (await w.saveWorkspace({ name: 'console one' })).data;
  const consoleTerm = (await w.newTerminal(consoleWs.id, undefined)).data;
  // a job tagged with the app (raw: the tag picker is task/ws-jobs)
  db.run(qb.insertInto('jobs')
    .values({ name: 'nightly', schedule: '* * * * *', command: 'true', created_at: 1, app_id: app.id }));

  const deleted = await a.deleteApp('gone');
  assert.equal(deleted.ok, true, deleted.errorMessage);
  assert.equal(deleted.resultType, 'delete_app');
  assert.deepEqual(deleted.data, { id: app.id });
  // the cascade: app gone, its workspace and terminals with it
  assert.equal(appRow(db, 'gone'), undefined);
  assert.deepEqual(rows(db, 'workspaces').map(r => r.id), [consoleWs.id]);
  assert.deepEqual(rows(db, 'terminals').map(r => r.id), [consoleTerm.id]);
  // jobs are un-tagged, never deleted (spread: node:sqlite rows carry a
  // null prototype, which deepEqual treats as a different object)
  const job = db.get(qb.selectFrom('jobs').select(['name', 'app_id']).where('name', '=', 'nightly'));
  assert.deepEqual({ ...job }, { name: 'nightly', app_id: null });
  // exactly the deleted terminals' derived session names were killed
  assert.deepEqual(killed.sort(), [terminalSessionName(t1.id), terminalSessionName(t2.id)].sort());
  assert.equal(killed.includes(terminalSessionName(consoleTerm.id)), false);

  const again = await a.deleteApp('gone');
  assert.equal(again.ok, false);
  assert.equal(again.errorCode, 'app_not_found');
});

test('delete_app: database_error on an unwritable db — and a failed kill never fails the delete', async () => {
  const broken = await apps(brokenDb()).deleteApp('x');
  assert.equal(broken.ok, false);
  assert.equal(broken.errorCode, 'database_error');
  const db = freshDb();
  const failingKill = apps(db, USERNAME, async () => false);
  const app = (await failingKill.saveApp('doomed')).data;
  const w = new Workspaces({
    db, username: () => USERNAME, killSession: async () => false, defaultCwd: os.tmpdir(),
    spawnSession: async name => ({ ok: true, resultType: 'tmux_session', data: { name } }),
  });
  const ws = (await w.saveWorkspace({ appId: app.id, name: 'x' })).data;
  await w.newTerminal(ws.id, undefined);
  const still = await failingKill.deleteApp('doomed');
  assert.equal(still.ok, true, still.errorMessage); // kill failure is logged, not surfaced
  assert.equal(appRow(db, 'doomed'), undefined);
});

// task/ws-jobs (plan §9): the app picker's read — list_apps.

test('list_apps: all apps ordered by sort_order then name, database_error when the db cannot open', async () => {
  const a = apps(freshDb());
  const b = (await a.saveApp('Beta')).data;
  const c = (await a.saveApp('Coda')).data;
  const first = (await a.saveApp('Alpha')).data;
  const listed = a.listApps();
  assert.equal(listed.ok, true);
  // save_app allocates order by insertion; the read is by (order, name).
  assert.deepEqual(listed.data.apps.map(x => [x.id, x.name, x.slug, x.order]),
    [[b.id, 'Beta', 'beta', 10], [c.id, 'Coda', 'coda', 20], [first.id, 'Alpha', 'alpha', 30]]);

  const empty = apps(freshDb()).listApps();
  assert.deepEqual(empty.data.apps, []);

  const broken = apps(brokenDb()).listApps();
  assert.equal(broken.ok, false);
  assert.equal(broken.errorCode, 'database_error');
});
