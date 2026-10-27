// apps.ts: every Result family at every error code, plus the slug rules.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { StateDb, qb } from '../../dist-server/src/lib/platform/db.js';
import { Apps } from '../../dist-server/src/lib/apps/apps.js';
import { Workspaces } from '../../dist-server/src/lib/terminals/workspaces.js';
import { terminalSessionName } from '../../dist-server/src/lib/terminals/tmux.js';
import {
  APP_SLUG_RE,
  UUID_RE,
  normalizeSlug,
} from '../../dist-server/packages/app-kit/src/schemas/patterns.js';
import { AppIdSchema, AppSlugSchema } from '../../dist-server/packages/app-kit/src/schemas/ids.js';

const USERNAME = { ok: true, resultType: 'database_read', data: { value: 'tester' } };
const USERNAME_FAIL = {
  ok: false,
  resultType: 'database_read',
  errorCode: 'database_error',
  errorMessage: 'could not read the credential',
};

function freshDb() {
  return new StateDb(
    path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cybermole-apps-')), 'cybermole.db'),
  );
}

/** Its parent is a regular file, so every read and write is database_error. */
function brokenDb() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cybermole-apps-')), 'not-a-dir');
  fs.writeFileSync(file, '');
  return new StateDb(path.join(file, 'cybermole.db'));
}

function recorder() {
  const killed = [];
  return { killed, killSession: async name => (killed.push(name), true) };
}

function apps(db, username = USERNAME, killSession = async () => true) {
  return new Apps({ db, username: () => username, killSession });
}

const appRow = (db, slug) =>
  db.get(
    qb
      .selectFrom('apps')
      .select(['id', 'name', 'slug', 'cwd', 'icon', 'sort_order', 'created_by', 'updated_by'])
      .where('slug', '=', slug),
  );
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

test("normalizeSlug's output always satisfies APP_SLUG_RE or is empty", () => {
  for (const raw of [
    'A',
    '9lives',
    'My App!',
    'a_b',
    '  x  ',
    'ümlaut app',
    'x'.repeat(80),
    '-x-',
    '42',
  ]) {
    const slug = normalizeSlug(raw);
    assert.ok(slug === '' || APP_SLUG_RE.test(slug), `${raw} → ${slug}`);
  }
});

test('APP_SLUG_RE: lowercase start, then lowercase/digits/dashes, up to 40; UUID_RE: lowercase v4 pinned', () => {
  for (const good of ['a', 'my-app', 'a'.repeat(40), '9lives', 'a-1'])
    assert.equal(APP_SLUG_RE.test(good), true, good);
  for (const bad of ['', 'A', '-a', '_a', 'a_b', 'a'.repeat(41), 'a B', 'ä']) {
    assert.equal(APP_SLUG_RE.test(bad), false, bad);
  }
  const v4 = '123e4567-e89b-42d3-a456-426614174000';
  assert.equal(UUID_RE.test(v4), true);
  assert.equal(UUID_RE.test('123e4567-e89b-72d3-a456-426614174000'), false); // v7: version nibble
  assert.equal(UUID_RE.test(v4.toUpperCase()), false); // lowercase only
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
  for (const bad of [
    '',
    'nope',
    id.toUpperCase(),
    '123e4567-e89b-72d3-a456-426614174000',
    5,
    null,
  ]) {
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
  assert.deepEqual(first.data.cwd, null); // no cwd given — the server default applies
  assert.match(first.data.id, UUID_RE);
  const row = appRow(db, 'my-app');
  assert.equal(row.sort_order, 10);
  assert.equal(row.created_by, 'tester');
  assert.equal(row.updated_by, 'tester');
  const second = await a.saveApp('another');
  assert.equal(appRow(db, 'another').sort_order, 20);
  assert.equal(second.data.slug, 'another');
});

test('save_app: optional cwd — stored + returned; empty/whitespace = unset', async () => {
  const db = freshDb();
  const a = apps(db);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cybermole-app-cwd-'));
  const made = await a.saveApp('placed', dir);
  assert.equal(made.ok, true, made.errorMessage);
  assert.equal(made.data.cwd, dir);
  const row = appRow(db, 'placed');
  assert.equal(row.cwd, dir);
  // empty or whitespace reads as unset (an empty wa-input)
  for (const empty of ['', '   ']) {
    const unset = await a.saveApp(`no-dir-${empty.length}`, empty);
    assert.equal(unset.ok, true, unset.errorMessage);
    assert.equal(unset.data.cwd, null, JSON.stringify(empty));
  }
  assert.equal(appRow(db, 'no-dir-0').cwd, null);
});

test('save_app: a missing cwd is created, nested parents included', async () => {
  const db = freshDb();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cybermole-app-new-'));
  const dir = path.join(root, 'nested', 'tree');
  const made = await apps(db).saveApp('fresh', dir);
  assert.equal(made.ok, true, made.errorMessage);
  assert.equal(made.data.cwd, dir);
  assert.equal(fs.statSync(dir).isDirectory(), true);
});

test('save_app: icon — an absent one is suggested from the name, a given one must be registered', async () => {
  const db = freshDb();
  const a = apps(db);
  // absent → the shared suggestion rule (app-icons.ts)
  const noted = await a.saveApp('Notes Standup');
  assert.equal(noted.ok, true, noted.errorMessage);
  assert.equal(noted.data.icon, 'file-lines');
  assert.equal(appRow(db, 'notes-standup').icon, 'file-lines');
  // explicit
  const made = await a.saveApp('Explicit', undefined, 'robot');
  assert.equal(made.ok, true, made.errorMessage);
  assert.equal(made.data.icon, 'robot');
  assert.equal(appRow(db, 'explicit').icon, 'robot');
  // unknown names are refused, nothing written
  for (const bad of ['nope', '', '  ', 'CUBES']) {
    const r = await a.saveApp(`icon-bad-${bad.length}${bad.trim().length}`, undefined, bad);
    assert.equal(r.errorCode, 'invalid_icon', JSON.stringify(bad));
    assert.match(r.errorMessage, /cubes/);
  }
  assert.equal(rows(db, 'apps').length, 2, 'only the two good saves landed');
  // a NULL row (pre-v8) reads as the default in state
  db.run(
    qb.insertInto('apps').values({
      id: '123e4567-e89b-42d3-a456-426614174010',
      name: 'Legacy',
      slug: 'legacy',
      cwd: null,
      icon: null,
      sort_order: 100,
      created_at: 1,
      updated_at: 1,
      created_by: 't',
      updated_by: 't',
    }),
  );
  const listed = a.listApps();
  assert.equal(listed.ok, true);
  assert.equal(listed.data.apps.find(x => x.slug === 'legacy')?.icon, 'cubes');
});

test('save_app: a rejected save creates no directory', async () => {
  const a = apps(freshDb());
  assert.equal((await a.saveApp('taken')).ok, true);
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cybermole-app-dup-')), 'tree');
  assert.equal((await a.saveApp('Taken!', dir)).errorCode, 'duplicate_slug');
  assert.equal(fs.existsSync(dir), false);
});

test('save_app: invalid_cwd — relative, a file, under a file; database_error paths unchanged', async () => {
  const a = apps(freshDb());
  const file = path.join(os.tmpdir(), `cybermole-app-file-${process.pid}`);
  fs.writeFileSync(file, '');
  for (const cwd of ['relative/path', file, path.join(file, 'sub')]) {
    const r = await a.saveApp('x', cwd);
    assert.equal(r.ok, false, cwd);
    assert.equal(r.resultType, 'save_app');
    assert.equal(r.errorCode, 'invalid_cwd', cwd);
    assert.ok(r.errorMessage.includes(cwd), cwd);
  }
  assert.equal((await a.saveApp('x', '   ')).errorCode !== 'invalid_cwd', true); // emptiness is unset, not invalid
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

// ---------- rename (save_app's second entry point) ----------

test('rename: changes the display name, never the slug; absent fields are a no-op read-back', async () => {
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
  assert.deepEqual(noop.data, {
    id: renamed.data.id,
    name: 'New Name',
    slug: 'old-name',
    cwd: null,
    icon: 'cubes',
  });
});

test('rename: invalid_name on an empty name; app_not_found on a slug that does not resolve', async () => {
  const a = apps(freshDb());
  const { slug } = (await a.saveApp('x')).data;
  assert.equal((await a.renameApp(slug, '  ')).errorCode, 'invalid_name');
  assert.equal((await a.renameApp('missing', 'y')).errorCode, 'app_not_found');
  assert.equal((await a.renameApp('missing', 'y')).resultType, 'save_app');
});

test('rename: the cwd patch — a string sets it (validated), absent keeps, null clears back to unset', async () => {
  const db = freshDb();
  const a = apps(db);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cybermole-app-cwd-'));
  const { slug } = (await a.saveApp('placed')).data;
  assert.equal(appRow(db, slug).cwd, null);
  // set
  const set = await a.renameApp(slug, undefined, dir);
  assert.equal(set.ok, true, set.errorMessage);
  assert.equal(set.data.cwd, dir);
  assert.equal(appRow(db, slug).cwd, dir);
  // absent keeps, also alongside a name change
  const kept = await a.renameApp(slug, 'Renamed', undefined);
  assert.equal(kept.ok, true, kept.errorMessage);
  assert.equal(kept.data.name, 'Renamed');
  assert.equal(kept.data.cwd, dir);
  // null clears
  const cleared = await a.renameApp(slug, undefined, null);
  assert.equal(cleared.ok, true, cleared.errorMessage);
  assert.equal(cleared.data.cwd, null);
  assert.equal(appRow(db, slug).cwd, null);
  // a string gets the workspace cwd rule
  const file = path.join(os.tmpdir(), `cybermole-app-file-${process.pid}`);
  fs.writeFileSync(file, '');
  for (const bad of ['relative/path', '/definitely/not/here', file, '  ']) {
    const r = await a.renameApp(slug, undefined, bad);
    assert.equal(r.ok, false, bad);
    assert.equal(r.errorCode, 'invalid_cwd', bad);
  }
  assert.equal((await a.renameApp('missing', undefined, dir)).errorCode, 'app_not_found');
  const broken = await apps(brokenDb()).renameApp('x', undefined, dir);
  assert.equal(broken.errorCode, 'database_error');
});

// ---------- delete_app ----------

test("delete_app: cascades workspaces and terminals, un-tags jobs, best-effort-kills the terminals' sessions", async () => {
  const db = freshDb();
  const { killed, killSession } = recorder();
  const a = apps(db, USERNAME, killSession);
  const w = new Workspaces({
    db,
    username: () => USERNAME,
    killSession,
    defaultCwd: os.tmpdir(),
    spawnSession: async name => ({
      ok: true,
      resultType: 'tmux_session',
      data: { name },
    }),
    shellCommand: () => ({ ok: true, resultType: 'database_read', data: { value: 'sh -l' } }),
    agentCommand: () => ({ ok: true, resultType: 'database_read', data: { value: 'agent' } }),
  });
  const app = (await a.saveApp('gone')).data;
  const ws = (await w.saveWorkspace({ appId: app.id, name: 'under it' })).data;
  const t1 = (await w.newTerminal(ws.id, 'one')).data;
  const t2 = (await w.newTerminal(ws.id, undefined)).data;
  const consoleWs = (await w.saveWorkspace({ name: 'console one' })).data;
  const consoleTerm = (await w.newTerminal(consoleWs.id, undefined)).data;
  // a job tagged with the app
  db.run(
    qb.insertInto('jobs').values({
      name: 'nightly',
      schedule: '* * * * *',
      command: 'true',
      created_at: 1,
      app_id: app.id,
    }),
  );

  // the auto-opened tabs, captured before the delete
  const appAuto = db.get(qb.selectFrom('terminals').select('id').where('workspace_id', '=', ws.id));
  const consoleAuto = db.get(
    qb.selectFrom('terminals').select('id').where('workspace_id', '=', consoleWs.id),
  );

  const deleted = await a.deleteApp('gone');
  assert.equal(deleted.ok, true, deleted.errorMessage);
  assert.equal(deleted.resultType, 'delete_app');
  assert.deepEqual(deleted.data, { id: app.id });
  // The cascade takes the app's workspace and terminals; the console
  // workspace keeps both its tabs.
  assert.equal(appRow(db, 'gone'), undefined);
  assert.deepEqual(
    rows(db, 'workspaces').map(r => r.id),
    [consoleWs.id],
  );
  assert.deepEqual(
    rows(db, 'terminals')
      .map(r => r.id)
      .sort(),
    [consoleAuto.id, consoleTerm.id].sort(),
  );
  // Jobs are un-tagged, never deleted. (Spread: node:sqlite rows have a null
  // prototype, which deepEqual treats as different.)
  const job = db.get(
    qb.selectFrom('jobs').select(['name', 'app_id']).where('name', '=', 'nightly'),
  );
  assert.deepEqual({ ...job }, { name: 'nightly', app_id: null });
  // Exactly the deleted terminals' sessions were killed, the auto-opened tab included.
  assert.deepEqual(
    killed.sort(),
    [
      terminalSessionName(t1.id),
      terminalSessionName(t2.id),
      terminalSessionName(appAuto.id),
    ].sort(),
  );
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
    db,
    username: () => USERNAME,
    killSession: async () => false,
    defaultCwd: os.tmpdir(),
    spawnSession: async name => ({ ok: true, resultType: 'tmux_session', data: { name } }),
    shellCommand: () => ({ ok: true, resultType: 'database_read', data: { value: 'sh -l' } }),
    agentCommand: () => ({ ok: true, resultType: 'database_read', data: { value: 'agent' } }),
  });
  const ws = (await w.saveWorkspace({ appId: app.id, name: 'x' })).data;
  await w.newTerminal(ws.id, undefined);
  const still = await failingKill.deleteApp('doomed');
  assert.equal(still.ok, true, still.errorMessage); // kill failure is logged, not surfaced
  assert.equal(appRow(db, 'doomed'), undefined);
});

// ---------- listApps ----------

test('list_apps: every app, sort_order asc (+ created_at tiebreak); empty; database_error on a broken db', async () => {
  const db = freshDb();
  const a = apps(db);
  const b = (await a.saveApp('beta app')).data;
  const c = (await a.saveApp('alpha app')).data;
  const d = (await a.saveApp('gamma')).data;
  const listed = a.listApps();
  assert.equal(listed.ok, true, listed.errorMessage);
  assert.equal(listed.resultType, 'list_apps');
  // ordered by (order, created_at)
  assert.deepEqual(
    listed.data.apps.map(x => [x.id, x.name, x.slug, x.cwd, x.order]),
    [
      [b.id, 'beta app', 'beta-app', null, 10],
      [c.id, 'alpha app', 'alpha-app', null, 20],
      [d.id, 'gamma', 'gamma', null, 30],
    ],
  );
  for (const app of listed.data.apps) assert.match(app.id, UUID_RE);
  // the read carries the app cwd
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cybermole-app-cwd-'));
  const e = (await a.saveApp('with dir', dir)).data;
  assert.deepEqual(a.listApps().data.apps.at(-1), {
    id: e.id,
    name: 'with dir',
    slug: 'with-dir',
    cwd: dir,
    icon: 'cubes',
    order: 40,
  });
  assert.equal(a.listApps().data.apps.length, 4); // stable across calls

  const empty = apps(freshDb()).listApps();
  assert.deepEqual(empty.data.apps, []);

  const broken = apps(brokenDb()).listApps();
  assert.equal(broken.ok, false);
  assert.equal(broken.errorCode, 'database_error');
});

// ---------- reorderApps ----------

const appOrder = db =>
  db.all(
    qb.selectFrom('apps').select(['id', 'slug', 'sort_order', 'updated_at']).orderBy('sort_order'),
  );

test('reorder_apps: rewrites sort_order in steps of 10; a same-order call writes nothing', async () => {
  const db = freshDb();
  const a = apps(db);
  const one = (await a.saveApp('one')).data;
  const two = (await a.saveApp('two')).data;
  const three = (await a.saveApp('three')).data;
  assert.deepEqual(
    appOrder(db).map(r => r.slug),
    ['one', 'two', 'three'],
  );

  const r = await a.reorderApps([three.id, one.id, two.id]);
  assert.equal(r.ok, true, r.errorMessage);
  assert.equal(r.resultType, 'reorder_apps');
  assert.deepEqual(r.data, { order: [three.id, one.id, two.id] });
  assert.deepEqual(
    appOrder(db).map(x => [x.slug, x.sort_order]),
    [
      ['three', 10],
      ['one', 20],
      ['two', 30],
    ],
  );
  // the list read carries the new order
  assert.deepEqual(
    a.listApps().data.apps.map(x => x.slug),
    ['three', 'one', 'two'],
  );

  // A same-order reorder is a no-op success (updated_at untouched).
  const before = appOrder(db).find(x => x.slug === 'three').updated_at;
  await new Promise(resolve => setTimeout(resolve, 2));
  const again = await a.reorderApps([three.id, one.id, two.id]);
  assert.equal(again.ok, true, again.errorMessage);
  assert.equal(appOrder(db).find(x => x.slug === 'three').updated_at, before);
});

test('reorder_apps: invalid_order on a duplicate, an unknown id, a partial list or an empty one; the db is untouched', async () => {
  const db = freshDb();
  const a = apps(db);
  const one = (await a.saveApp('one')).data;
  const two = (await a.saveApp('two')).data;
  const MISSING_APP = '99999999-9999-4999-8999-999999999999';

  for (const order of [[one.id, one.id], [one.id], [one.id, two.id, MISSING_APP], []]) {
    const r = await a.reorderApps(order);
    assert.equal(r.ok, false, JSON.stringify(order));
    assert.equal(r.errorCode, 'invalid_order');
    assert.equal(r.resultType, 'reorder_apps');
  }
  assert.deepEqual(
    appOrder(db).map(x => [x.slug, x.sort_order]),
    [
      ['one', 10],
      ['two', 20],
    ],
    'a refused reorder writes nothing',
  );
  assert.equal((await apps(brokenDb()).reorderApps([one.id])).errorCode, 'database_error');
});
