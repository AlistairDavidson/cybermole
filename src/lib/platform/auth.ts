// Single-user login: a salted scrypt hash and sha256-hashed session tokens in
// the state db, so restarts keep sessions and a copied db holds no usable
// token. A token dies after 7 days idle or 30 days from login, whichever
// comes first. Fails closed with no credential or on any db error. Changing
// the password revokes every session.
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
/** Renewal writes are throttled to this, so the 15 s polls don't each write. */
const RENEW_WRITE_MS = 60 * 1000;

interface Cred {
  username: string;
  salt: string;
  hash: string;
}

/** Injectable for unit tests; production uses the constants. */
export interface SessionTtls {
  idleMs?: number;
  absoluteMs?: number;
  /** tests pass 0 for exact slides */
  renewWriteMs?: number;
}

interface SessionRow {
  /** login time, ms epoch */
  created_at: number;
  /** sliding expiry, ms epoch */
  expires_at: number;
  /** last Set-Cookie that re-armed the browser's Max-Age */
  cookie_at: number;
}

export type NewSessionErrorCode = 'database_error';
export type NewSessionSuccess = ResultSuccess<'new_session', { token: SessionToken }>;
export type NewSessionFailure = ResultFailure<
  'new_session',
  { token: SessionToken },
  NewSessionErrorCode
>;

/** database_error: fail closed without claiming the session ended (503, not 401). */
export type SessionCheckErrorCode = 'no_session' | 'database_error';
export type SessionCheckData = { token: SessionToken };
export type SessionCheckSuccess = ResultSuccess<'session_check', SessionCheckData>;
export type SessionCheckFailure = ResultFailure<
  'session_check',
  SessionCheckData,
  SessionCheckErrorCode
>;
export type SessionCheckResult = SessionCheckSuccess | SessionCheckFailure;

/** invalid_credentials also covers "no credential set". database_error is
 *  a 503, never a 401, so a db hiccup can't count toward a fail2ban ban. */
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

/** The raw token never touches disk. */
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

  configured() {
    const cred = this.readCred();
    if (!cred.ok) return cred;
    return {
      ok: true,
      resultType: 'database_read',
      data: { value: cred.data.value !== null },
    } satisfies DatabaseReadSuccess<boolean>;
  }

  /** For created_by/updated_by; null when no credential is set. */
  username() {
    const cred = this.readCred();
    if (!cred.ok) return cred;
    return {
      ok: true,
      resultType: 'database_read',
      data: { value: cred.data.value?.username ?? null },
    } satisfies DatabaseReadSuccess<string | null>;
  }

  /** Read per attempt, so a credential set after boot works without a
   *  restart. An unreadable db is database_error, not "unset". */
  private readCred() {
    return databaseRead('could not read the credential', (): Cred | null => {
      const row = this.state.get(
        qb.selectFrom('credential').select(['username', 'salt', 'hash']).where('id', '=', 1),
      );
      // A hand-edited db can hold a blob despite TEXT NOT NULL: treat as unset.
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

  /** Async scrypt keeps the event loop free. The hash runs even for a wrong
   *  username so timing doesn't reveal which was wrong. */
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

  /** Also purges dead rows so the table stays bounded. */
  newSession() {
    const token = asSessionToken(crypto.randomBytes(32).toString('hex'));
    const now = Date.now();
    const saved = databaseUpdate('could not start a session', () => {
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

  /** An unreadable store is database_error, never "unknown" (which would sign people out). */
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

  private dead(s: SessionRow, now: number): boolean {
    return s.expires_at < now || s.created_at + this.absoluteMs <= now;
  }

  /** Slides the idle expiry, bounded by the absolute cap. */
  valid(token: SessionToken | undefined) {
    if (!token) return noSession();
    const found = this.row(token);
    if (!found.ok) return sessionStoreFailure(found.errorMessage);
    const s = found.data.value;
    if (!s) return noSession();
    const now = Date.now();
    if (this.dead(s, now)) {
      this.drop(token);
      return noSession();
    }
    const exp = now + this.idleMs;
    if (exp - s.expires_at >= this.renewWriteMs) {
      // A failed renewal just keeps the previous expiry; the next request retries.
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

  /** A failed delete is reported: the caller must not claim the session ended. */
  drop(token: SessionToken | undefined) {
    return databaseUpdate('could not end the session', () =>
      token
        ? this.state.run(qb.deleteFrom('auth_sessions').where('token_hash', '=', tokenHash(token)))
        : { changes: 0 },
    );
  }

  /** Like valid() but never renews: WS traffic must not slide a token.
   *  Read-only; used by the WS liveness sweeps. */
  alive(token: SessionToken | undefined) {
    if (!token) return noSession();
    const found = this.row(token);
    if (!found.ok) return sessionStoreFailure(found.errorMessage);
    const s = found.data.value;
    if (!s || this.dead(s, Date.now())) return noSession();
    return sessionFound(token);
  }

  dropAll() {
    return databaseUpdate('could not end the sessions', () =>
      this.state.run(qb.deleteFrom('auth_sessions')),
    );
  }

  /** A Set-Cookie re-arming the browser's Max-Age, or null when not due.
   *  The server slides the token but the cookie's Max-Age is fixed at
   *  login, so without this the browser would drop an actively used
   *  cookie. Called from the /api/state poll; re-arms once half the idle
   *  window has passed since the last one. */
  cookieRefresh(token: SessionToken | undefined, path = '/'): string | null {
    if (!token) return null;
    // Opportunistic: any failure just sends no header this poll.
    const found = this.row(token);
    if (!found.ok) return null;
    const s = found.data.value;
    if (!s) return null;
    const now = Date.now();
    if (this.dead(s, now)) return null;
    if (now - s.cookie_at < this.idleMs / 2) return null;
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

  /** The one place a cookie value becomes a SessionToken (not necessarily valid). */
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

/** Per-IP fixed-window limiter, in memory. */
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
      if (b) this.buckets.delete(ip); // re-insert keeps Map order oldest-first
      b = { count: 0, reset: now + this.windowMs };
      this.buckets.set(ip, b);
      if (this.buckets.size > this.cap) this.evict(now);
    }
    if (b.count >= this.max) return false;
    b.count++;
    return true;
  }
  /** Drop expired windows, then the oldest. Never a bulk clear: that would
   *  give every limited IP a fresh budget. */
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

/** Revokes every session in the same transaction; open terminals close on
 *  the next liveness sweep (≤ 30 s). */
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
      // Some sqlite errors already ended the transaction; don't let ROLLBACK mask the real error.
      try {
        db.exec('ROLLBACK');
      } catch {
        /* no transaction left */
      }
      throw err;
    }
  });
}
