// Shared types across server + client (the WS wire protocol is
// described exactly once, on both ends).

import type { JobName, PiSessionId, TmuxSessionName } from '../types/branded';

export interface PastSession {
  /** pi session id (uuid) — resume target */
  id: PiSessionId;
  /** first-user-message preview */
  title: string;
  mtime: number;
  timestamp: string;
  cwd: string;
  /** hidden from the sidebar list (hide ≠ delete: reversible, file kept) */
  hidden?: boolean;
}

export interface LiveSession {
  name: TmuxSessionName;
  windows: number;
  created: string;
  attached: boolean;
  /** tmux socket name owning the session */
  socket: string;
  /** the session's active pane cwd (where a dive-in editor should open);
   *  null when tmux reports none (e.g. the pane is dying) */
  cwd: string | null;
}

export interface ConsoleState {
  me: 'ok';
  configured: boolean;
  live: LiveSession[];
  sessions: PastSession[];
  /** total ids in the hidden-sessions state file (may exceed the
   *  hidden ones inside `sessions`, which is capped like the list) */
  hiddenCount: number;
  /** the Zed webapp (docs/zed-webapp.md), or null when not configured:
   *  the console hides its "open in Zed" affordances without it. */
  zed: { url: string } | null;
}

// ---- scheduled jobs (in-process scheduler — see src/lib/jobs.ts) ----

export interface ScheduledJob {
  /** job name (run sessions: webpi-<name> on the app's tmux socket) */
  name: JobName;
  /** 5-field cron (minute hour day-of-month month day-of-week) */
  schedule: string;
  /** shell command a run executes (inside tmux session webpi-<name>) */
  command: string;
  /** schedule armed and parses (false only for a hand-edited db row) */
  active: boolean;
  /** the run's tmux session is alive (visible in Live) */
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
  sessionsDir: string;
  stateDb: string;
  tmuxSocket: string;
  tmuxConf: string | null;
  appRoot: string;
  piPackage: string;
  piDeclared: string;
  piInstalled: string | null;
  npmAvailable: boolean;
  /** the pi auto-update setting (toggle + status lines on /settings) */
  piAutoUpdate: {
    enabled: boolean;
    lastCheck: AutoUpdateCheck | null;
    lastUpdate: AutoUpdateResult | null;
  };
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
  | { type: 'exit'; target: TmuxSessionName }
  | { type: 'error'; message: string }
  /** the session token this socket authenticated with was dropped
   *  (logout / log out everywhere) — the terminal must not reconnect */
  | { type: 'signed-out' }
  /** the server is shutting down (SIGTERM/SIGINT) — reconnectable:
   *  unlike 'exit'/'error' the client reattaches with its usual backoff */
  | { type: 'restart' };

/** Which terminal target the console has selected: a live tmux session or
 *  a past pi session being resumed (sidebar highlight + reconnect key). */
export type ActiveKey = `live:${TmuxSessionName}` | `resume:${PiSessionId}`;
