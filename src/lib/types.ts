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
}

export interface ConsoleState {
  me: 'ok';
  configured: boolean;
  live: LiveSession[];
  sessions: PastSession[];
  /** total ids in the hidden-sessions state file (may exceed the
   *  hidden ones inside `sessions`, which is capped like the list) */
  hiddenCount: number;
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

// ---- management page (/management ← /api/management; docs/management-page.md) ----

/** The image identity baked at docker build (version.json at the app root). */
export interface ImageVersion {
  appVersion: string;
  /** full git sha, or 'unknown' when the image was built without GIT_SHA */
  git: string;
  /** ISO build time, null when not recorded */
  builtAt: string | null;
}

/** What the running process serves (the management page's headline). */
export interface ServingInfo {
  kind: 'image' | 'release';
  /** image facts — always shown; the rollback target */
  image: ImageVersion | null;
  /** the served release, when kind === 'release' */
  release: { sha: string; builtAt: number | null } | null;
}

/** Read-only facts about the workspace checkout (soft: git problems land
 *  in `error`, the card shows them instead of guessing). */
export interface CheckoutInfo {
  path: string;
  /** HEAD sha, null when unreadable */
  head: string | null;
  /** branch name, null on detached HEAD or unreadable */
  branch: string | null;
  /** changed + untracked file count (git status --porcelain), null when unknown */
  dirty: number | null;
  /** why the reads failed, null when fine */
  error: string | null;
}

/** One commit of the checkout, for the picker. */
export interface CommitEntry {
  /** full 40-hex sha — the apply target */
  sha: string;
  short: string;
  subject: string;
  author: string;
  /** ISO commit date */
  date: string;
}

/** One changed path in the dry-run verdict. */
export interface ChangedPath {
  path: string;
  status: 'A' | 'D' | 'M' | 'T';
  protectedPath: boolean;
}

/** The enforcement verdict (docs/management-page.md §1): computed
 *  server-side in protected code for the preview AND re-run before every
 *  dangerous verb — the page's display is a courtesy, never the check. */
export interface EnforcementVerdict {
  base: string;
  target: string;
  allowed: boolean;
  /** total judged changed paths (the carried list is capped for display) */
  changedCount: number;
  changed: ChangedPath[];
  /** protected paths that changed (never capped) — the refusal reason */
  protectedChanged: string[];
  /** each protected hit → the matching entry's rationale (the page shows
   *  it next to the path; an unparsable-path placeholder has none) */
  protectedWhy: Record<string, string>;
}

/** Build lifecycle as the markers + db record it (pending → building →
 *  built | failed). */
export type BuildStatus = 'none' | 'pending' | 'building' | 'built' | 'failed';

/** One release-history row (state db `releases` table). */
export interface ReleaseRecord {
  sha: string;
  status: 'requested' | 'built' | 'failed' | 'applied';
  requestedAt: number;
  builtAt: number | null;
  appliedAt: number | null;
  /** capped builder output tail */
  log: string | null;
  /** live marker status for a 'requested' row (absent otherwise) */
  live?: BuildStatus;
}

/** GET /api/management's body: everything the page renders. */
export interface ManagementState {
  me: 'ok';
  /** what this process resolved to serve at boot */
  serving: ServingInfo;
  /** what the NEXT boot will serve, when the pointer has moved past the
   *  boot snapshot (a written-but-not-yet-restarted activation) */
  nextBoot: { kind: 'release'; sha: string } | null;
  /** null when WEB_PI_MANAGEMENT_CHECKOUT is unset */
  checkout: CheckoutInfo | null;
  /** the releases volume mount; null = the swap half is off */
  releasesDir: string | null;
  /** newest first, capped */
  releases: ReleaseRecord[];
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
