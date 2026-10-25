// services.ts — everything stateful the Astro side may use, as ONE object
// server/main.ts builds once and hands to the Astro handler in `locals`
// (docs/conventions/CODE_STYLE.md §6).
//
// RUNTIME-IMPORTED ONLY BY server/main.ts. Astro code (routes, pages,
// middleware) imports this module's TYPES only. Vite bundles its own copy
// of any src/lib module the Astro side runtime-imports, and with it a
// second copy of that module's state: a second Scheduler with its own tick
// loop, a second runPiUpdate busy flag would let a manual and an
// automatic update race npm, a second StateDb would hold its own sqlite
// connection, a second sessions title cache would rescan. Reaching state
// through locals.cybermole keeps exactly one of each.
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

/** database_error: a state read behind the console's poll (the apps /
 *  workspace tree or the credential row) could not be served. */
export type ConsoleStateErrorCode = 'database_error';
export type ConsoleStateSuccess = ResultSuccess<'console_state', ConsoleState>;
export type ConsoleStateFailure = ResultFailure<
  'console_state',
  ConsoleState,
  ConsoleStateErrorCode
>;
export type ConsoleStateResult = ConsoleStateSuccess | ConsoleStateFailure;

/** database_error: the auto-update setting or its last outcomes could not
 *  be read (shown as an error, never as "off" / "never checked"). */
export type SettingsStateErrorCode = 'database_error';
export type SettingsStateSuccess = ResultSuccess<'settings_state', SettingsState>;
export type SettingsStateFailure = ResultFailure<
  'settings_state',
  SettingsState,
  SettingsStateErrorCode
>;
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
  newSessionCwd: string;
  /** task/ws-jobs (plan §9): job runs' persisted-log root
   *  (CYBERMOLE_JOB_LOG_DIR; /workspace/.cybermole/job-logs by default). */
  jobLogDir: string;
  /** The terminal commands are NOT here on purpose (task/defaults-settings):
   *  they resolve db override ?? env at SPAWN time
   *  (src/lib/terminals/terminal-defaults.ts), never at boot — a /settings save
   *  applies without a restart, which a boot-time CFG string cannot. */
  trustProxy: number;
  /** The editor webapp's upstream (CYBERMOLE_EDITOR_UPSTREAM, docs/
   *  editor-webapp.md), or null when not configured — the console then
   *  hides its editor affordances. */
  editorUpstream: EditorUpstream | null;
  /** task/logs-page: the fully-built Grafana Explore URL the /logs page
   *  frames (grafanaExploreUrlFromEnv() over CYBERMOLE_GRAFANA_URL —
   *  src/lib/platform/grafana.ts), or null when not configured: the header link
   *  hides and /logs answers 404 (the editor-off pattern). Built at boot
   *  so the page only reads a string (src/lib stays out of the Vite
   *  bundle — CODE_STYLE §6). */
  grafanaExploreUrl: string | null;
}

export interface CybermoleServices {
  cfg: ServerConfig;
  auth: Auth;
  scheduler: Scheduler;
  autoUpdater: AutoUpdater;
  /** Object storage (S3-compatible): POST /api/files stores uploads here. */
  objectStore: ObjectStore;
  // task/ws-schema (docs/plans/workspaces-plan.md §3): the app and
  // workspace/terminal domains, constructed once here and reached by the
  // /api/apps, /api/workspaces, /api/terminals routes.
  /** The app domain — apps.ts. */
  apps: Apps;
  /** The workspace/terminal domain — workspaces.ts. */
  workspaces: Workspaces;
  /** GET /api/state's body: the workspace tree (apps + workspaces +
   *  terminals with live flags — plan §5). */
  consoleState(): Promise<ConsoleStateResult>;
  /** GET /api/settings' body: paths and versions only — no credential
   *  or hash contents ever leave. */
  settingsState(): SettingsStateResult;
  /** POST /api/settings' save (task/defaults-settings): the /settings
   *  terminal-defaults form — a string sets the db override, null clears
   *  it (reset to default), absent keeps; the answer is the effective
   *  pair (like settingsState resolves them). */
  saveTerminalDefaults(input: {
    agentCommand?: string | null;
    shellCommand?: string | null;
  }): SaveTerminalDefaultsResult;
  /** The manual pi updater — shares runPiUpdate's busy guard with the
   *  auto-updater, which is why it lives here. */
  runPiUpdate(dryRun: boolean): Promise<PiUpdateResult>;
  /** Validate a 5-field cron schedule (pure; here so routes never import jobs.ts). */
  checkCron(schedule: string): CalendarCheck;
}

/** What server/main.ts passes the Astro handler on the authenticated path
 *  — and only there: src/middleware.ts fails closed when it is missing.
 *  (App.Locals in src/env.d.ts declares the same fields.) */
export interface CybermoleLocals {
  cybermole?: CybermoleServices;
  /** the session token this request authenticated with */
  session?: SessionToken;
}

export interface ServiceDeps {
  cfg: ServerConfig;
  stateDb: StateDb;
  auth: Auth;
  scheduler: Scheduler;
  autoUpdater: AutoUpdater;
  objectStore: ObjectStore;
  /** Best-effort tmux kill of one session (tmux.killSession) — the
   *  terminal/app/workspace deletes; injected so the domains stay
   * unit-testable without a tmux server. */
  killSession: (name: TmuxSessionName) => Promise<boolean>;
  /** Start a terminal tab's tmux session (tmux.newSession with the
   *  configured command + sessionEnv — plan §4); injected into the
   *  workspaces domain for the same testability reason as killSession. */
  spawnSession: (
    name: TmuxSessionName,
    cwd: string,
    command: string[],
  ) => Promise<TmuxSessionSuccess | TmuxSessionFailure>;
  /** Live tmux session names (tmux.liveSessionNames) — /api/state's live
   *  diff, injected into the workspaces domain like its siblings. */
  liveSessionNames: () => Promise<Set<TmuxSessionName>>;
  /** task/app-web (apps-plan §4): /api/state's per-app serving join —
   *  main.ts builds the AppsServing over the resolved apps socket (or
   *  the instance answers serving:false with the surface-off reason
   *  when CYBERMOLE_APPS_SOCK is empty) and hands it here;
   *  consoleState() joins its snapshot onto the app rows. */
  appsServing: Pick<AppsServing, 'info'>;
}

export function createServices(deps: ServiceDeps): CybermoleServices {
  const { cfg, stateDb, auth, scheduler, autoUpdater, objectStore } = deps;
  // task/ws-schema: the app + workspace domains. The username dep reads
  // the credential row through Auth (created_by/updated_by — plan §2);
  // killSession is main.ts's tmux.killSession; defaultCwd is
  // CYBERMOLE_NEW_SESSION_CWD (POST /api/workspaces' cwd default — plan §6).
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
    // task/defaults-settings: the resolved terminal commands, read per
    //  spawn (db override ?? env — src/lib/terminals/terminal-defaults.ts) so a
    //  /settings save applies to the next tab with no restart.
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
      // The workspace tree (plan §5): apps + workspaces + terminals, the
      // live flags diffed against tmux's session-name set inside the
      // workspaces domain. Grouping is client-side — the reads stay one
      // query per table.
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
      // task/app-web (apps-plan §4): the serving join — one bounded host
      // ping per poll window (apps-serving.ts); a dead or off surface
      // degrades to serving:false rows, never a failed state read.
      const servingInfo = await deps.appsServing.info();
      const tree = await workspaces.workspaceTree();
      if (!tree.ok) return fail(tree.errorMessage ?? 'could not read workspaces');
      return {
        ok: true,
        resultType: 'console_state',
        data: {
          me: 'ok',
          configured: configured.data.value,
          // task/ws-editor (docs/guides/editor-webapp.md): the same-origin editor
          // (CYBERMOLE_EDITOR_UPSTREAM set?) — false hides the editor tab.
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
      // task/defaults-settings: the terminal defaults resolve here too (db
      // ?? env — never a boot-time snapshot), so the /settings form
      // prefills what the NEXT tab would actually run.
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
          // The shell a new tab runs — the EFFECTIVE command now
          // (task/defaults-settings), same value the form prefills; a db
          // override shows here the same as an env one always did.
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
