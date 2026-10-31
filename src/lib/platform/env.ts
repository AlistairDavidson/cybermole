import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { envSchema, type EnvValue, type ServerEnvField } from './env-schema';
import type { EditorUpstream } from '../terminals/editor';
import type { ObjectStoreConfig } from './storage';

/** null when no URL is set: console-only logging. */
export interface LokiConfig {
  /** e.g. http://loki:3100, no trailing slash */
  url: string;
  /** the static `job` label on every line */
  job: string;
}

export const APP_ROOT = path.join(__dirname, '..', '..', '..', '..');
export const PI_BIN = path.join(APP_ROOT, 'node_modules', '.bin', 'pi');

type SchemaEnv = { -readonly [K in keyof typeof envSchema]: EnvValue<(typeof envSchema)[K]> };

function readSchemaEnv(): SchemaEnv {
  const out: Record<string, string | number | boolean | undefined> = {};
  for (const [key, field] of Object.entries(envSchema) as [string, ServerEnvField][]) {
    const raw = process.env[key];
    if (field.type === 'number') {
      // Fail at boot rather than run with NaN.
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

if (RAW_ENV.CYBERMOLE_JOB_LOG_MAX < 0) {
  throw new Error(
    `CYBERMOLE_JOB_LOG_MAX=${RAW_ENV.CYBERMOLE_JOB_LOG_MAX} must not be negative (a byte count)`,
  );
}
export const PI_AGENT_DIR: string | undefined = process.env.PI_CODING_AGENT_DIR;
export const PI_SESSION_DIR: string | undefined = process.env.PI_CODING_AGENT_SESSION_DIR;

const home = RAW_ENV.CYBERMOLE_HOME ?? os.homedir();
// State lives under HOME, never the app root, where an image sync could
// overwrite it. Per-path overrides still win over CYBERMOLE_STATE_DIR.
const stateDir = RAW_ENV.CYBERMOLE_STATE_DIR ?? path.join(home, '.local', 'state', 'cybermole');
const agentDir = RAW_ENV.CYBERMOLE_AGENT_DIR ?? path.join(stateDir, 'pi-agent');
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
  // On the workspace volume: the wrapper runs as the workspace uid, where
  // the state dir isn't mounted. Without /workspace, runs just leave no logs.
  CYBERMOLE_JOB_LOG_DIR: RAW_ENV.CYBERMOLE_JOB_LOG_DIR ?? '/workspace/.cybermole/job-logs',
  CYBERMOLE_JOB_LOG_MAX: RAW_ENV.CYBERMOLE_JOB_LOG_MAX,
  // A login shell by default.
  CYBERMOLE_COMMAND: RAW_ENV.CYBERMOLE_COMMAND ?? `${process.env.SHELL ?? '/bin/sh'} -l`,
  // The agent slot's command; see terminal-defaults.ts.
  CYBERMOLE_AGENT_COMMAND:
    RAW_ENV.CYBERMOLE_AGENT_COMMAND ?? defaultAgentCommand(PI_BIN, fs.existsSync(PI_BIN)),
  CYBERMOLE_TMUX_CONF: RAW_ENV.CYBERMOLE_TMUX_CONF ?? path.join(APP_ROOT, 'runtime', 'tmux.conf'),
};

/** The vendored pi binary when installed, else 'pi' on PATH. */
export function defaultAgentCommand(piBin: string, piBinExists: boolean): string {
  return piBinExists ? piBin : 'pi';
}

/** The shared /run/cybermole dir (compose split) when it exists, else the state dir. */
export function internalSocketDefault(stateDir: string, runCybermoleExists: boolean): string {
  return runCybermoleExists
    ? '/run/cybermole/cybermole.sock'
    : path.join(stateDir, 'cybermole.sock');
}

/** null when CYBERMOLE_SOCK is empty (listener off). A set value must be
 *  absolute or the boot stops: a silently ignored typo would strand the
 *  workspace side. A function rather than an ENV field so entry points that
 *  don't need it (set-password) never trip over it. */
export function readInternalApiSocket(): string | null {
  const raw = RAW_ENV.CYBERMOLE_SOCK;
  if (raw === undefined) {
    const runCybermoleExists =
      fs.existsSync('/run/cybermole') && fs.statSync('/run/cybermole').isDirectory();
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

/** Same rule as internalSocketDefault. */
export function appsSocketDefault(stateDir: string, runCybermoleExists: boolean): string {
  return runCybermoleExists ? '/run/cybermole/apps.sock' : path.join(stateDir, 'apps.sock');
}

/** '/' or '/foo', no trailing slash. Must match the base astro.config.mjs
 *  built with. Every server-side consumer of CYBERMOLE_BASE normalizes
 *  through this so the web server, the app host and the app build loop
 *  (the base apps bake) can't drift apart. */
export function normalizeBase(raw: string): string {
  let b = (raw || '/').trim();
  if (!b.startsWith('/')) b = '/' + b;
  if (b.length > 1 && b.endsWith('/')) b = b.slice(0, -1);
  return b;
}

/** The normalized CYBERMOLE_BASE, as above ('' never appears: root is '/'). */
export function readBase(): string {
  return normalizeBase(RAW_ENV.CYBERMOLE_BASE);
}

/** null when CYBERMOLE_APPS_SOCK is empty (apps off). Same rules as readInternalApiSocket. */
export function readAppsSocket(): string | null {
  const raw = RAW_ENV.CYBERMOLE_APPS_SOCK;
  if (raw === undefined) {
    const runCybermoleExists =
      fs.existsSync('/run/cybermole') && fs.statSync('/run/cybermole').isDirectory();
    return appsSocketDefault(stateDir, runCybermoleExists);
  }
  if (raw.trim() === '') return null;
  if (!path.isAbsolute(raw)) {
    throw new Error(
      `CYBERMOLE_APPS_SOCK=${JSON.stringify(raw)} must be an absolute socket path ` +
        '(or empty to disable the apps surface)',
    );
  }
  return raw;
}

/** /workspace/apps when the workspace volume exists, else the state dir. */
export function appsRootDefault(stateDir: string, workspaceExists: boolean): string {
  return workspaceExists ? '/workspace/apps' : path.join(stateDir, 'apps');
}

/** Unset or empty means the default; a set value must be absolute. */
export function readAppsRoot(): string {
  const raw = RAW_ENV.CYBERMOLE_APPS_ROOT;
  if (raw === undefined || raw.trim() === '') {
    return appsRootDefault(stateDir, fs.existsSync('/workspace'));
  }
  if (!path.isAbsolute(raw)) {
    throw new Error(
      `CYBERMOLE_APPS_ROOT=${JSON.stringify(raw)} must be an absolute directory path`,
    );
  }
  return raw;
}

/** null when CYBERMOLE_LOKI_URL is unset. A half-set or non-http(s) value
 *  stops the boot. Empty strings count as unset (compose's `VAR: ""`). */
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
  // Safe to interpolate into a LogQL selector unescaped.
  // eslint-disable-next-line no-useless-escape -- escaped `-` is house style (CODE_STYLE §5)
  if (!/^[a-zA-Z0-9_][a-zA-Z0-9_\-]{0,63}$/.test(label)) {
    throw new Error(
      `CYBERMOLE_LOKI_JOB=${JSON.stringify(label)} is not a valid job label ` +
        '(letters, digits, "_" and "-", max 64 chars)',
    );
  }
  // winston-loki appends /loki/api/v1/push — a trailing slash would double it.
  return { url: url.replace(/\/+$/, ''), job: label };
}

/** null when unconfigured; a half-set or malformed config stops the boot
 *  rather than surfacing on first upload. A function so `set-password`
 *  (run without the entrypoint that loads the keys) never trips on it. */
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

/** null when unset/empty (job-finish webhook off). A function, like
 *  readGrafanaUrl below, so entry points that never fire it (set-password)
 *  don't trip on a malformed value; the boot and every notifier call read
 *  it fresh, and a malformed value stops the boot (main.ts logs it). */
export function readJobWebhookUrl(): string | null {
  const raw = RAW_ENV.CYBERMOLE_JOB_WEBHOOK_URL;
  if (raw === undefined || raw.trim() === '') return null;
  if (!URL.canParse(raw) || !/^https?:$/.test(new URL(raw).protocol)) {
    throw new Error(`CYBERMOLE_JOB_WEBHOOK_URL=${JSON.stringify(raw)} is not an http(s) URL`);
  }
  return raw;
}

/** null when unset/empty (editor off). Must be a bare origin: the proxy
 *  forwards paths verbatim and would drop a path/query silently. */
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

/** Where deploy/install-host.sh unpacks VSCodium reh-web: under the state
 *  dir, so a hermetic state dir (e2e) never finds the operator's editor. */
export function editorInstallDefault(stateDir: string): string {
  return path.join(stateDir, 'editor');
}

/** The editor's socket sits in its own 0700 dir: the server runs without a
 *  connection token (the session gate is the auth), so nobody else on the
 *  box may reach it. Short on purpose — sun_path caps at ~107 bytes. */
export function editorSocketDefault(stateDir: string): string {
  return path.join(stateDir, 'editor-run', 'editor.sock');
}

export type EditorMode =
  | { kind: 'off'; reason: 'disabled' | 'not_installed' }
  | { kind: 'upstream'; upstream: EditorUpstream }
  | { kind: 'supervised'; installDir: string; upstream: EditorUpstream & { socketPath: string } };

/** CYBERMOLE_EDITOR_UPSTREAM set: proxy there (compose's editor container);
 *  set empty: off. Unset: supervise the host install when one exists. */
export function readEditorMode(): EditorMode {
  if (RAW_ENV.CYBERMOLE_EDITOR_UPSTREAM !== undefined) {
    const upstream = readEditorUpstream();
    return upstream === null ? { kind: 'off', reason: 'disabled' } : { kind: 'upstream', upstream };
  }
  const installDir = editorInstallDefault(stateDir);
  if (!fs.existsSync(path.join(installDir, 'out', 'server-main.js'))) {
    return { kind: 'off', reason: 'not_installed' };
  }
  return {
    kind: 'supervised',
    installDir,
    upstream: { origin: 'http://localhost', socketPath: editorSocketDefault(stateDir) },
  };
}

/** null when unset/empty (/logs off). Unlike the editor, a path is fine
 *  (the browser loads it, so a subpath-mounted Grafana works); a query or
 *  fragment stops the boot since /explore is appended. */
export function readGrafanaUrl(): string | null {
  const raw = RAW_ENV.CYBERMOLE_GRAFANA_URL;
  if (raw === undefined || raw.trim() === '') return null;
  if (!URL.canParse(raw) || !/^https?:$/.test(new URL(raw).protocol)) {
    throw new Error(`CYBERMOLE_GRAFANA_URL=${JSON.stringify(raw)} is not an http(s) URL`);
  }
  const u = new URL(raw);
  if (u.search !== '' || u.hash !== '') {
    throw new Error(
      `CYBERMOLE_GRAFANA_URL=${JSON.stringify(raw)} must not carry a query or fragment ` +
        '(the /logs page appends its own path)',
    );
  }
  return `${u.origin}${u.pathname}`.replace(/\/+$/, '');
}
