// services.ts — everything stateful the Astro side may use, as ONE object
// server/main.ts builds once and hands to the Astro handler in `locals`
// (docs/CODE_STYLE.md §6).
//
// RUNTIME-IMPORTED ONLY BY server/main.ts. Astro code (routes, pages,
// middleware) imports this module's TYPES only. Vite bundles its own copy
// of any src/lib module the Astro side runtime-imports, and with it a
// second copy of that module's state: a second Scheduler with its own tick
// loop, a second runPiUpdate busy flag would let a manual and an
// automatic update race npm, a second StateDb would hold its own sqlite
// connection, a second sessions title cache would rescan. Reaching state
// through locals.webpi keeps exactly one of each.
import * as fs from 'node:fs';
import type { Auth } from './auth';
import type { AutoUpdater } from './auto-update';
import { autoUpdateEnabled, lastCheck, lastUpdate } from './auto-update';
import type { StateDb } from './db';
import { APP_ROOT, MANAGEMENT_CHECKOUT, RELEASES_DIR } from './env';
import type { HiddenSessions } from './hidden-sessions';
import { checkCron, type Scheduler } from './jobs';
import { Apps } from './apps';
import { Workspaces } from './workspaces';
import { Releases } from './releases';
import { listSessions } from './sessions';
import type { ObjectStore } from './storage';
import {
  PI_PACKAGE, appVersion, npmPath, piDeclared, piInstalled, runPiUpdate, type PiUpdateResult,
} from './settings';
import * as tmux from './tmux';
import { openInZed, type ZedLaunchConfig, type ZedOpenResult } from './zed';
import type { CalendarCheck, ConsoleState, SettingsState } from './types';
import type { SessionToken, TmuxSessionName } from '../types/branded';
import type { ResultFailure, ResultSuccess } from '../types/result';

/** database_error: the hidden-session overlay or the credential row could
 *  not be read (the session scan and the tmux list can't fail by design). */
export type ConsoleStateErrorCode = 'database_error';
export type ConsoleStateSuccess = ResultSuccess<'console_state', ConsoleState>;
export type ConsoleStateFailure = ResultFailure<'console_state', ConsoleState, ConsoleStateErrorCode>;
export type ConsoleStateResult = ConsoleStateSuccess | ConsoleStateFailure;

/** database_error: the auto-update setting or its last outcomes could not
 *  be read (shown as an error, never as "off" / "never checked"). */
export type SettingsStateErrorCode = 'database_error';
export type SettingsStateSuccess = ResultSuccess<'settings_state', SettingsState>;
export type SettingsStateFailure = ResultFailure<'settings_state', SettingsState, SettingsStateErrorCode>;
export type SettingsStateResult = SettingsStateSuccess | SettingsStateFailure;

/** The resolved server configuration (server/main.ts's CFG). */
export interface ServerConfig {
  host: string;
  port: number;
  /** URL base path: '/' or '/foo' (no trailing slash) */
  base: string;
  home: string;
  agentDir: string;
  dbFile: string;
  clientDir: string;
  astroEntry: string;
  sessionsDir: string;
  newSessionCwd: string;
  /** whitespace-split session command line */
  command: string[];
  trustProxy: number;
  /** Zed webapp wiring (docs/zed-webapp.md), or null when not configured
   *  — the console then hides its Zed affordances. */
  zed: ZedLaunchConfig | null;
}

export interface WebPiServices {
  cfg: ServerConfig;
  auth: Auth;
  hiddenSessions: HiddenSessions;
  scheduler: Scheduler;
  autoUpdater: AutoUpdater;
  /** Object storage (S3-compatible): POST /api/files stores uploads here. */
  objectStore: ObjectStore;
  // task/mgmt-page: the management page's service — enforcement, git
  // reads, release bookkeeping, the swap (docs/management-page.md).
  management: Releases;
  // task/ws-schema (docs/workspaces-plan.md §3): the app and
  // workspace/terminal domains, constructed once here and reached by the
  // /api/apps, /api/workspaces, /api/terminals routes.
  /** The app domain — apps.ts. */
  apps: Apps;
  /** The workspace/terminal domain — workspaces.ts. */
  workspaces: Workspaces;
  /** GET /api/state's body: pi's session store (title-cached scan) +
   *  the live tmux list + hidden flags. */
  consoleState(): Promise<ConsoleStateResult>;
  /** GET /api/settings' body: paths and versions only — no credential
   *  or hash contents ever leave. */
  settingsState(): SettingsStateResult;
  /** The manual pi updater — shares runPiUpdate's busy guard with the
   *  auto-updater, which is why it lives here. */
  runPiUpdate(dryRun: boolean): Promise<PiUpdateResult>;
  /** Start a new interactive session running the configured command. */
  newSession(name: TmuxSessionName): Promise<tmux.TmuxSessionSuccess | tmux.TmuxSessionFailure>;
  /** Open a directory in the Zed webapp (POST from the console's
   *  "open in Zed" affordances; src/lib/zed.ts). */
  openInZed(path: string): Promise<ZedOpenResult>;
  /** Validate a 5-field cron schedule (pure; here so routes never import jobs.ts). */
  checkCron(schedule: string): CalendarCheck;
}

/** What server/main.ts passes the Astro handler on the authenticated path
 *  — and only there: src/middleware.ts fails closed when it is missing.
 *  (App.Locals in src/env.d.ts declares the same fields.) */
export interface WebPiLocals {
  webpi?: WebPiServices;
  /** the session token this request authenticated with */
  session?: SessionToken;
}

export interface ServiceDeps {
  cfg: ServerConfig;
  stateDb: StateDb;
  auth: Auth;
  hiddenSessions: HiddenSessions;
  scheduler: Scheduler;
  autoUpdater: AutoUpdater;
  objectStore: ObjectStore;
  /** env for processes spawned inside tmux sessions (pi) */
  sessionEnv: Record<string, string>;
  /** Best-effort tmux kill of one session (tmux.killSession) — the
   *  terminal/app/workspace deletes; injected so the domains stay
   * unit-testable without a tmux server. */
  killSession: (name: TmuxSessionName) => Promise<boolean>;
  // task/mgmt-page: graceful-restart trigger for the swap step (the
  // server's own shutdown path — no docker socket anywhere), and the
  // LIVE snapshot of what this process serves (a GETTER: main.ts falls
  // back to the image copy if a release's SSR entry fails to load at
  // boot, and the "serving now" card must report the fallback).
  requestRestart: () => void;
  bootServing: () => { kind: 'image' | 'release'; sha: string | null };
}

export function createServices(deps: ServiceDeps): WebPiServices {
  const { cfg, stateDb, auth, hiddenSessions, scheduler, autoUpdater, objectStore, sessionEnv, requestRestart } = deps;
  // task/mgmt-page: the management page's domain service. Its verify
  // callback is auth.verify (re-auth for the dangerous verbs); its
  // requestRestart is main.ts's own shutdown path.
  const management = new Releases({
    db: stateDb,
    checkout: MANAGEMENT_CHECKOUT,
    releasesDir: RELEASES_DIR,
    appRoot: APP_ROOT,
    bootServing: deps.bootServing,
    requestRestart,
    verify: (username, password) => auth.verify(username, password),
  });
  // task/ws-schema: the app + workspace domains. The username dep reads
  // the credential row through Auth (created_by/updated_by — plan §2);
  // killSession is main.ts's tmux.killSession; defaultCwd is
  // WEB_PI_NEW_SESSION_CWD (POST /api/workspaces' cwd default — plan §6).
  const apps = new Apps({ db: stateDb, username: () => auth.username(), killSession: deps.killSession });
  const workspaces = new Workspaces({
    db: stateDb, username: () => auth.username(), killSession: deps.killSession,
    defaultCwd: cfg.newSessionCwd, sessionEnv,
  });
  return {
    cfg, auth, hiddenSessions, scheduler, autoUpdater, objectStore, management, apps, workspaces,

    async consoleState() {
      // Both scans are async (and the session scan title-cached), so the
      // 15 s poll every open tab makes never holds the event loop.
      const sessions = await listSessions(cfg.sessionsDir);
      const live = await tmux.listSessions();
      const fail = (errorMessage: string) =>
        ({ ok: false, resultType: 'console_state', errorCode: 'database_error', errorMessage }) satisfies ConsoleStateFailure;
      const hidden = hiddenSessions.hiddenIds();
      if (!hidden.ok) return fail(hidden.errorMessage);
      const configured = auth.configured();
      if (!configured.ok) return fail(configured.errorMessage);
      return {
        ok: true, resultType: 'console_state',
        data: {
          me: 'ok',
          configured: configured.data.value,
          live,
          sessions: sessions.map(s => ({ ...s, hidden: hidden.data.value.has(s.id) })),
          hiddenCount: hidden.data.value.size,
          zed: cfg.zed === null ? null : { url: cfg.zed.url },
        },
      } satisfies ConsoleStateSuccess;
    },

    settingsState() {
      const fail = (errorMessage: string) =>
        ({ ok: false, resultType: 'settings_state', errorCode: 'database_error', errorMessage }) satisfies SettingsStateFailure;
      const enabled = autoUpdateEnabled(stateDb);
      if (!enabled.ok) return fail(enabled.errorMessage);
      const checked = lastCheck(stateDb);
      if (!checked.ok) return fail(checked.errorMessage);
      const updated = lastUpdate(stateDb);
      if (!updated.ok) return fail(updated.errorMessage);
      return { ok: true, resultType: 'settings_state', data: {
        me: 'ok',
        appVersion: appVersion(APP_ROOT),
        nodeVersion: process.version,
        host: cfg.host,
        port: cfg.port,
        base: cfg.base,
        command: cfg.command.join(' '),
        newSessionCwd: cfg.newSessionCwd,
        agentDir: cfg.agentDir,
        sessionsDir: cfg.sessionsDir,
        stateDb: cfg.dbFile,
        tmuxSocket: tmux.SOCKET,
        tmuxConf: fs.existsSync(tmux.CONF) ? tmux.CONF : null,
        appRoot: APP_ROOT,
        piPackage: PI_PACKAGE,
        piDeclared: piDeclared(APP_ROOT),
        piInstalled: piInstalled(APP_ROOT),
        npmAvailable: npmPath() !== null,
        piAutoUpdate: {
          enabled: enabled.data.value,
          lastCheck: checked.data.value,
          lastUpdate: updated.data.value,
        },
      } } satisfies SettingsStateSuccess;
    },

    runPiUpdate: dryRun => runPiUpdate(APP_ROOT, dryRun),
    newSession: name => tmux.newSession(name, cfg.newSessionCwd, cfg.command, sessionEnv),
    openInZed: path => openInZed(cfg.zed, path),
    checkCron: schedule => checkCron(schedule),
  };
}
