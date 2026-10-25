// Everything stateful the Astro side may use, built once by server/main.ts
// and passed in `locals`. Only main.ts imports this at runtime; Astro code
// imports types only. Vite would otherwise bundle a second copy of each
// module's state (a second Scheduler ticking, a second StateDb connection,
// a second pi-update busy flag racing npm).
import * as fs from 'node:fs';
import type { Auth } from './auth';
import type { AutoUpdater } from './auto-update';
import { autoUpdateEnabled, lastCheck, lastUpdate } from './auto-update';
import type { StateDb } from './db';
import { APP_ROOT } from './env';
import { checkCron, type Scheduler } from '../jobs/jobs';
import { Apps } from '../apps/apps';
import { Workspaces } from '../terminals/workspaces';
import type { ObjectStore } from './storage';
import {
  PI_PACKAGE,
  appVersion,
  npmPath,
  piDeclared,
  piInstalled,
  runPiUpdate,
  type PiUpdateResult,
} from './settings';
import {
  resolvedAgentCommand,
  resolvedShellCommand,
  saveTerminalDefaults,
  terminalDefaults,
  type SaveTerminalDefaultsResult,
} from '../terminals/terminal-defaults';
import * as tmux from '../terminals/tmux';
import type { AppsServing } from '../apps/apps-serving';
import { joinServing } from '../apps/apps-serving';
import type { EditorUpstream } from '../terminals/editor';
import type { CalendarCheck, ConsoleState, SettingsState } from './types';
import type {
  ResultFailure,
  ResultSuccess,
  SessionToken,
  TmuxSessionName,
} from '@cybermole/app-kit';
import type { TmuxSessionFailure, TmuxSessionSuccess } from '../terminals/tmux';

export type ConsoleStateErrorCode = 'database_error';
export type ConsoleStateSuccess = ResultSuccess<'console_state', ConsoleState>;
export type ConsoleStateFailure = ResultFailure<
  'console_state',
  ConsoleState,
  ConsoleStateErrorCode
>;
export type ConsoleStateResult = ConsoleStateSuccess | ConsoleStateFailure;

/** database_error is shown as an error, never as "off" or "never checked". */
export type SettingsStateErrorCode = 'database_error';
export type SettingsStateSuccess = ResultSuccess<'settings_state', SettingsState>;
export type SettingsStateFailure = ResultFailure<
  'settings_state',
  SettingsState,
  SettingsStateErrorCode
>;
export type SettingsStateResult = SettingsStateSuccess | SettingsStateFailure;

export interface ServerConfig {
  host: string;
  port: number;
  /** '/' or '/foo', no trailing slash */
  base: string;
  home: string;
  agentDir: string;
  dbFile: string;
  clientDir: string;
  astroEntry: string;
  newSessionCwd: string;
  jobLogDir: string;
  // Terminal commands aren't here: they resolve per spawn so /settings applies without a restart.
  trustProxy: number;
  /** null hides the console's editor affordances. */
  editorUpstream: EditorUpstream | null;
  /** Built at boot so the page only reads a string; null hides /logs. */
  grafanaExploreUrl: string | null;
}

export interface CybermoleServices {
  cfg: ServerConfig;
  auth: Auth;
  scheduler: Scheduler;
  autoUpdater: AutoUpdater;
  objectStore: ObjectStore;
  apps: Apps;
  workspaces: Workspaces;
  /** GET /api/state */
  consoleState(): Promise<ConsoleStateResult>;
  /** GET /api/settings: paths and versions, never credentials. */
  settingsState(): SettingsStateResult;
  /** POST /api/settings: a string sets an override, null clears, absent keeps. */
  saveTerminalDefaults(input: {
    agentCommand?: string | null;
    shellCommand?: string | null;
  }): SaveTerminalDefaultsResult;
  /** Shares runPiUpdate's busy guard with the auto-updater. */
  runPiUpdate(dryRun: boolean): Promise<PiUpdateResult>;
  /** Here so routes never import jobs.ts. */
  checkCron(schedule: string): CalendarCheck;
}

/** Only passed on the authenticated path; middleware.ts fails closed without it. */
export interface CybermoleLocals {
  cybermole?: CybermoleServices;
  session?: SessionToken;
}

export interface ServiceDeps {
  cfg: ServerConfig;
  stateDb: StateDb;
  auth: Auth;
  scheduler: Scheduler;
  autoUpdater: AutoUpdater;
  objectStore: ObjectStore;
  /** Injected so the domains are testable without tmux. */
  killSession: (name: TmuxSessionName) => Promise<boolean>;
  spawnSession: (
    name: TmuxSessionName,
    cwd: string,
    command: string[],
  ) => Promise<TmuxSessionSuccess | TmuxSessionFailure>;
  liveSessionNames: () => Promise<Set<TmuxSessionName>>;
  /** Off or dead app host degrades to serving:false. */
  appsServing: Pick<AppsServing, 'info'>;
}

export function createServices(deps: ServiceDeps): CybermoleServices {
  const { cfg, stateDb, auth, scheduler, autoUpdater, objectStore } = deps;
  const apps = new Apps({
    db: stateDb,
    username: () => auth.username(),
    killSession: deps.killSession,
  });
  const workspaces = new Workspaces({
    db: stateDb,
    username: () => auth.username(),
    killSession: deps.killSession,
    defaultCwd: cfg.newSessionCwd,
    spawnSession: deps.spawnSession,
    liveSessionNames: deps.liveSessionNames,
    // Read per spawn so /settings applies to the next tab.
    shellCommand: () => resolvedShellCommand(stateDb),
    agentCommand: () => resolvedAgentCommand(stateDb),
  });
  return {
    cfg,
    auth,
    scheduler,
    autoUpdater,
    objectStore,
    apps,
    workspaces,

    async consoleState() {
      const fail = (errorMessage: string) =>
        ({
          ok: false,
          resultType: 'console_state',
          errorCode: 'database_error',
          errorMessage,
        }) satisfies ConsoleStateFailure;
      const configured = auth.configured();
      if (!configured.ok) return fail(configured.errorMessage ?? 'could not read the credential');
      const listed = apps.listApps();
      if (!listed.ok) return fail(listed.errorMessage ?? 'could not read apps');
      // A dead or off app host degrades to serving:false rows, never a failed read.
      const servingInfo = await deps.appsServing.info();
      const tree = await workspaces.workspaceTree();
      if (!tree.ok) return fail(tree.errorMessage ?? 'could not read workspaces');
      return {
        ok: true,
        resultType: 'console_state',
        data: {
          me: 'ok',
          configured: configured.data.value,
          editor: cfg.editorUpstream !== null,
          defaultCwd: cfg.newSessionCwd,
          apps: joinServing(listed.data.apps, servingInfo),
          workspaces: tree.data.workspaces,
        },
      } satisfies ConsoleStateSuccess;
    },

    settingsState() {
      const fail = (errorMessage: string) =>
        ({
          ok: false,
          resultType: 'settings_state',
          errorCode: 'database_error',
          errorMessage,
        }) satisfies SettingsStateFailure;
      const enabled = autoUpdateEnabled(stateDb);
      if (!enabled.ok) return fail(enabled.errorMessage);
      const checked = lastCheck(stateDb);
      if (!checked.ok) return fail(checked.errorMessage);
      const updated = lastUpdate(stateDb);
      if (!updated.ok) return fail(updated.errorMessage);
      const defaults = terminalDefaults(stateDb);
      if (!defaults.ok)
        return fail(defaults.errorMessage ?? 'could not read the terminal defaults');
      return {
        ok: true,
        resultType: 'settings_state',
        data: {
          me: 'ok',
          appVersion: appVersion(APP_ROOT),
          nodeVersion: process.version,
          host: cfg.host,
          port: cfg.port,
          base: cfg.base,
          command: defaults.data.shellCommand,
          newSessionCwd: cfg.newSessionCwd,
          agentDir: cfg.agentDir,
          stateDb: cfg.dbFile,
          tmuxSocket: tmux.SOCKET,
          tmuxConf: fs.existsSync(tmux.CONF) ? tmux.CONF : null,
          appRoot: APP_ROOT,
          piPackage: PI_PACKAGE,
          piDeclared: piDeclared(APP_ROOT),
          piInstalled: piInstalled(APP_ROOT),
          npmAvailable: npmPath() !== null,
          terminalDefaults: defaults.data,
          piAutoUpdate: {
            enabled: enabled.data.value,
            lastCheck: checked.data.value,
            lastUpdate: updated.data.value,
          },
        },
      } satisfies SettingsStateSuccess;
    },

    saveTerminalDefaults: input => saveTerminalDefaults(stateDb, input),

    runPiUpdate: dryRun => runPiUpdate(APP_ROOT, dryRun),
    checkCron: schedule => checkCron(schedule),
  };
}
