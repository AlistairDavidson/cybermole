// Astro env-schema format on purpose, NOT zod: astro.config.mjs consumes
// these field descriptors (context/access/type) directly and src/lib/env.ts
// reads the same table for the plain-tsc server build — a zod conversion
// would break both. The WEB_PI_* contract stays as-is.
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
  // Static defaults, applied by the schema-driven reader in env.ts.
  WEB_PI_HOST: { type: 'string', context: 'server', access: 'secret', default: '127.0.0.1' },
  WEB_PI_PORT: { type: 'number', context: 'server', access: 'secret', default: 3000 },
  WEB_PI_BASE: { type: 'string', context: 'server', access: 'secret', default: '/' },
  // Relative name (default) = single-user: the app's own tmux server,
  // forked on first new-session, in the per-uid default socket dir.
  // Absolute path = the privilege split (DESIGN_REVIEW §1.1): the tmux
  // server and every pi session run as ANOTHER uid/container (workspace),
  // and this process is only a client on that shared socket — tmux gets
  // `-S <path>` instead of `-L <name>` (a relative name resolves per-uid
  // as $TMUX_TMPDIR/tmux-<uid>/<name>, unusable across uids), and
  // new/resume sessions refuse to fork a server (see src/lib/tmux.ts).
  WEB_PI_TMUX_SOCKET: { type: 'string', context: 'server', access: 'secret', default: 'web-pi' },
  // Reverse-proxy hops in front of the server whose X-Forwarded-For entries
  // are trusted (nginx = 1, ALB → nginx = 2). 0: XFF is ignored entirely.
  WEB_PI_TRUST_PROXY: { type: 'number', context: 'server', access: 'secret', default: 0 },
  // Dynamic defaults — see env.ts (homedir / app root / fs probe / cross-var).
  WEB_PI_HOME: { type: 'string', context: 'server', access: 'secret', optional: true },
  // One directory for all web-pi state (db, runtime pi agent dir) —
  // dynamic default in env.ts ($WEB_PI_HOME/.local/state/web-pi).
  WEB_PI_STATE_DIR: { type: 'string', context: 'server', access: 'secret', optional: true },
  WEB_PI_AGENT_DIR: { type: 'string', context: 'server', access: 'secret', optional: true },
  // sqlite state db (credential + hidden sessions) — dynamic default in env.ts.
  WEB_PI_DB_FILE: { type: 'string', context: 'server', access: 'secret', optional: true },
  WEB_PI_CLIENT_DIR: { type: 'string', context: 'server', access: 'secret', optional: true },
  WEB_PI_ASTRO_ENTRY: { type: 'string', context: 'server', access: 'secret', optional: true },
  WEB_PI_SESSIONS_DIR: { type: 'string', context: 'server', access: 'secret', optional: true },
  WEB_PI_NEW_SESSION_CWD: { type: 'string', context: 'server', access: 'secret', optional: true },
  WEB_PI_COMMAND: { type: 'string', context: 'server', access: 'secret', optional: true },
  WEB_PI_TMUX_CONF: { type: 'string', context: 'server', access: 'secret', optional: true },
  // task/winston-loki: log aggregation — push URL of a Grafana Loki (the
  // compose `observability` profile runs one; e.g. http://loki:3100).
  // Unset = console-only logging, byte-for-byte today's behaviour (env.ts
  // validates it at boot like the S3 vars — a set-but-malformed URL stops
  // the server).
  WEB_PI_LOKI_URL: { type: 'string', context: 'server', access: 'secret', optional: true },
  // task/winston-loki: the static `job` label every pushed log line carries
  // (identifies this deployment in Loki's stream selectors). Default in
  // env.ts: 'webpi'.
  WEB_PI_LOKI_JOB: { type: 'string', context: 'server', access: 'secret', optional: true },
  // task/mgmt-page (docs/management-page.md §6): the releases volume —
  // where the builder sidecar writes built releases and web reads them.
  // Unset = the swap half of /management is off (build/activate answer
  // 503); the page still shows state and dry-run enforcement verdicts.
  WEB_PI_RELEASES_DIR: { type: 'string', context: 'server', access: 'secret', optional: true },
  // task/mgmt-page: the workspace checkout /management reads commits from
  // and applies (compose: /workspace/web-pi; the dev profile can point it
  // at /app). Read-only on web's mount.
  WEB_PI_MANAGEMENT_CHECKOUT: { type: 'string', context: 'server', access: 'secret', optional: true },
  // Object storage (src/lib/storage.ts) — any S3-compatible server; the
  // compose stack runs SeaweedFS. No endpoint = not configured (uploads
  // answer 503); an endpoint needs both keys — env.ts checks at boot.
  WEB_PI_S3_ENDPOINT: { type: 'string', context: 'server', access: 'secret', optional: true },
  WEB_PI_S3_ACCESS_KEY: { type: 'string', context: 'server', access: 'secret', optional: true },
  WEB_PI_S3_SECRET_KEY: { type: 'string', context: 'server', access: 'secret', optional: true },
  WEB_PI_S3_BUCKET: { type: 'string', context: 'server', access: 'secret', default: 'webpi' },
  // SigV4 signs with a region; self-hosted servers accept any, us-east-1 is the convention.
  WEB_PI_S3_REGION: { type: 'string', context: 'server', access: 'secret', default: 'us-east-1' },
  // task/ws-editor (docs/editor-webapp.md): the VSCodium reh-web editor's
  // upstream on the compose network (e.g. http://editor:3000). THE single
  // switch — unset/empty = the editor is off: /editor/* answers 404 and the
  // console hides its affordances. Validated at boot (env.ts
  // readEditorUpstream) like the S3 vars: a malformed value stops the server.
  WEB_PI_EDITOR_UPSTREAM: { type: 'string', context: 'server', access: 'secret', optional: true },
} as const satisfies Record<string, ServerEnvField>;
