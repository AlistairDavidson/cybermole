// Astro env-schema format, not zod: astro.config.mjs consumes these
// descriptors directly, and env.ts reads the same table for the tsc build.
export type EnvFieldType = 'string' | 'number' | 'boolean';

export interface ServerEnvField {
  context: 'server';
  access: 'secret';
  type: EnvFieldType;

  optional?: true;
  default?: string | number | boolean;
}

type PrimitiveOf = { string: string; number: number; boolean: boolean };

export type EnvValue<F extends ServerEnvField> =
  PrimitiveOf[F['type']] | ('default' extends keyof F ? never : undefined);

export const envSchema = {
  CYBERMOLE_HOST: { type: 'string', context: 'server', access: 'secret', default: '127.0.0.1' },
  CYBERMOLE_PORT: { type: 'number', context: 'server', access: 'secret', default: 3000 },
  CYBERMOLE_BASE: { type: 'string', context: 'server', access: 'secret', default: '/' },
  // Relative name: the app's own tmux server, forked on demand. Absolute
  // path: another uid owns the server and this process never forks one.
  CYBERMOLE_TMUX_SOCKET: {
    type: 'string',
    context: 'server',
    access: 'secret',
    default: 'cybermole',
  },
  // Trusted proxy hops in front (nginx = 1, ALB → nginx = 2); 0 ignores XFF.
  CYBERMOLE_TRUST_PROXY: { type: 'number', context: 'server', access: 'secret', default: 0 },
  // Per client IP. The serial e2e suite raises it: it upgrades far more than 30/min.
  CYBERMOLE_WS_UPGRADES_PER_MIN: {
    type: 'number',
    context: 'server',
    access: 'secret',
    default: 30,
  },
  // Dynamic defaults for the rest live in env.ts.
  CYBERMOLE_HOME: { type: 'string', context: 'server', access: 'secret', optional: true },
  CYBERMOLE_STATE_DIR: { type: 'string', context: 'server', access: 'secret', optional: true },
  CYBERMOLE_AGENT_DIR: { type: 'string', context: 'server', access: 'secret', optional: true },
  CYBERMOLE_DB_FILE: { type: 'string', context: 'server', access: 'secret', optional: true },
  CYBERMOLE_CLIENT_DIR: { type: 'string', context: 'server', access: 'secret', optional: true },
  CYBERMOLE_ASTRO_ENTRY: { type: 'string', context: 'server', access: 'secret', optional: true },
  CYBERMOLE_NEW_SESSION_CWD: {
    type: 'string',
    context: 'server',
    access: 'secret',
    optional: true,
  },
  // Must exist in both containers of the compose split.
  CYBERMOLE_JOB_LOG_DIR: { type: 'string', context: 'server', access: 'secret', optional: true },
  // Write-time cap per run log, in bytes.
  CYBERMOLE_JOB_LOG_MAX: { type: 'number', context: 'server', access: 'secret', default: 20971520 },
  // Default webhook URL for job-run finish notifications (README →
  // Scheduled jobs). Unset: off unless the /settings db override sets one.
  CYBERMOLE_JOB_WEBHOOK_URL: {
    type: 'string',
    context: 'server',
    access: 'secret',
    optional: true,
  },
  CYBERMOLE_COMMAND: { type: 'string', context: 'server', access: 'secret', optional: true },
  // The agent slot's command; a /settings override wins.
  CYBERMOLE_AGENT_COMMAND: { type: 'string', context: 'server', access: 'secret', optional: true },
  CYBERMOLE_TMUX_CONF: { type: 'string', context: 'server', access: 'secret', optional: true },
  // Internal API socket. Empty disables it; a set value must be absolute.
  CYBERMOLE_SOCK: { type: 'string', context: 'server', access: 'secret', optional: true },
  // App host socket. Empty turns apps off; a set value must be absolute.
  CYBERMOLE_APPS_SOCK: { type: 'string', context: 'server', access: 'secret', optional: true },
  // Where app trees are scaffolded. Must be absolute; defaults onto the
  // workspace volume since trees belong to the workspace uid.
  CYBERMOLE_APPS_ROOT: { type: 'string', context: 'server', access: 'secret', optional: true },
  // Unset: console-only logging.
  CYBERMOLE_LOKI_URL: { type: 'string', context: 'server', access: 'secret', optional: true },
  CYBERMOLE_LOKI_JOB: { type: 'string', context: 'server', access: 'secret', optional: true },
  // Any S3-compatible server; an endpoint needs both keys.
  CYBERMOLE_S3_ENDPOINT: { type: 'string', context: 'server', access: 'secret', optional: true },
  CYBERMOLE_S3_ACCESS_KEY: { type: 'string', context: 'server', access: 'secret', optional: true },
  CYBERMOLE_S3_SECRET_KEY: { type: 'string', context: 'server', access: 'secret', optional: true },
  CYBERMOLE_S3_BUCKET: {
    type: 'string',
    context: 'server',
    access: 'secret',
    default: 'cybermole',
  },
  // SigV4 needs a region; self-hosted servers accept any.
  CYBERMOLE_S3_REGION: {
    type: 'string',
    context: 'server',
    access: 'secret',
    default: 'us-east-1',
  },
  // e.g. http://editor:3000. Unset: /editor answers 404.
  CYBERMOLE_EDITOR_UPSTREAM: {
    type: 'string',
    context: 'server',
    access: 'secret',
    optional: true,
  },
  // Browser-reachable (the compose-internal grafana:3000 isn't). Unset: /logs answers 404.
  CYBERMOLE_GRAFANA_URL: { type: 'string', context: 'server', access: 'secret', optional: true },
} as const satisfies Record<string, ServerEnvField>;
