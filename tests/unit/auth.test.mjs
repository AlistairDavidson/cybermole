// auth.ts's session model: the idle and absolute expiry clocks, the
// cookie-refresh decision, and persistence (hashed tokens survive a new Auth
// on the same db; a password change revokes them). Mock timers drive
// Date.now; TTLs are constructor-injected for this.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Auth, setCredential } from '../../dist-server/src/lib/platform/auth.js';
import { StateDb } from '../../dist-server/src/lib/platform/db.js';

function freshDb() {
  return new StateDb(
    path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cybermole-auth-unit-')), 'cybermole.db'),
  );
}

function login(auth) {
  const r = auth.newSession();
  assert.equal(r.ok, true, r.errorMessage);
  return r.data.token;
}

test('alive() reports liveness but never slides — the WS sweep’s peek', t => {
  t.mock.timers.enable({ now: 0 });
  const auth = new Auth(freshDb(), { idleMs: 1000, absoluteMs: 100_000, renewWriteMs: 0 });
  const tok = login(auth);
  assert.equal(auth.alive(tok).ok, true); // live
  assert.equal(auth.alive('nope').ok, false); // unknown
  // Peeking through the whole idle window must not renew: the WS sweep can
  // never extend a terminal's life.
  t.mock.timers.setTime(999);
  assert.equal(auth.alive(tok).ok, true); // last moment of the window
  t.mock.timers.setTime(1001);
  assert.equal(auth.alive(tok).ok, false); // dead (exp < now) — no slide from alive()
  // the peek doesn't delete (valid() cleans up)
  assert.equal(auth.valid(tok).ok, false);
  // dropAll ends every token at once
  const a = login(auth);
  const b = login(auth);
  assert.equal(auth.dropAll().ok, true);
  assert.equal(auth.alive(a).ok, false);
  assert.equal(auth.alive(b).ok, false);
});

test('valid() slides the idle window on use', t => {
  t.mock.timers.enable({ now: 0 });
  const auth = new Auth(freshDb(), { idleMs: 1000, absoluteMs: 100_000, renewWriteMs: 0 });
  const tok = login(auth);
  t.mock.timers.setTime(999);
  assert.equal(auth.valid(tok).ok, true); // inside the first window
  t.mock.timers.setTime(1998);
  assert.equal(auth.valid(tok).ok, true); // renewed at 999 → exp 1999
  t.mock.timers.setTime(2998);
  assert.equal(auth.valid(tok).ok, true); // renewed at 1998 → exp 2998
  t.mock.timers.setTime(3999);
  assert.equal(auth.valid(tok).ok, false); // 1001 ms idle since the last renewal
  t.mock.timers.setTime(4000);
  assert.equal(auth.valid(tok).ok, false); // stays dead once rejected
});

test('valid() throttles renewal writes: the expiry only moves once it would move by renewWriteMs', t => {
  t.mock.timers.enable({ now: 0 });
  const db = freshDb();
  const auth = new Auth(db, { idleMs: 10_000, absoluteMs: 100_000, renewWriteMs: 1000 });
  const tok = login(auth);
  const expiry = () => db.db().prepare('SELECT expires_at AS e FROM auth_sessions').get().e;
  assert.equal(expiry(), 10_000);
  t.mock.timers.setTime(500);
  assert.equal(auth.valid(tok).ok, true);
  assert.equal(expiry(), 10_000); // would move 500 ms — no write
  t.mock.timers.setTime(1000);
  assert.equal(auth.valid(tok).ok, true);
  assert.equal(expiry(), 11_000); // moves 1000 ms — written
});

test('the absolute cap kills a constantly-renewed token at created+absoluteMs', t => {
  t.mock.timers.enable({ now: 0 });
  const auth = new Auth(freshDb(), { idleMs: 1000, absoluteMs: 2000, renewWriteMs: 0 });
  const tok = login(auth);
  t.mock.timers.setTime(900);
  assert.equal(auth.valid(tok).ok, true); // exp → 1900
  t.mock.timers.setTime(1800);
  assert.equal(auth.valid(tok).ok, true); // exp → 2800, still under the cap
  t.mock.timers.setTime(1900);
  assert.equal(auth.valid(tok).ok, true); // exp → 2900, would slide forever…
  t.mock.timers.setTime(2000);
  assert.equal(auth.valid(tok).ok, false); // …except created(0) + 2000 <= now
  t.mock.timers.setTime(2100);
  assert.equal(auth.valid(tok).ok, false);
});

test('newSession() purges sessions dead on either clock', t => {
  t.mock.timers.enable({ now: 0 });
  const db = freshDb();
  const auth = new Auth(db, { idleMs: 1000, absoluteMs: 2000, renewWriteMs: 0 });
  const idle = login(auth);
  const kept = login(auth);
  t.mock.timers.setTime(500);
  assert.equal(auth.valid(kept).ok, true); // exp → 1500
  t.mock.timers.setTime(1000);
  assert.equal(auth.valid(kept).ok, true); // exp → 2000 (renewed under it)
  t.mock.timers.setTime(1501); // `idle` is idle-expired; `kept` was
  const fresh = login(auth); // renewed at 1000 → dead-purge keeps it
  assert.equal(
    db.db().prepare('SELECT COUNT(*) AS n FROM auth_sessions').get().n,
    2,
    'the dead row was purged',
  );
  assert.equal(auth.valid(idle).ok, false);
  assert.equal(auth.valid(kept).ok, true);
  assert.equal(auth.valid(fresh).ok, true);
});

test('cookieRefresh() re-arms the Max-Age only after half the idle window', t => {
  t.mock.timers.enable({ now: 0 });
  const auth = new Auth(freshDb(), { idleMs: 1000, absoluteMs: 10_000, renewWriteMs: 0 });
  const tok = login(auth); // login sent the cookie (cookie_at 0)
  assert.equal(auth.cookieRefresh(tok), null); // fresh — no header yet
  t.mock.timers.setTime(499);
  assert.equal(auth.valid(tok).ok, true);
  assert.equal(auth.cookieRefresh(tok), null); // under half the window
  t.mock.timers.setTime(501);
  assert.equal(auth.valid(tok).ok, true);
  const header = auth.cookieRefresh(tok);
  assert.match(header, /^cybermole_session=/);
  assert.match(header, /Max-Age=1\b/); // idleMs, in seconds
  assert.match(header, /SameSite=Strict/);
  t.mock.timers.setTime(700);
  assert.equal(auth.cookieRefresh(tok), null); // just re-armed at 501
  t.mock.timers.setTime(1202);
  assert.equal(auth.valid(tok).ok, true);
  assert.ok(auth.cookieRefresh(tok)); // 701 ms since cookie_at 501
});

test('cookieRefresh() never answers for unknown or dead tokens', t => {
  t.mock.timers.enable({ now: 0 });
  const auth = new Auth(freshDb(), { idleMs: 1000, absoluteMs: 2000, renewWriteMs: 0 });
  assert.equal(auth.cookieRefresh('no-such-token'), null);
  assert.equal(auth.cookieRefresh(undefined), null);
  const tok = login(auth);
  t.mock.timers.setTime(3000); // past the absolute cap
  assert.equal(auth.valid(tok).ok, false);
  assert.equal(auth.cookieRefresh(tok), null);
});

test('drop() and dropAll() end tokens immediately', t => {
  t.mock.timers.enable({ now: 0 });
  const auth = new Auth(freshDb(), { idleMs: 1000, absoluteMs: 100_000, renewWriteMs: 0 });
  const a = login(auth);
  const b = login(auth);
  assert.deepEqual(auth.drop(a), { ok: true, resultType: 'database_update', data: { changes: 1 } });
  assert.equal(auth.valid(a).ok, false);
  assert.equal(auth.valid(b).ok, true);
  assert.equal(auth.dropAll().ok, true);
  assert.equal(auth.valid(b).ok, false);
});

test('tokens survive a restart: a new Auth on the same db accepts them; drops reach across instances', () => {
  const db = freshDb();
  const before = new Auth(db);
  const tok = login(before);
  const other = login(before);
  const after = new Auth(new StateDb(db.file)); // a fresh process: new connection, nothing in memory
  assert.equal(after.valid(tok).ok, true);
  assert.equal(after.alive(other).ok, true);
  after.drop(tok);
  assert.equal(before.valid(tok).ok, false);
  after.dropAll();
  assert.equal(before.valid(other).ok, false);
});

test('the db holds sha256(token), never the token itself', () => {
  const db = freshDb();
  const tok = login(new Auth(db));
  const rows = db.db().prepare('SELECT token_hash FROM auth_sessions').all();
  assert.deepEqual(
    rows.map(r => r.token_hash),
    [crypto.createHash('sha256').update(tok).digest('hex')],
  );
  assert.equal(
    fs.readFileSync(db.file).includes(Buffer.from(tok)),
    false,
    'the raw token is not in the file',
  );
});

test('setCredential revokes every session; a revoked or unknown token is no_session', () => {
  const db = freshDb();
  const auth = new Auth(db);
  assert.deepEqual(auth.configured(), {
    ok: true,
    resultType: 'database_read',
    data: { value: false },
  });
  assert.equal(setCredential(db, 'u', 'password-one').ok, true);
  assert.equal(auth.configured().data.value, true);
  const tok = login(auth);
  assert.deepEqual(auth.valid(tok), {
    ok: true,
    resultType: 'session_check',
    data: { token: tok },
  });
  assert.equal(setCredential(db, 'u', 'password-two').ok, true); // a password change
  assert.equal(auth.valid(tok).errorCode, 'no_session');
  assert.equal(auth.alive(tok).errorCode, 'no_session');
  assert.equal(auth.valid(undefined).errorCode, 'no_session');
  assert.equal(auth.alive('no-such-token').errorCode, 'no_session');
});

test('verify: success, invalid_credentials (wrong password, wrong user, no credential yet)', async () => {
  const db = freshDb();
  const auth = new Auth(db);
  assert.equal((await auth.verify('u', 'password-one')).errorCode, 'invalid_credentials'); // nothing set
  assert.equal(setCredential(db, 'u', 'password-one').ok, true);
  assert.deepEqual(await auth.verify('u', 'password-one'), {
    ok: true,
    resultType: 'verify_login',
    data: { username: 'u' },
  });
  assert.equal((await auth.verify('u', 'wrong-password')).errorCode, 'invalid_credentials');
  assert.equal((await auth.verify('someone', 'password-one')).errorCode, 'invalid_credentials');
});

test('an unreadable db is database_error everywhere — never read as "no session" or a wrong password', async () => {
  // A db that can't open: everything fails closed as database_error (so
  // callers answer 503, not 401), and a login never mints a token it can't keep.
  const file = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'cybermole-auth-unit-')),
    'not-a-dir',
  );
  fs.writeFileSync(file, '');
  const state = new StateDb(path.join(file, 'cybermole.db'));
  const broken = new Auth(state);
  const tok = 'a'.repeat(64);
  for (const r of [broken.valid(tok), broken.alive(tok)]) {
    assert.equal(r.ok, false);
    assert.equal(r.resultType, 'session_check');
    assert.equal(r.errorCode, 'database_error');
    assert.match(r.errorMessage, /^could not read the session: /);
  }
  assert.equal(broken.cookieRefresh(tok), null);
  assert.equal(broken.configured().errorCode, 'database_error');
  const verified = await broken.verify('u', 'password-one');
  assert.equal(verified.errorCode, 'database_error');
  assert.match(verified.errorMessage, /^could not read the credential: /);
  const minted = broken.newSession();
  assert.equal(minted.ok, false);
  assert.equal(minted.errorCode, 'database_error');
  assert.equal(broken.drop(tok).errorCode, 'database_error');
  const saved = setCredential(state, 'u', 'password-one');
  assert.equal(saved.errorCode, 'database_error');
  assert.match(saved.errorMessage, /^could not save the credential: /);
});

test('setCredential rolls back: a failed session purge leaves the old credential in place', async () => {
  const db = freshDb();
  const auth = new Auth(db);
  assert.equal(setCredential(db, 'u', 'password-one').ok, true);
  db.db().prepare('DROP TABLE auth_sessions').run(); // the purge half now fails
  const saved = setCredential(db, 'u', 'password-two');
  assert.equal(saved.errorCode, 'database_error');
  assert.equal(
    (await auth.verify('u', 'password-one')).ok,
    true,
    'the credential write was rolled back',
  );
});
