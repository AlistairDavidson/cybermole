import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { envSchema, type EnvValue, type ServerEnvField } from './env-schema';
import type { EditorUpstream } from './editor';
import type { ObjectStoreConfig } from './storage';

/** Loki push config (src/lib/logger.ts) — or null when no URL is set: the
 *  logger then runs console-only, exactly as before this existed. */
export interface LokiConfig {
  /** base URL of the Loki push API, e.g. http://loki:3100 (no trailing slash) */
  url: string;
  /** the static `job` label every line carries (CYBERMOLE_LOKI_JOB, 'cybermole') */
  job: string;
}

export const APP_ROOT = path.join(__dirname, '..', '..', '..');
export const PI_BIN = path.join(APP_ROOT, 'node_modules', '.bin', 'pi');

type SchemaEnv = { -readonly [K in keyof typeof envSchema]: EnvValue<(typeof envSchema)[K]> };

function readSchemaEnv(): SchemaEnv {
  const out: Record<string, string | number | boolean | undefined> = {};
  for (const [key, field] of Object.entries(envSchema) as [string, ServerEnvField][]) {
    const raw = process.env[key];
    if (field.type === 'number') {
      // Fail at boot on a non-integer rather than run with NaN
      // (parseInt('abc') used to become a NaN listen port).
      const n = raw === undefined || raw.trim() === '' ? field.default : Number(raw);
      if (typeof n !== 'number' || !Number.isInteger(n)) {
        throw new Error(`${key}=${JSON.stringify(raw)} is not an integer`);
      }
      out[key] = n;
    } else if (field.type === 'boolean')
      out[key] = raw === 'true' ? true : raw === 'false' ? false : field.default;
    else out[key] = raw ?? field.default;
  }
  return out as SchemaEnv;
}

export const RAW_ENV: SchemaEnv = readSchemaEnv();

// task/job-log-caps (jobs-agent-plan §8): a negative byte cap is an
// operator mistake of the same class as the non-integers readSchemaEnv
// already stops the boot on — fail closed the same way, at module load.
if (RAW_ENV.CYBERMOLE_JOB_LOG_MAX < 0) {
  throw new Error(
    `CYBERMOLE_JOB_LOG_MAX=${RAW_ENV.CYBERMOLE_JOB_LOG_MAX} must not be negative (a byte count)`,
  );
}
export const PI_AGENT_DIR: string | undefined = process.env.PI_CODING_AGENT_DIR;
export const PI_SESSION_DIR: string | undefined = process.env.PI_CODING_AGENT_SESSION_DIR;

const home = RAW_ENV.CYBERMOLE_HOME ?? os.homedir();
// All cybermole state under one directory (DESIGN_REVIEW §3.3): XDG-style
// under HOME, so nothing defaults into the app root where a container
// image sync could overwrite it. CYBERMOLE_STATE_DIR moves the whole layout;
// the per-path CYBERMOLE_AGENT_DIR / CYBERMOLE_DB_FILE overrides still win.
const stateDir = RAW_ENV.CYBERMOLE_STATE_DIR ?? path.join(home, '.local', 'state', 'cybermole');
const agentDir = RAW_ENV.CYBERMOLE_AGENT_DIR ?? path.join(stateDir, 'pi-agent');
// cybermole's own persisted state (sqlite).
const dbFile = RAW_ENV.CYBERMOLE_DB_FILE ?? path.join(stateDir, 'cybermole.db');

export const ENV = {
  CYBERMOLE_HOST: RAW_ENV.CYBERMOLE_HOST,
  CYBERMOLE_PORT: RAW_ENV.CYBERMOLE_PORT,
  CYBERMOLE_BASE: RAW_ENV.CYBERMOLE_BASE,
  CYBERMOLE_TMUX_SOCKET: RAW_ENV.CYBERMOLE_TMUX_SOCKET,
  CYBERMOLE_TRUST_PROXY: RAW_ENV.CYBERMOLE_TRUST_PROXY,
  CYBERMOLE_WS_UPGRADES_PER_MIN: RAW_ENV.CYBERMOLE_WS_UPGRADES_PER_MIN,
  CYBERMOLE_HOME: home,
  CYBERMOLE_STATE_DIR: stateDir,
  CYBERMOLE_AGENT_DIR: agentDir,
  CYBERMOLE_DB_FILE: dbFile,
  CYBERMOLE_CLIENT_DIR: RAW_ENV.CYBERMOLE_CLIENT_DIR ?? path.join(APP_ROOT, 'dist', 'client'),
  CYBERMOLE_ASTRO_ENTRY:
    RAW_ENV.CYBERMOLE_ASTRO_ENTRY ?? path.join(APP_ROOT, 'dist', 'server', 'entry.mjs'),
  CYBERMOLE_NEW_SESSION_CWD: RAW_ENV.CYBERMOLE_NEW_SESSION_CWD ?? home,
  // task/ws-jobs (plan §9): job run logs live under the WORKSPACE volume
  // — the wrapper runs as the workspace uid, where CYBERMOLE_STATE_DIR is
  // not even mounted in the compose split. /workspace/.cybermole/job-logs is
  // pinned by the plan (workspace-init creates it); non-container shapes
  // override it (a bare host run has no /workspace — runs then leave no
  // logs and their results stay 'unknown', never a failure).
  CYBERMOLE_JOB_LOG_DIR: RAW_ENV.CYBERMOLE_JOB_LOG_DIR ?? '/workspace/.cybermole/job-logs',
  // task/job-log-caps (plan §8): the write-time cap the run wrapper's
  // appender enforces per run log (src/lib/job-log-appender.ts).
  CYBERMOLE_JOB_LOG_MAX: RAW_ENV.CYBERMOLE_JOB_LOG_MAX,
  // The command a new terminal tab runs (plan §10): a login shell by
  // default — $SHELL -l when the env carries one, /bin/sh -l otherwise.
  // Whitespace-split by main.ts like any override; e2e's deterministic
  // cmd.sh keeps working as an explicit CYBERMOLE_COMMAND.
  CYBERMOLE_COMMAND: RAW_ENV.CYBERMOLE_COMMAND ?? `${process.env.SHELL ?? '/bin/sh'} -l`,
  CYBERMOLE_TMUX_CONF: RAW_ENV.CYBERMOLE_TMUX_CONF ?? path.join(APP_ROOT, 'tmux.conf'),
};

/** Internal API socket default (task/jobs-socket, plan §3): the shared
 *  /run/cybermole dir (the compose privilege split — the same setgid dir the
 *  tmux socket lives in) when it exists, else the state dir (plain host).
 *  Pure — the fs probe is injected, so the heuristic is testable without
 *  the real /run. */
export function internalSocketDefault(stateDir: string, runCybermoleExists: boolean): string {
  return runCybermoleExists ? '/run/cybermole/cybermole.sock' : path.join(stateDir, 'cybermole.sock');
}

/** The internal jobs API's socket path (task/jobs-socket, plan §3), or
 *  null when CYBERMOLE_SOCK is EMPTY — the listener is off entirely (the
 *  workspace side then has no jobs socket; CLI/MCP clients answer "the
 *  internal API is disabled"). Unset = the shape default
 *  (internalSocketDefault); a set value must be an ABSOLUTE path or the
 *  boot stops, like the S3/editor vars: CYBERMOLE_SOCK is shared-filesystem
 *  wiring, and a quietly-ignored typo would strand the workspace side.
 *  A function, not an ENV constant, so other entry points (set-password)
 *  never trip over it. */
export function readInternalApiSocket(): string | null {
  const raw = RAW_ENV.CYBERMOLE_SOCK;
  if (raw === undefined) {
    const runCybermoleExists = fs.existsSync('/run/cybermole') && fs.statSync('/run/cybermole').isDirectory();
    return internalSocketDefault(stateDir, runCybermoleExists);
  }
  if (raw.trim() === '') return null;
  if (!path.isAbsolute(raw)) {
    throw new Error(
      `CYBERMOLE_SOCK=${JSON.stringify(raw)} must be an absolute socket path ` +
        '(or empty to disable the internal API)',
    );
  }
  return raw;
}

/** Loki push config for the winston-loki transport (src/lib/logger.ts), or
 *  null when CYBERMOLE_LOKI_URL is unset — console-only logging, identical to
 *  before the observability work. Validated at boot like the S3 vars: a
 *  half-set or non-http(s) value throws and stops the server. Empty strings
 *  count as unset (compose's `VAR: ""`). */
export function readLokiConfig(): LokiConfig | null {
  const set = (v: string | undefined): v is string => v !== undefined && v !== '';
  const url = RAW_ENV.CYBERMOLE_LOKI_URL;
  const job = RAW_ENV.CYBERMOLE_LOKI_JOB;
  if (!set(url) && !set(job)) return null;
  if (!set(url)) throw new Error('CYBERMOLE_LOKI_JOB is set without CYBERMOLE_LOKI_URL');
  if (!URL.canParse(url) || !/^https?:$/.test(new URL(url).protocol)) {
    throw new Error(`CYBERMOLE_LOKI_URL=${JSON.stringify(url)} is not an http(s) URL`);
  }
  const label = job ?? 'cybermole';
  // A conservative label value: safe to interpolate into a LogQL stream
  // selector ({job="cybermole"}) without escaping games.
  // eslint-disable-next-line no-useless-escape -- escaped `-` is house style (CODE_STYLE §5: schema regexes render as HTML `pattern` attributes, compiled with the `v` flag)
  if (!/^[a-zA-Z0-9_][a-zA-Z0-9_\-]{0,63}$/.test(label)) {
    throw new Error(
      `CYBERMOLE_LOKI_JOB=${JSON.stringify(label)} is not a valid job label ` +
        '(letters, digits, "_" and "-", max 64 chars)',
    );
  }
  // winston-loki appends /loki/api/v1/push — a trailing slash would double it.
  return { url: url.replace(/\/+$/, ''), job: label };
}

/** Object storage (src/lib/storage.ts), or null when no endpoint is set —
 *  the store then answers storage_not_configured. A half-configured or
 *  malformed one throws, and server/main.ts calls this at boot, so it
 *  stops the server like a non-integer number: an operator mistake, not
 *  something to discover on first upload. A function, not a constant like
 *  ENV, so other entry points never trip over it: `compose exec cybermole …
 *  set-password.js` skips the entrypoint that loads the generated keys.
 *  Empty strings count as unset (compose's `VAR: ""`). */
export function readObjectStoreConfig(): ObjectStoreConfig | null {
  const set = (v: string | undefined): v is string => v !== undefined && v !== '';
  const endpoint = RAW_ENV.CYBERMOLE_S3_ENDPOINT;
  const accessKeyId = RAW_ENV.CYBERMOLE_S3_ACCESS_KEY;
  const secretAccessKey = RAW_ENV.CYBERMOLE_S3_SECRET_KEY;
  if (!set(endpoint) && !set(accessKeyId) && !set(secretAccessKey)) return null;
  if (!set(endpoint) || !set(accessKeyId) || !set(secretAccessKey)) {
    throw new Error(
      'CYBERMOLE_S3_ENDPOINT, CYBERMOLE_S3_ACCESS_KEY and CYBERMOLE_S3_SECRET_KEY must be set together',
    );
  }
  if (!URL.canParse(endpoint) || !/^https?:$/.test(new URL(endpoint).protocol)) {
    throw new Error(`CYBERMOLE_S3_ENDPOINT=${JSON.stringify(endpoint)} is not an http(s) URL`);
  }
  // S3's bucket naming rules (path-style requests put it in the URL path).
  // eslint-disable-next-line no-useless-escape -- escaped `-` is house style (CODE_STYLE §5)
  if (!/^[a-z0-9][a-z0-9.\-]{1,61}[a-z0-9]$/.test(RAW_ENV.CYBERMOLE_S3_BUCKET)) {
    throw new Error(
      `CYBERMOLE_S3_BUCKET=${JSON.stringify(RAW_ENV.CYBERMOLE_S3_BUCKET)} is not a valid bucket name`,
    );
  }
  return {
    endpoint,
    accessKeyId,
    secretAccessKey,
    bucket: RAW_ENV.CYBERMOLE_S3_BUCKET,
    region: RAW_ENV.CYBERMOLE_S3_REGION,
  };
}

/** Editor webapp upstream (src/lib/editor.ts, docs/editor-webapp.md), or
 *  null when CYBERMOLE_EDITOR_UPSTREAM is unset/empty — the single switch: the
 *  server then answers 404 under /editor and the console hides its
 *  affordances. One var, no half-set states (the Zed triple's launcher-pair
 *  plumbing is gone): a SET value must be a clean http(s) origin — no path,
 *  query or fragment, which the proxy would silently drop — or the boot
 *  stops, like a malformed object store. */
export function readEditorUpstream(): EditorUpstream | null {
  const raw = RAW_ENV.CYBERMOLE_EDITOR_UPSTREAM;
  if (raw === undefined || raw.trim() === '') return null;
  if (!URL.canParse(raw) || !/^https?:$/.test(new URL(raw).protocol)) {
    throw new Error(`CYBERMOLE_EDITOR_UPSTREAM=${JSON.stringify(raw)} is not an http(s) URL`);
  }
  const u = new URL(raw);
  if (u.pathname !== '/' || u.search !== '' || u.hash !== '') {
    throw new Error(
      `CYBERMOLE_EDITOR_UPSTREAM=${JSON.stringify(raw)} must be an origin only ` +
        '(e.g. http://editor:3000) — the proxy forwards request paths verbatim',
    );
  }
  return { origin: u.origin };
}
