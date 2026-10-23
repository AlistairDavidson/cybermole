// Astro env-schema format on purpose, NOT zod: astro.config.mjs consumes
// these field descriptors (context/access/type) directly and src/lib/env.ts
// reads the same table for the plain-tsc server build — a zod conversion
// would break both. The CYBERMOLE_* contract stays as-is.
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
  CYBERMOLE_HOST: { type: 'string', context: 'server', access: 'secret', default: '127.0.0.1' },
  CYBERMOLE_PORT: { type: 'number', context: 'server', access: 'secret', default: 3000 },
  CYBERMOLE_BASE: { type: 'string', context: 'server', access: 'secret', default: '/' },
  // Relative name (default) = single-user: the app's own tmux server,
  // forked on first new-session, in the per-uid default socket dir.
  // Absolute path = the privilege split (DESIGN_REVIEW §1.1): the tmux
  // server and every pi session run as ANOTHER uid/container (workspace),
  // and this process is only a client on that shared socket — tmux gets
  // `-S <path>` instead of `-L <name>` (a relative name resolves per-uid
  // as $TMUX_TMPDIR/tmux-<uid>/<name>, unusable across uids), and every
  // session-creating call (terminal spawns, job runs, the WS attach)
  // refuses to fork a server (see src/lib/tmux.ts).
  CYBERMOLE_TMUX_SOCKET: { type: 'string', context: 'server', access: 'secret', default: 'cybermole' },
  // Reverse-proxy hops in front of the server whose X-Forwarded-For entries
  // are trusted (nginx = 1, ALB → nginx = 2). 0: XFF is ignored entirely.
  CYBERMOLE_TRUST_PROXY: { type: 'number', context: 'server', access: 'secret', default: 0 },
  // Terminal WS upgrades allowed per minute per client IP (the brute-force
  // gate next to the login limiter, server/main.ts). Default is a production
  // shape; the e2e suite is serial from one IP and legitimately upgrades far
  // more (every terminal test attaches, pops, reconnects), so its config
  // raises this — the jobs test's run attach was refused at exactly 30.
  CYBERMOLE_WS_UPGRADES_PER_MIN: { type: 'number', context: 'server', access: 'secret', default: 30 },
  // Dynamic defaults — see env.ts (homedir / app root / fs probe / cross-var).
  CYBERMOLE_HOME: { type: 'string', context: 'server', access: 'secret', optional: true },
  // One directory for all cybermole state (db, runtime pi agent dir) —
  // dynamic default in env.ts ($CYBERMOLE_HOME/.local/state/cybermole).
  CYBERMOLE_STATE_DIR: { type: 'string', context: 'server', access: 'secret', optional: true },
  CYBERMOLE_AGENT_DIR: { type: 'string', context: 'server', access: 'secret', optional: true },
  // sqlite state db (login credential, login sessions, the workspace
  // tree, jobs) — dynamic default in env.ts.
  CYBERMOLE_DB_FILE: { type: 'string', context: 'server', access: 'secret', optional: true },
  CYBERMOLE_CLIENT_DIR: { type: 'string', context: 'server', access: 'secret', optional: true },
  CYBERMOLE_ASTRO_ENTRY: { type: 'string', context: 'server', access: 'secret', optional: true },
  CYBERMOLE_NEW_SESSION_CWD: { type: 'string', context: 'server', access: 'secret', optional: true },
  // task/ws-jobs (workspaces-plan §9): the root under which job runs
  // persist their logs — /workspace/.cybermole/job-logs, a path that exists
  // in BOTH containers of the compose split (created by workspace-init;
  // see compose.yaml). Unset/empty keeps that default; the e2e suite and
  // dev shapes point it somewhere writable.
  CYBERMOLE_JOB_LOG_DIR: { type: 'string', context: 'server', access: 'secret', optional: true },
  // task/job-log-caps (jobs-agent-plan §8): the write-time cap on a job
  // run's log — the run wrapper pipes through a small bundled node
  // appender (src/lib/job-log-appender.ts) that stops writing past this
  // many bytes (one "[truncated at N bytes]" marker) while still draining
  // the job's output, so a chatty or runaway job cannot fill the disk
  // mid-run. Non-integer and negative values stop the server at boot
  // (env.ts), like the S3 vars.
  CYBERMOLE_JOB_LOG_MAX: { type: 'number', context: 'server', access: 'secret', default: 20971520 },
  // The command a new terminal tab runs (workspaces-plan §10),
  // whitespace-split by main.ts. Dynamic default in env.ts: a login
  // shell — $SHELL -l, /bin/sh -l when SHELL is unset.
  CYBERMOLE_COMMAND: { type: 'string', context: 'server', access: 'secret', optional: true },
  // task/defaults-settings: what the auto-opened FIRST terminal of a new
  // workspace runs (the agent slot; the /settings terminal-defaults form
  // writes a db override that wins over this). Dynamic default in env.ts:
  // the vendored pi binary when the install has one, else 'pi' on PATH.
  // Like CYBERMOLE_COMMAND, whitespace-split by the spawner.
  CYBERMOLE_AGENT_COMMAND: { type: 'string', context: 'server', access: 'secret', optional: true },
  CYBERMOLE_TMUX_CONF: { type: 'string', context: 'server', access: 'secret', optional: true },
  // task/jobs-socket (docs/jobs-agent-plan.md §3): the internal jobs
  // API's unix socket path. Unset = the shape default (env.ts
  // readInternalApiSocket: /run/cybermole/cybermole.sock when that shared dir
  // exists — the compose privilege-split shape — else <state
  // dir>/cybermole.sock). EMPTY = the listener is off (the workspace side
  // then has no jobs socket). A set-but-non-absolute value stops the
  // server at boot, like the S3 vars.
  CYBERMOLE_SOCK: { type: 'string', context: 'server', access: 'secret', optional: true },
  // task/winston-loki: log aggregation — push URL of a Grafana Loki (the
  // compose `observability` profile runs one; e.g. http://loki:3100).
  // Unset = console-only logging, byte-for-byte today's behaviour (env.ts
  // validates it at boot like the S3 vars — a set-but-malformed URL stops
  // the server).
  CYBERMOLE_LOKI_URL: { type: 'string', context: 'server', access: 'secret', optional: true },
  // task/winston-loki: the static `job` label every pushed log line carries
  // (identifies this deployment in Loki's stream selectors). Default in
  // env.ts: 'cybermole'.
  CYBERMOLE_LOKI_JOB: { type: 'string', context: 'server', access: 'secret', optional: true },
  // Object storage (src/lib/storage.ts) — any S3-compatible server; the
  // compose stack runs SeaweedFS. No endpoint = not configured (uploads
  // answer 503); an endpoint needs both keys — env.ts checks at boot.
  CYBERMOLE_S3_ENDPOINT: { type: 'string', context: 'server', access: 'secret', optional: true },
  CYBERMOLE_S3_ACCESS_KEY: { type: 'string', context: 'server', access: 'secret', optional: true },
  CYBERMOLE_S3_SECRET_KEY: { type: 'string', context: 'server', access: 'secret', optional: true },
  CYBERMOLE_S3_BUCKET: { type: 'string', context: 'server', access: 'secret', default: 'cybermole' },
  // SigV4 signs with a region; self-hosted servers accept any, us-east-1 is the convention.
  CYBERMOLE_S3_REGION: { type: 'string', context: 'server', access: 'secret', default: 'us-east-1' },
  // task/ws-editor (docs/editor-webapp.md): the VSCodium reh-web editor's
  // upstream on the compose network (e.g. http://editor:3000). THE single
  // switch — unset/empty = the editor is off: /editor/* answers 404 and the
  // console hides its affordances. Validated at boot (env.ts
  // readEditorUpstream) like the S3 vars: a malformed value stops the server.
  CYBERMOLE_EDITOR_UPSTREAM: { type: 'string', context: 'server', access: 'secret', optional: true },
} as const satisfies Record<string, ServerEnvField>;
