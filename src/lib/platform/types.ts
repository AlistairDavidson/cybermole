// Types shared by server and client.

import type {
  AppId,
  AppSlug,
  JobName,
  TerminalId,
  TmuxSessionName,
  WorkspaceId,
} from '@cybermole/app-kit';
import type { JobWebhook } from '../jobs/notify';

// ---- GET /api/state ----

export interface AppState {
  id: AppId;
  name: string;
  slug: AppSlug;
  /** Where its workspaces start; null = the server default. */
  cwd: string | null;
  /** Vendored icon name (app-icons.ts) — effective, never null in state. */
  icon: string;
  order: number;
}

/** Plus the app host's serving status; serving=false dims the sidebar
 *  link, with servingReason as the tooltip. */
export interface AppServingState extends AppState {
  serving: boolean;
  servingReason: string | null;
}

/** live: its `t-<uuid>` tmux session exists. */
export interface TerminalState {
  id: TerminalId;
  /** null → labelled "term N". */
  title: string | null;
  order: number;
  live: boolean;
}

/** Flat with appId; the sidebar groups client-side. */
export interface WorkspaceState {
  id: WorkspaceId;
  /** null = the console group (the console isn't an app row). */
  appId: AppId | null;
  name: string;
  cwd: string;
  /** 'build' = a build session (framed at one app, root cwd); the client
   *  doesn't branch on it yet — it rides the state for app pages later. */
  kind: 'build' | null;
  order: number;
  terminals: TerminalState[];
}

export interface ConsoleState {
  me: 'ok';
  configured: boolean;
  /** CYBERMOLE_EDITOR_UPSTREAM is set; false hides the editor tab. */
  editor: boolean;
  /** CYBERMOLE_NEW_SESSION_CWD */
  defaultCwd: string;
  apps: AppServingState[];
  workspaces: WorkspaceState[];
}

// ---- scheduled jobs ----

export interface ScheduledJob {
  name: JobName;
  /** 5-field cron */
  schedule: string;
  command: string;
  /** Display grouping only: cwd, env and session names stay global. */
  appId: AppId | null;
  /** null when untagged */
  appName: string | null;
  /** false only when a hand-edited schedule doesn't parse */
  active: boolean;
  running: boolean;
  session: TmuxSessionName;
  /** local "YYYY-MM-DD HH:mm"; null when unknown */
  next: string | null;
  /** last recorded fire, same format; null when never */
  last: string | null;
  /** 'unknown' until the finish is observed with a readable exit file */
  lastResult: 'success' | 'failed' | 'unknown';
}

export interface JobsState {
  /** always true; kept for wire compatibility */
  available: boolean;
  /** always null */
  detail: string | null;
  jobs: ScheduledJob[];
}

export interface CalendarCheck {
  valid: boolean;
  /** local "YYYY-MM-DD HH:mm" */
  next: string | null;
  error: string | null;
  validatedBy: 'cron-parser';
}

// ---- settings dashboard ----
export interface AutoUpdateCheck {
  /** epoch ms */
  at: number;
  /** 'up-to-date' also covers an installed pi above the declared range or
   *  an unparseable version; `detail` says which. */
  outcome: 'up-to-date' | 'installed' | 'failed';
  detail: string;
}

/** A check that found nothing to do leaves the previous entry alone. */
export interface AutoUpdateResult {
  at: number;
  ok: boolean;
  before: string | null;
  after: string | null;
  detail: string;
  /** capped npm output tail */
  output: string;
}

// Resolved config for the read-only dashboard: paths only, never secrets.
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
  /** `command` above duplicates shellCommand for the configuration card. */
  terminalDefaults: TerminalDefaults;
  /** Effective job-run webhook (null = off), db override → env → off. */
  jobWebhook: JobWebhook;
  piAutoUpdate: {
    enabled: boolean;
    lastCheck: AutoUpdateCheck | null;
    lastUpdate: AutoUpdateResult | null;
  };
}

/** Effective values (with defaults applied), plus whether a db override is set. */
export interface TerminalDefaults {
  /** the auto-opened first terminal of a new workspace */
  agentCommand: string;
  /** every other new tab */
  shellCommand: string;
  agentOverridden: boolean;
  shellOverridden: boolean;
}

/** POST /api/update-pi */
export interface UpdateResult {
  ok: boolean;
  dryRun: boolean;
  command: string;
  /** null: not installed */
  before: string | null;
  after: string | null;
  /** dry-run: the check output; capped */
  output: string;
  error?: string;
}

// ---- WS wire protocol ----
// ClientMsg, ServerMsg and ActiveKey live in @cybermole/app-kit
// (terminal-protocol.ts): one definition shared with the app pages'
// agent-console drawer client.
