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
import { APP_ROOT } from './env';
import type { HiddenSessions } from './hidden-sessions';
import { checkCron, type Scheduler } from './jobs';
import { listSessions } from './sessions';
import type { ObjectStore } from './storage';
import {
  PI_PACKAGE, appVersion, npmPath, piDeclared, piInstalled, runPiUpdate, type PiUpdateResult,
} from './settings';
import * as tmux from './tmux';
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
}

export interface WebPiServices {
  cfg: ServerConfig;
  auth: Auth;
  hiddenSessions: HiddenSessions;
  scheduler: Scheduler;
  autoUpdater: AutoUpdater;
  /** Object storage (S3-compatible): POST /api/files stores uploads here. */
  objectStore: ObjectStore;
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
}

export function createServices(deps: ServiceDeps): WebPiServices {
  const { cfg, stateDb, auth, hiddenSessions, scheduler, autoUpdater, objectStore, sessionEnv } = deps;
  return {
    cfg, auth, hiddenSessions, scheduler, autoUpdater, objectStore,

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
    checkCron: schedule => checkCron(schedule),
  };
}
