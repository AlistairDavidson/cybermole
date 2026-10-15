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
  /** the static `job` label every line carries (WEB_PI_LOKI_JOB, 'webpi') */
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
    } else if (field.type === 'boolean') out[key] = raw === 'true' ? true : raw === 'false' ? false : field.default;
    else out[key] = raw ?? field.default;
  }
  return out as SchemaEnv;
}

export const RAW_ENV: SchemaEnv = readSchemaEnv();

// task/mgmt-page: optional — empty string counts as unset (compose `VAR: ""`).
const optionalPath = (v: string | undefined): string | null =>
  v === undefined || v.trim() === '' ? null : v.trim();
export const RELEASES_DIR: string | null = optionalPath(RAW_ENV.WEB_PI_RELEASES_DIR);
export const MANAGEMENT_CHECKOUT: string | null = optionalPath(RAW_ENV.WEB_PI_MANAGEMENT_CHECKOUT);

export const PI_AGENT_DIR: string | undefined = process.env.PI_CODING_AGENT_DIR;
export const PI_SESSION_DIR: string | undefined = process.env.PI_CODING_AGENT_SESSION_DIR;

const home = RAW_ENV.WEB_PI_HOME ?? os.homedir();
// All web-pi state under one directory (DESIGN_REVIEW §3.3): XDG-style
// under HOME, so nothing defaults into the app root where a container
// image sync could overwrite it. WEB_PI_STATE_DIR moves the whole layout;
// the per-path WEB_PI_AGENT_DIR / WEB_PI_DB_FILE overrides still win.
const stateDir = RAW_ENV.WEB_PI_STATE_DIR ?? path.join(home, '.local', 'state', 'web-pi');
const agentDir = RAW_ENV.WEB_PI_AGENT_DIR ?? path.join(stateDir, 'pi-agent');
// web-pi's own persisted state (sqlite).
const dbFile = RAW_ENV.WEB_PI_DB_FILE ?? path.join(stateDir, 'webpi.db');

export const ENV = {
  WEB_PI_HOST: RAW_ENV.WEB_PI_HOST,
  WEB_PI_PORT: RAW_ENV.WEB_PI_PORT,
  WEB_PI_BASE: RAW_ENV.WEB_PI_BASE,
  WEB_PI_TMUX_SOCKET: RAW_ENV.WEB_PI_TMUX_SOCKET,
  WEB_PI_TRUST_PROXY: RAW_ENV.WEB_PI_TRUST_PROXY,
  WEB_PI_WS_UPGRADES_PER_MIN: RAW_ENV.WEB_PI_WS_UPGRADES_PER_MIN,
  WEB_PI_HOME: home,
  WEB_PI_STATE_DIR: stateDir,
  WEB_PI_AGENT_DIR: agentDir,
  WEB_PI_DB_FILE: dbFile,
  WEB_PI_CLIENT_DIR: RAW_ENV.WEB_PI_CLIENT_DIR ?? path.join(APP_ROOT, 'dist', 'client'),
  WEB_PI_ASTRO_ENTRY: RAW_ENV.WEB_PI_ASTRO_ENTRY ?? path.join(APP_ROOT, 'dist', 'server', 'entry.mjs'),
  WEB_PI_NEW_SESSION_CWD: RAW_ENV.WEB_PI_NEW_SESSION_CWD ?? home,
  // task/ws-jobs (plan §9): job run logs live under the WORKSPACE volume
  // — the wrapper runs as the workspace uid, where WEB_PI_STATE_DIR is
  // not even mounted in the compose split. /workspace/.webpi/job-logs is
  // pinned by the plan (workspace-init creates it); non-container shapes
  // override it (a bare host run has no /workspace — runs then leave no
  // logs and their results stay 'unknown', never a failure).
  WEB_PI_JOB_LOG_DIR: RAW_ENV.WEB_PI_JOB_LOG_DIR ?? '/workspace/.webpi/job-logs',
  // The command a new terminal tab runs (plan §10): a login shell by
  // default — $SHELL -l when the env carries one, /bin/sh -l otherwise.
  // Whitespace-split by main.ts like any override; e2e's deterministic
  // cmd.sh keeps working as an explicit WEB_PI_COMMAND.
  WEB_PI_COMMAND: RAW_ENV.WEB_PI_COMMAND ?? `${process.env.SHELL ?? '/bin/sh'} -l`,
  WEB_PI_TMUX_CONF: RAW_ENV.WEB_PI_TMUX_CONF ?? path.join(APP_ROOT, 'tmux.conf'),
};

/** Loki push config for the winston-loki transport (src/lib/logger.ts), or
 *  null when WEB_PI_LOKI_URL is unset — console-only logging, identical to
 *  before the observability work. Validated at boot like the S3 vars: a
 *  half-set or non-http(s) value throws and stops the server. Empty strings
 *  count as unset (compose's `VAR: ""`). */
export function readLokiConfig(): LokiConfig | null {
  const set = (v: string | undefined): v is string => v !== undefined && v !== '';
  const url = RAW_ENV.WEB_PI_LOKI_URL;
  const job = RAW_ENV.WEB_PI_LOKI_JOB;
  if (!set(url) && !set(job)) return null;
  if (!set(url)) throw new Error('WEB_PI_LOKI_JOB is set without WEB_PI_LOKI_URL');
  if (!URL.canParse(url) || !/^https?:$/.test(new URL(url).protocol)) {
    throw new Error(`WEB_PI_LOKI_URL=${JSON.stringify(url)} is not an http(s) URL`);
  }
  const label = job ?? 'webpi';
  // A conservative label value: safe to interpolate into a LogQL stream
  // selector ({job="webpi"}) without escaping games.
  if (!/^[a-zA-Z0-9_][a-zA-Z0-9_\-]{0,63}$/.test(label)) {
    throw new Error(`WEB_PI_LOKI_JOB=${JSON.stringify(label)} is not a valid job label ` +
      '(letters, digits, "_" and "-", max 64 chars)');
  }
  // winston-loki appends /loki/api/v1/push — a trailing slash would double it.
  return { url: url.replace(/\/+$/, ''), job: label };
}

/** Object storage (src/lib/storage.ts), or null when no endpoint is set —
 *  the store then answers storage_not_configured. A half-configured or
 *  malformed one throws, and server/main.ts calls this at boot, so it
 *  stops the server like a non-integer number: an operator mistake, not
 *  something to discover on first upload. A function, not a constant like
 *  ENV, so other entry points never trip over it: `compose exec webpi …
 *  set-password.js` skips the entrypoint that loads the generated keys.
 *  Empty strings count as unset (compose's `VAR: ""`). */
export function readObjectStoreConfig(): ObjectStoreConfig | null {
  const set = (v: string | undefined): v is string => v !== undefined && v !== '';
  const endpoint = RAW_ENV.WEB_PI_S3_ENDPOINT;
  const accessKeyId = RAW_ENV.WEB_PI_S3_ACCESS_KEY;
  const secretAccessKey = RAW_ENV.WEB_PI_S3_SECRET_KEY;
  if (!set(endpoint) && !set(accessKeyId) && !set(secretAccessKey)) return null;
  if (!set(endpoint) || !set(accessKeyId) || !set(secretAccessKey)) {
    throw new Error('WEB_PI_S3_ENDPOINT, WEB_PI_S3_ACCESS_KEY and WEB_PI_S3_SECRET_KEY must be set together');
  }
  if (!URL.canParse(endpoint) || !/^https?:$/.test(new URL(endpoint).protocol)) {
    throw new Error(`WEB_PI_S3_ENDPOINT=${JSON.stringify(endpoint)} is not an http(s) URL`);
  }
  // S3's bucket naming rules (path-style requests put it in the URL path).
  if (!/^[a-z0-9][a-z0-9.\-]{1,61}[a-z0-9]$/.test(RAW_ENV.WEB_PI_S3_BUCKET)) {
    throw new Error(`WEB_PI_S3_BUCKET=${JSON.stringify(RAW_ENV.WEB_PI_S3_BUCKET)} is not a valid bucket name`);
  }
  return { endpoint, accessKeyId, secretAccessKey, bucket: RAW_ENV.WEB_PI_S3_BUCKET, region: RAW_ENV.WEB_PI_S3_REGION };
}

/** Editor webapp upstream (src/lib/editor.ts, docs/editor-webapp.md), or
 *  null when WEB_PI_EDITOR_UPSTREAM is unset/empty — the single switch: the
 *  server then answers 404 under /editor and the console hides its
 *  affordances. One var, no half-set states (the Zed triple's launcher-pair
 *  plumbing is gone): a SET value must be a clean http(s) origin — no path,
 *  query or fragment, which the proxy would silently drop — or the boot
 *  stops, like a malformed object store. */
export function readEditorUpstream(): EditorUpstream | null {
  const raw = RAW_ENV.WEB_PI_EDITOR_UPSTREAM;
  if (raw === undefined || raw.trim() === '') return null;
  if (!URL.canParse(raw) || !/^https?:$/.test(new URL(raw).protocol)) {
    throw new Error(`WEB_PI_EDITOR_UPSTREAM=${JSON.stringify(raw)} is not an http(s) URL`);
  }
  const u = new URL(raw);
  if (u.pathname !== '/' || u.search !== '' || u.hash !== '') {
    throw new Error(`WEB_PI_EDITOR_UPSTREAM=${JSON.stringify(raw)} must be an origin only ` +
      '(e.g. http://editor:3000) — the proxy forwards request paths verbatim');
  }
  return { origin: u.origin };
}
