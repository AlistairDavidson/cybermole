import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { envSchema, type EnvValue, type ServerEnvField } from './env-schema';
import type { ObjectStoreConfig } from './storage';
import type { ZedLaunchConfig } from './zed';


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

export const PI_AGENT_DIR: string | undefined = process.env.PI_CODING_AGENT_DIR;
export const PI_SESSION_DIR: string | undefined = process.env.PI_CODING_AGENT_SESSION_DIR;

const home = RAW_ENV.WEB_PI_HOME ?? os.homedir();
// All web-pi state under one directory (DESIGN_REVIEW §3.3): XDG-style
// under HOME, so nothing defaults into the app root where a container
// image sync could overwrite it. WEB_PI_STATE_DIR moves the whole layout;
// the per-path WEB_PI_AGENT_DIR / WEB_PI_DB_FILE overrides still win.
const stateDir = RAW_ENV.WEB_PI_STATE_DIR ?? path.join(home, '.local', 'state', 'web-pi');
const agentDir = RAW_ENV.WEB_PI_AGENT_DIR ?? path.join(stateDir, 'pi-agent');
// web-pi's own persisted state (sqlite: credential + hidden sessions).
const dbFile = RAW_ENV.WEB_PI_DB_FILE ?? path.join(stateDir, 'webpi.db');

export const ENV = {
  WEB_PI_HOST: RAW_ENV.WEB_PI_HOST,
  WEB_PI_PORT: RAW_ENV.WEB_PI_PORT,
  WEB_PI_BASE: RAW_ENV.WEB_PI_BASE,
  WEB_PI_TMUX_SOCKET: RAW_ENV.WEB_PI_TMUX_SOCKET,
  WEB_PI_TRUST_PROXY: RAW_ENV.WEB_PI_TRUST_PROXY,
  WEB_PI_HOME: home,
  WEB_PI_STATE_DIR: stateDir,
  WEB_PI_AGENT_DIR: agentDir,
  WEB_PI_DB_FILE: dbFile,
  WEB_PI_CLIENT_DIR: RAW_ENV.WEB_PI_CLIENT_DIR ?? path.join(APP_ROOT, 'dist', 'client'),
  WEB_PI_ASTRO_ENTRY: RAW_ENV.WEB_PI_ASTRO_ENTRY ?? path.join(APP_ROOT, 'dist', 'server', 'entry.mjs'),
  WEB_PI_SESSIONS_DIR: RAW_ENV.WEB_PI_SESSIONS_DIR ?? PI_SESSION_DIR ?? path.join(agentDir, 'sessions'),
  WEB_PI_NEW_SESSION_CWD: RAW_ENV.WEB_PI_NEW_SESSION_CWD ?? home,
  WEB_PI_COMMAND: RAW_ENV.WEB_PI_COMMAND ?? (fs.existsSync(PI_BIN) ? PI_BIN : 'pi'),
  WEB_PI_TMUX_CONF: RAW_ENV.WEB_PI_TMUX_CONF ?? path.join(APP_ROOT, 'tmux.conf'),
};

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

/** Zed webapp config (src/lib/zed.ts, docs/zed-webapp.md), or null when
 *  unset — the console then hides its Zed affordances. All three set or
 *  none, like object storage: compose supplies the launch URL default,
 *  the token arrives via docker-entrypoint.sh from zed-init's generated
 *  file. Empty strings count as unset (compose's `VAR: ""`). */
export function readZedConfig(): ZedLaunchConfig | null {
  const set = (v: string | undefined): v is string => v !== undefined && v.trim() !== '';
  const url = RAW_ENV.WEB_PI_ZED_URL;
  const launchUrl = RAW_ENV.WEB_PI_ZED_LAUNCH_URL;
  const token = RAW_ENV.WEB_PI_ZED_LAUNCH_TOKEN;
  if (!set(url) && !set(launchUrl) && !set(token)) return null;
  if (!set(url) || !set(launchUrl) || !set(token)) {
    throw new Error('WEB_PI_ZED_URL, WEB_PI_ZED_LAUNCH_URL and WEB_PI_ZED_LAUNCH_TOKEN must be set together');
  }
  for (const [name, value] of [['WEB_PI_ZED_URL', url], ['WEB_PI_ZED_LAUNCH_URL', launchUrl]] as const) {
    if (!URL.canParse(value) || !/^https?:$/.test(new URL(value).protocol)) {
      throw new Error(`${name}=${JSON.stringify(value)} is not an http(s) URL`);
    }
  }
  return { url, launchUrl, token };
}
