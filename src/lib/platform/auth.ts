// auth.ts — single-user login: username + password,
// salted scrypt hash in the state db (src/lib/platform/db.ts), session tokens
// persisted there too — as sha256 hashes only (auth_sessions), so a
// restart doesn't sign everyone out and a copied db holds no usable
// token. Expiry is two clocks: a sliding idle window renewed on every
// authed request, plus an absolute cap from login — so a token dies after
// 7 days unused OR 30 days after it was issued, whichever comes first,
// even under constant use. No account machinery. Fails closed until a
// credential row exists (set it with `npm run set-password`), and fails
// closed on any db read error. Changing the password (setCredential)
// revokes every session.
import * as crypto from 'node:crypto';
import { qb, type StateDb } from './db';
import {
  asSessionToken,
  databaseRead,
  databaseUpdate,
  type DatabaseReadSuccess,
  type ResultFailure,
  type ResultSuccess,
  type SessionToken,
} from '@cybermole/app-kit';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000; // sliding: idle expiry
const SESSION_ABSOLUTE_MS = 30 * 24 * 3600 * 1000; // hard cap from login
/** valid() writes a renewed expiry only when it moves at least this far,
 *  so the 15 s polls and every asset GET don't each cost a db write. The
 *  idle window is therefore precise to within this (60 s of 7 days). */
const RENEW_WRITE_MS = 60 * 1000;

interface Cred {
  username: string;
  salt: string;
  hash: string;
}

/** Session lifetimes, injectable for the unit tests (tests/unit).
 *  Production always uses the constants above — no env knobs. */
export interface SessionTtls {
  /** sliding window: renewed on every authed request */
  idleMs?: number;
  /** absolute cap from login — bounds a stolen token under constant use */
  absoluteMs?: number;
  /** renewal-write throttle (RENEW_WRITE_MS); tests pass 0 for exact slides */
  renewWriteMs?: number;
}

/** One auth_sessions row (src/lib/platform/db.ts). */
interface SessionRow {
  /** login time (ms epoch) — the absolute clock's origin */
  created_at: number;
  /** sliding expiry (ms epoch) */
  expires_at: number;
  /** when a Set-Cookie last (re)armed the browser's Max-Age */
  cookie_at: number;
}

export type NewSessionErrorCode = 'database_error';
export type NewSessionSuccess = ResultSuccess<'new_session', { token: SessionToken }>;
export type NewSessionFailure = ResultFailure<
  'new_session',
  { token: SessionToken },
  NewSessionErrorCode
>;

/** no_session: no cookie, an unknown token, or one dead on either clock
 *  (401 / signed-out). database_error: the session store could not be
 *  read — the caller fails closed WITHOUT claiming the session ended (503
 *  on HTTP and WS upgrades; the WS liveness sweep re-checks next tick). */
export type SessionCheckErrorCode = 'no_session' | 'database_error';
export type SessionCheckData = { token: SessionToken };
export type SessionCheckSuccess = ResultSuccess<'session_check', SessionCheckData>;
export type SessionCheckFailure = ResultFailure<
  'session_check',
  SessionCheckData,
  SessionCheckErrorCode
>;
export type SessionCheckResult = SessionCheckSuccess | SessionCheckFailure;

/** invalid_credentials: wrong username or password, or no credential set
 *  yet — answered alike (401, which fail2ban counts). database_error: the
 *  credential could not be read (503 — never a 401, so a db hiccup can't
 *  count toward a ban). */
export type VerifyLoginErrorCode = 'invalid_credentials' | 'database_error';
export type VerifyLoginData = { username: string };
export type VerifyLoginSuccess = ResultSuccess<'verify_login', VerifyLoginData>;
export type VerifyLoginFailure = ResultFailure<
  'verify_login',
  VerifyLoginData,
  VerifyLoginErrorCode
>;
export type VerifyLoginResult = VerifyLoginSuccess | VerifyLoginFailure;

const noSession = () =>
  ({
    ok: false,
    resultType: 'session_check',
    errorCode: 'no_session',
    errorMessage: 'no such session',
  }) satisfies SessionCheckFailure;
const sessionStoreFailure = (errorMessage: string) =>
  ({
    ok: false,
    resultType: 'session_check',
    errorCode: 'database_error',
    errorMessage,
  }) satisfies SessionCheckFailure;
const sessionFound = (token: SessionToken) =>
  ({ ok: true, resultType: 'session_check', data: { token } }) satisfies SessionCheckSuccess;

/** What the db stores for a token: the raw token never touches disk. */
function tokenHash(token: SessionToken): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export class Auth {
  private readonly idleMs: number;
  private readonly absoluteMs: number;
  private readonly renewWriteMs: number;

  constructor(
    private state: StateDb,
    ttls: SessionTtls = {},
  ) {
    this.idleMs = ttls.idleMs ?? SESSION_TTL_MS;
    this.absoluteMs = ttls.absoluteMs ?? SESSION_ABSOLUTE_MS;
    this.renewWriteMs = ttls.renewWriteMs ?? RENEW_WRITE_MS;
  }

  /** Is a credential set? (database_read: value true/false.) */
  configured() {
    const cred = this.readCred();
    if (!cred.ok) return cred;
    return {
      ok: true,
      resultType: 'database_read',
      data: { value: cred.data.value !== null },
    } satisfies DatabaseReadSuccess<boolean>;
  }

  /** The credential row's username — created_by/updated_by for the
   *  app/workspace/terminal rows (single-user login; value null when no
   *  credential is set). Read per call, like readCred: a credential
   *  written after boot is picked up with no restart. */
  username() {
    const cred = this.readCred();
    if (!cred.ok) return cred;
    return {
      ok: true,
      resultType: 'database_read',
      data: { value: cred.data.value?.username ?? null },
    } satisfies DatabaseReadSuccess<string | null>;
  }

  /** Current credential row (value null when unset or malformed). Read
   *  per attempt, exactly like the old cred file: a credential written
   *  after boot (set-password, test fixtures) is picked up with no
   *  restart. An unreadable db is a database_error, not "unset" — callers
   *  fail closed without calling it a wrong password. */
  private readCred() {
    return databaseRead('could not read the credential', (): Cred | null => {
      const row = this.state.get(
        qb.selectFrom('credential').select(['username', 'salt', 'hash']).where('id', '=', 1),
      );
      // The columns are TEXT NOT NULL, but sqlite will still keep a blob
      // in one (a hand-edited db): that reads as malformed, i.e. unset.
      if (
        !row ||
        typeof row.username !== 'string' ||
        typeof row.salt !== 'string' ||
        typeof row.hash !== 'string'
      )
        return null;
      return { username: row.username, salt: row.salt, hash: row.hash };
    });
  }

  /** Async scrypt: the hash runs on the libuv threadpool, so login attempts
   *  never stall the event loop (and every attached terminal with it). The
   *  hash runs even when the username is wrong — skipping it would make a
   *  wrong username measurably faster than a wrong password. */
  async verify(username: string, password: string) {
    const data = { username };
    const read = this.readCred();
    if (!read.ok) {
      return {
        ok: false,
        resultType: 'verify_login',
        data,
        errorCode: 'database_error',
        errorMessage: read.errorMessage,
      } satisfies VerifyLoginFailure;
    }
    const invalid = {
      ok: false,
      resultType: 'verify_login',
      data,
      errorCode: 'invalid_credentials',
      errorMessage: 'invalid credentials',
    } satisfies VerifyLoginFailure;
    const cred = read.data.value;
    if (!cred) return invalid;
    const uBuf = Buffer.from(username, 'utf8');
    const uExpect = Buffer.from(cred.username, 'utf8');
    const uOk = uBuf.length === uExpect.length && crypto.timingSafeEqual(uBuf, uExpect);
    const expect = Buffer.from(cred.hash, 'hex');
    const got = await new Promise<Buffer>((resolve, reject) =>
      crypto.scrypt(password, Buffer.from(cred.salt, 'hex'), SCRYPT.keylen, SCRYPT, (err, key) =>
        err ? reject(err) : resolve(key),
      ),
    );
    const pOk = expect.length === got.length && crypto.timingSafeEqual(expect, got);
    if (!(uOk && pOk)) return invalid;
    return { ok: true, resultType: 'verify_login', data } satisfies VerifyLoginSuccess;
  }

  /** Mint a token for a fresh login and persist its hash; purges rows
   *  dead on either clock while at it (the table stays bounded). */
  newSession() {
    const token = asSessionToken(crypto.randomBytes(32).toString('hex'));
    const now = Date.now();
    const saved = databaseUpdate('could not start a session', () => {
      // dead() in SQL: idle-expired, or created_at + absoluteMs <= now.
      this.state.run(
        qb
          .deleteFrom('auth_sessions')
          .where(eb =>
            eb.or([eb('expires_at', '<', now), eb('created_at', '<=', now - this.absoluteMs)]),
          ),
      );
      return this.state.run(
        qb.insertInto('auth_sessions').values({
          token_hash: tokenHash(token),
          created_at: now,
          expires_at: now + this.idleMs,
          cookie_at: now,
        }),
      );
    });
    if (!saved.ok) {
      return {
        ok: false,
        resultType: 'new_session',
        errorCode: saved.errorCode,
        errorMessage: saved.errorMessage,
      } satisfies NewSessionFailure;
    }
    return { ok: true, resultType: 'new_session', data: { token } } satisfies NewSessionSuccess;
  }

  /** The token's row (value null when unknown). An unreadable session
   *  store is a database_error — never read as "unknown", which would
   *  sign people out over a db hiccup. */
  private row(token: SessionToken) {
    return databaseRead(
      'could not read the session',
      () =>
        this.state.get(
          qb
            .selectFrom('auth_sessions')
            .select(['created_at', 'expires_at', 'cookie_at'])
            .where('token_hash', '=', tokenHash(token)),
        ) ?? null,
    );
  }

  /** Expired on either clock — idle, or past the absolute cap from login. */
  private dead(s: SessionRow, now: number): boolean {
    return s.expires_at < now || s.created_at + this.absoluteMs <= now;
  }

  /** Validate a token; sliding renewal on use, bounded by the absolute cap. */
  valid(token: SessionToken | undefined) {
    if (!token) return noSession();
    const found = this.row(token);
    if (!found.ok) return sessionStoreFailure(found.errorMessage);
    const s = found.data.value;
    if (!s) return noSession();
    const now = Date.now();
    // The purge is best-effort: a dead token is rejected either way.
    if (this.dead(s, now)) {
      this.drop(token);
      return noSession();
    }
    const exp = now + this.idleMs;
    if (exp - s.expires_at >= this.renewWriteMs) {
      // A failed renewal write only means the token keeps its previous
      // expiry (it was valid a moment ago); the next request retries.
      databaseUpdate('could not renew the session', () =>
        this.state.run(
          qb
            .updateTable('auth_sessions')
            .set({ expires_at: exp })
            .where('token_hash', '=', tokenHash(token)),
        ),
      );
    }
    return sessionFound(token);
  }

  /** Sign one token out. A failed delete is reported: the caller must
   *  not claim the session ended. */
  drop(token: SessionToken | undefined) {
    return databaseUpdate('could not end the session', () =>
      token
        ? this.state.run(qb.deleteFrom('auth_sessions').where('token_hash', '=', tokenHash(token)))
        : { changes: 0 },
    );
  }

  /** Validity peek WITHOUT renewal — for liveness sweeps on established
   *  WS terminals. WS traffic must never slide a token (only authed HTTP
   *  does, via valid()), so this never extends life; it only reports it.
   *  A terminal whose token died on either clock — idle, the absolute
   *  cap, or a logout — is closed by the server's sweep instead of
   *  riding the WS keepalive forever. Pure peek: a read, never a write
   *  (the next authed HTTP touch or newSession purge does the deleting). */
  alive(token: SessionToken | undefined) {
    if (!token) return noSession();
    const found = this.row(token);
    if (!found.ok) return sessionStoreFailure(found.errorMessage);
    const s = found.data.value;
    if (!s || this.dead(s, Date.now())) return noSession();
    return sessionFound(token);
  }

  /** 'Log out everywhere': every token dies (their sockets are closed by
   *  the server route, which owns the connection tracking). */
  dropAll() {
    return databaseUpdate('could not end the sessions', () =>
      this.state.run(qb.deleteFrom('auth_sessions')),
    );
  }

  /** Set-Cookie re-arming the browser cookie's Max-Age, or null when not
   *  due. The server renews a token on every request but the browser's
   *  cookie is otherwise fixed at login, so the two clocks drift apart:
   *  actively used, the browser would forget the cookie after `idleMs`
   *  while the token lives on. Refreshing on every authed response would
   *  put a Set-Cookie on nearly everything; instead the /api/state poll
   *  (every open tab, 15 s) calls this and we only re-arm once half the
   *  idle window passed since the last Set-Cookie — at most one extra
   *  header per few days per token, and the cookie can never lag the
   *  server's sliding window by more than that half.
   *
   *  Precondition: only called from /api/state, which sits behind
   *  auth.valid()'s renewal — the token was just touched. A dead or
   *  unknown token answers null (no header) rather than a stale one. */
  cookieRefresh(token: SessionToken | undefined, path = '/'): string | null {
    if (!token) return null;
    // Can't fail by design: the re-arm is opportunistic, so any failure
    // (unknown token, unreadable store) just sends no header this poll.
    const found = this.row(token);
    if (!found.ok) return null;
    const s = found.data.value;
    if (!s) return null;
    const now = Date.now();
    if (this.dead(s, now)) return null;
    if (now - s.cookie_at < this.idleMs / 2) return null;
    // Re-arm only once the new cookie_at is recorded; a failed write sends
    // no header now and the next poll retries.
    const recorded = databaseUpdate('could not record the cookie refresh', () =>
      this.state.run(
        qb
          .updateTable('auth_sessions')
          .set({ cookie_at: now })
          .where('token_hash', '=', tokenHash(token)),
      ),
    );
    return recorded.ok ? this.cookieHeader(token, path) : null;
  }

  cookieHeader(token: SessionToken, path = '/'): string {
    return (
      `cybermole_session=${token}; HttpOnly; Secure; SameSite=Strict; ` +
      `Path=${path}; Max-Age=${Math.floor(this.idleMs / 1000)}`
    );
  }

  /** The session token a request carries (its cybermole_session cookie), as
   *  the brand the session APIs take — the one place a cookie value
   *  becomes a SessionToken. Whether it is VALID is valid()'s call. */
  static sessionToken(cookieHeader: string | undefined): SessionToken | undefined {
    const raw = Auth.parseCookies(cookieHeader).cybermole_session;
    return raw === undefined ? undefined : asSessionToken(raw);
  }

  static parseCookies(header: string | undefined): Record<string, string> {
    const out: Record<string, string> = {};
    if (!header) return out;
    for (const part of header.split(';')) {
      const i = part.indexOf('=');
      if (i > 0) out[part.slice(0, i).trim()!] = part.slice(i + 1).trim();
    }
    return out;
  }
}

/** Tiny per-IP fixed-window limiter. Counters live in memory. */
export class RateLimiter {
  private buckets = new Map<string, { count: number; reset: number }>();
  constructor(
    private max: number,
    private windowMs: number,
    private cap = 10000,
  ) {}
  allow(ip: string): boolean {
    const now = Date.now();
    let b = this.buckets.get(ip);
    if (!b || now > b.reset) {
      if (b) this.buckets.delete(ip); // re-insert: Map order stays oldest-window-first
      b = { count: 0, reset: now + this.windowMs };
      this.buckets.set(ip, b);
      if (this.buckets.size > this.cap) this.evict(now);
    }
    if (b.count >= this.max) return false;
    b.count++;
    return true;
  }
  /** Memory cap: drop expired windows, then the oldest ones. Never a bulk
   *  clear — that would hand every limited IP a fresh budget. */
  private evict(now: number): void {
    for (const [ip, b] of this.buckets) {
      if (this.buckets.size <= this.cap) return;
      if (now > b.reset) this.buckets.delete(ip);
    }
    for (const ip of this.buckets.keys()) {
      if (this.buckets.size <= this.cap) return;
      this.buckets.delete(ip);
    }
  }
}

/** Credential writer used by set-password (and the e2e fixtures). A new
 *  credential revokes every login session in the same transaction —
 *  whoever held the old password is signed out; open terminals close on
 *  the server's next liveness sweep (≤ 30 s). A db failure is a
 *  database_error (the set-password CLI prints it and exits non-zero);
 *  nothing is half-written. */
export function setCredential(state: StateDb, username: string, password: string) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, SCRYPT);
  return databaseUpdate('could not save the credential', () => {
    const db = state.db();
    db.exec('BEGIN IMMEDIATE');
    try {
      const written = state.run(
        qb
          .insertInto('credential')
          .values({
            id: 1,
            username,
            salt: salt.toString('hex'),
            hash: hash.toString('hex'),
            updated_at: Date.now(),
          })
          .onConflict(oc =>
            oc.column('id').doUpdateSet(eb => ({
              username: eb.ref('excluded.username'),
              salt: eb.ref('excluded.salt'),
              hash: eb.ref('excluded.hash'),
              updated_at: eb.ref('excluded.updated_at'),
            })),
          ),
      );
      state.run(qb.deleteFrom('auth_sessions'));
      db.exec('COMMIT');
      return written;
    } catch (err) {
      // Some sqlite errors already ended the transaction; a failing
      // ROLLBACK then must not mask the error that matters.
      try {
        db.exec('ROLLBACK');
      } catch {
        /* no transaction left */
      }
      throw err; // to databaseUpdate's boundary catch, as database_error
    }
  });
}
