// Shared types across server + client (the WS wire protocol is
// described exactly once, on both ends).

import type {
  AppId,
  AppSlug,
  JobName,
  TerminalId,
  TmuxSessionName,
  WorkspaceId,
} from '@cybermole/app-kit';

// ---- GET /api/state: the workspace tree (workspaces-plan §5) ----

/** One app row, as the console's sidebar sees it. */
export interface AppState {
  id: AppId;
  name: string;
  slug: AppSlug;
  /** Where workspaces under this app start (task/app-cwd) — null = the
   *  server default (ConsoleState.defaultCwd): the new-workspace dialog's
   *  start-path hint and the create-side cwd derivation read it. */
  cwd: string | null;
  order: number;
}

/** AppState as GET /api/state serves it (task/app-web, apps-plan §4):
 *  the row + the serving join over the app host's /_admin/status — an
 *  ADDITIVE pair of fields (apps.listApps still answers the bare row
 *  shape everywhere else). serving=false dims the sidebar's open link,
 *  with servingReason as its tooltip (a dead host, or the host's own
 *  skip reason for a registered-but-unbuilt tree). */
export interface AppServingState extends AppState {
  serving: boolean;
  /** null when serving — the honest one-line story when not. */
  servingReason: string | null;
}

/** One terminal tab: its row + the live diff's answer (the `t-<uuid>`
 *  tmux session is present — plan §4/§5). */
export interface TerminalState {
  id: TerminalId;
  /** NULL → the tab bar labels it "term N". */
  title: string | null;
  order: number;
  live: boolean;
}

/** One workspace row with its terminals — flat with appId so the server
 *  read stays one query per table; grouping (console group first, then
 *  apps by order) is client-side in the sidebar. */
export interface WorkspaceState {
  id: WorkspaceId;
  /** null = the console group (the console is NOT an app row — plan §1). */
  appId: AppId | null;
  name: string;
  cwd: string;
  order: number;
  terminals: TerminalState[];
}

export interface ConsoleState {
  me: 'ok';
  configured: boolean;
  /** the editor webapp is configured (CYBERMOLE_EDITOR_UPSTREAM set — the
   *  same-origin `${BASE}/editor/` proxy, docs/guides/editor-webapp.md): false
   *  hides the editor tab (plan §8). */
  editor: boolean;
  /** CYBERMOLE_NEW_SESSION_CWD — prefills the new-workspace dialog (plan §10). */
  defaultCwd: string;
  /** task/app-web (apps-plan §4): each app row + the serving join (the
   *  app host ping) — additive fields on the row shape, clients may
   *  ignore them. */
  apps: AppServingState[];
  /** flat; the client groups by appId. */
  workspaces: WorkspaceState[];
}

// ---- scheduled jobs (in-process scheduler — see src/lib/jobs.ts) ----

export interface ScheduledJob {
  /** job name (run sessions: cybermole-<name> on the app's tmux socket) */
  name: JobName;
  /** 5-field cron (minute hour day-of-month month day-of-week) */
  schedule: string;
  /** shell command a run executes (inside tmux session cybermole-<name>) */
  command: string;
  /** the optional app tag — display grouping only, never ownership:
   *  cwd/env stay global and runs stay cybermole-<name> sessions (plan §9) */
  appId: AppId | null;
  /** the tagged app's display name (listJobs' LEFT JOIN; null when untagged) */
  appName: string | null;
  /** schedule armed and parses (false only for a hand-edited db row) */
  active: boolean;
  /** the run's tmux session is alive */
  running: boolean;
  /** tmux session name a run opens */
  session: TmuxSessionName;
  /** next fire from the cron schedule, local "YYYY-MM-DD HH:mm"; null when unknown */
  next: string | null;
  /** last recorded fire, same format; null when never */
  last: string | null;
  /** outcome of the last run — 'unknown': a run's exit code lives inside
   *  tmux, where the scheduler can't see it (the old systemd backend got
   *  this from the unit's Result) */
  lastResult: 'success' | 'failed' | 'unknown';
}

export interface JobsState {
  /** always true since scheduling moved in-process (kept for wire compat:
   *  the scheduler runs wherever the server does, container included) */
  available: boolean;
  /** probe detail — always null now */
  detail: string | null;
  jobs: ScheduledJob[];
}

export interface CalendarCheck {
  valid: boolean;
  /** next fire on success, local "YYYY-MM-DD HH:mm" */
  next: string | null;
  error: string | null;
  /** 'cron-parser' when the real parser accepted it (it always runs —
   *  no absent-binary fallback anymore) */
  validatedBy: 'cron-parser';
}

// ---- settings dashboard (/settings ← /api/settings; /api/update-pi) ----
/** Outcome of the most recent pi auto-update CHECK (persisted in the state
 *  db; src/lib/auto-update.ts). The check runs daily while the setting is
 *  ON — see SettingsState.piAutoUpdate. */
export interface AutoUpdateCheck {
  /** epoch ms of the check */
  at: number;
  /** 'up-to-date': nothing to do — the newest in range is installed, the
   *  installed pi sits ABOVE the range (manual @latest), or its version
   *  doesn't compare; 'installed': a newer pi within the declared range
   *  was installed by this check; 'failed': the check or the install
   *  failed — in every ambiguous case `detail` says which */
  outcome: 'up-to-date' | 'installed' | 'failed';
  /** human-readable summary for the settings page status line */
  detail: string;
}

/** Outcome of the most recent pi auto-update INSTALL (a successful check
 *  that found nothing to do leaves the previous entry alone). */
export interface AutoUpdateResult {
  at: number;
  ok: boolean;
  before: string | null;
  after: string | null;
  detail: string;
  /** capped npm output tail, shown on /settings */
  output: string;
}

// Effective (resolved, defaults applied) config for the read-only dashboard.
// Paths only — never credential or hash contents.
export interface SettingsState {
  me: 'ok';
  appVersion: string;
  nodeVersion: string;
  host: string;
  port: number;
  base: string;
  command: string;
  newSessionCwd: string;
  agentDir: string;
  stateDb: string;
  tmuxSocket: string;
  tmuxConf: string | null;
  appRoot: string;
  piPackage: string;
  piDeclared: string;
  piInstalled: string | null;
  npmAvailable: boolean;
  /** the terminal defaults (task/defaults-settings) — resolved like the
   *  spawner resolves them (db ?? env ?? built-in, src/lib/
   *  terminal-defaults.ts), so the /settings form prefills what a new
   *  tab would actually run. `command` above is shellCommand (kept as
   *  its own field: the configuration card's "terminal command" row). */
  terminalDefaults: TerminalDefaults;
  /** the pi auto-update setting (toggle + status lines on /settings) */
  piAutoUpdate: {
    enabled: boolean;
    lastCheck: AutoUpdateCheck | null;
    lastUpdate: AutoUpdateResult | null;
  };
}

/** The terminal defaults (task/defaults-settings): the two commands a
 *  new terminal can run, RESOLVED (db override ?? env ?? built-in — the
 *  effective value, never the raw db value) plus whether each carries a
 *  db override (the /settings reset affordance clears it). */
export interface TerminalDefaults {
  /** what the auto-opened FIRST terminal of a new workspace runs */
  agentCommand: string;
  /** what every other new terminal tab runs */
  shellCommand: string;
  /** a db override is stored for the agent command (reset clears it) */
  agentOverridden: boolean;
  /** ditto, the shell command */
  shellOverridden: boolean;
}

/** Result of POST /api/update-pi (manual `npm install pi@latest`). */
export interface UpdateResult {
  ok: boolean;
  dryRun: boolean;
  /** what ran / would run, for display */
  command: string;
  /** installed pi version before (null: not installed) */
  before: string | null;
  /** installed pi version after */
  after: string | null;
  /** captured npm output (dry-run: check output), capped */
  output: string;
  /** failure reason when !ok */
  error?: string;
}

// ---- WS wire protocol (JSON envelopes) ----
// Client frames: schemas, parseClientMsg and the z.infer'd ClientMsg live
// in src/schemas/frames.ts (node-free, described exactly once). ServerMsg
// (below) stays a hand-written union: it is server→client only and never
// parsed.
export type { ClientMsg } from '../schemas/frames';

export type ServerMsg =
  | { type: 'attached'; target: TmuxSessionName; socket: string }
  | { type: 'output'; data: string }
  /** scrollback history captured at attach (tmux.ts capturePaneHistory):
   *  HISTORY ONLY, sent once per attach BEFORE any 'output' flows — the
   *  client writes it into the (fresh) buffer and pushes the viewport
   *  down so tmux's home-positioned attach redraw repaints the screen
   *  below it instead of over it. Skipped when there is no history. */
  | { type: 'backfill'; data: string }
  | { type: 'exit'; target: TmuxSessionName }
  | { type: 'error'; message: string }
  /** the session token this socket authenticated with was dropped
   *  (logout / log out everywhere) — the terminal must not reconnect */
  | { type: 'signed-out' }
  /** the server is shutting down (SIGTERM/SIGINT) — reconnectable:
   *  unlike 'exit'/'error' the client reattaches with its usual backoff */
  | { type: 'restart' };

/** Which terminal target the console has selected (sidebar highlight +
 *  reconnect key): a terminal tab (its row's uuid) or a job run (its live
 *  tmux session name) — the live:/resume: variants died with the
 *  pi-session UI (workspaces-plan §11). */
export type ActiveKey = `terminal:${TerminalId}` | `run:${TmuxSessionName}`;
