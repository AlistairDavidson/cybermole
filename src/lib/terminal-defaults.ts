// terminal-defaults.ts — what a new terminal runs (task/defaults-settings):
// the shell command every new tab runs, and the agent command the FIRST
// tab of every NEW workspace auto-opens. Both resolve db override → env →
// built-in, AT SPAWN TIME (never cached), so a /settings save applies to
// the next tab with no restart:
//   shell — db ?? CYBERMOLE_COMMAND (itself a login shell by default —
//           $SHELL -l, /bin/sh -l fallback; env.ts)
//   agent — db ?? CYBERMOLE_AGENT_COMMAND ?? the vendored pi binary
//           (PI_BIN = <app root>/node_modules/.bin/pi, env.ts) when the
//           install has one ?? 'pi' on PATH. The vendored-pi step is why
//           a fresh install's workspaces open a working agent without
//           any wiring; the env var exists for compose shapes that run a
//           different agent, and as the e2e suite's deterministic
//           override.
// The overrides are strings in the state db's settings kv — keys owned by
// this module (like auto-update owns piAutoUpdate.*), so no schema
// migration — saved via POST /api/settings (services.saveTerminalDefaults)
// and surfaced on /settings through settingsState().terminalDefaults (the
// effective values — what a new tab would actually run — plus which
// fields carry an override, for the reset affordance).
import { qb, type StateDb } from './db';
import { databaseRead, databaseUpdate, type DatabaseReadResult } from '@cybermole/app-kit';
import { ENV } from './env';
import type { TerminalDefaults } from './types';
import type { ResultFailure, ResultSuccess } from '@cybermole/app-kit';

const KEY_AGENT = 'terminalDefaults.agentCommand';
const KEY_SHELL = 'terminalDefaults.shellCommand';

// ---------- the chain (pure — unit-tested) ----------

/** One link of the chain: a stored override wins, else the env value —
 *  which already carries its own built-in default (CYBERMOLE_COMMAND's
 *  $SHELL -l, the agent's vendored-pi step; both resolved in env.ts), so
 *  this is the ONLY conditional the chain needs. */
export function resolveCommand(override: string | null, envValue: string): string {
  return override ?? envValue;
}

/** Whitespace-split a command line into the argv the spawner runs — the
 *  exact semantics server/main.ts always applied to CYBERMOLE_COMMAND
 *  (now threaded through here so a db override splits identically):
 *  trim, split on whitespace runs, drop empty pieces. */
export function splitCommandLine(line: string): string[] {
  return line.trim().split(/\s+/).filter(Boolean);
}

/** The raw stored override — throws only when the db does (the
 *  databaseRead wrappers below turn that into database_error); a corrupt
 *  row (not JSON, not a string) reads as unset: data this module wrote,
 *  not a db failure — the auto-update parseJsonSetting stance. */
function readOverride(db: StateDb, key: string): string | null {
  const raw = db.getSetting(key);
  if (raw === null) return null;
  try {
    const v: unknown = JSON.parse(raw);
    return typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
}

/** The resolved agent command LINE (db ?? env ?? built-in) — what a new
 *  workspace's auto-opened first tab runs, and what that tab's respawn
 *  re-runs. splitCommandLine turns it into the spawn argv. */
export function resolvedAgentCommand(db: StateDb): DatabaseReadResult<string> {
  return databaseRead('could not read the agent command', () =>
    resolveCommand(readOverride(db, KEY_AGENT), ENV.CYBERMOLE_AGENT_COMMAND),
  );
}

/** The resolved shell command LINE (db ?? env ?? built-in) — what every
 *  new terminal tab EXCEPT the agent slot runs, and what such a tab's
 *  respawn re-runs. */
export function resolvedShellCommand(db: StateDb): DatabaseReadResult<string> {
  return databaseRead('could not read the shell command', () =>
    resolveCommand(readOverride(db, KEY_SHELL), ENV.CYBERMOLE_COMMAND),
  );
}

// ---------- the /settings read (settingsState embeds this) ----------

export type TerminalDefaultsErrorCode = 'database_error';
export type TerminalDefaultsSuccess = ResultSuccess<'terminal_defaults', TerminalDefaults>;
export type TerminalDefaultsFailure = ResultFailure<
  'terminal_defaults',
  TerminalDefaults,
  TerminalDefaultsErrorCode
>;
export type TerminalDefaultsResult = TerminalDefaultsSuccess | TerminalDefaultsFailure;

/** Both effective commands + which fields carry an override (the form
 *  prefills the effective values; the flags drive the reset affordance
 *  and the "override saved" status line). */
export function terminalDefaults(db: StateDb): TerminalDefaultsResult {
  const read = databaseRead('could not read the terminal defaults', () => {
    const agent = readOverride(db, KEY_AGENT);
    const shell = readOverride(db, KEY_SHELL);
    return {
      agentCommand: resolveCommand(agent, ENV.CYBERMOLE_AGENT_COMMAND),
      shellCommand: resolveCommand(shell, ENV.CYBERMOLE_COMMAND),
      agentOverridden: agent !== null,
      shellOverridden: shell !== null,
    } satisfies TerminalDefaults;
  });
  return read.ok
    ? { ok: true, resultType: 'terminal_defaults', data: read.data.value }
    : ({
        ok: false,
        resultType: 'terminal_defaults',
        errorCode: 'database_error',
        errorMessage: read.errorMessage,
      } satisfies TerminalDefaultsFailure);
}

// ---------- the save (POST /api/settings) ----------

export type SaveTerminalDefaultsData = TerminalDefaults;
export type SaveTerminalDefaultsErrorCode = 'database_error';
export type SaveTerminalDefaultsSuccess = ResultSuccess<
  'save_terminal_defaults',
  SaveTerminalDefaultsData
>;
export type SaveTerminalDefaultsFailure = ResultFailure<
  'save_terminal_defaults',
  SaveTerminalDefaultsData,
  SaveTerminalDefaultsErrorCode
>;
export type SaveTerminalDefaultsResult = SaveTerminalDefaultsSuccess | SaveTerminalDefaultsFailure;

/** Save the overrides. Per field: a string SETS the override (stored
 *  JSON-encoded like every settings value), null CLEARS it back to the
 *  default chain (the row is deleted — unset, never an empty-string
 *  override standing in for "default"), absent KEEPS the stored value.
 *  Returns the effective pair — the page re-renders its fields and flags
 *  from the server's own answer, never from what it sent. */
export function saveTerminalDefaults(
  db: StateDb,
  input: { agentCommand?: string | null; shellCommand?: string | null },
): SaveTerminalDefaultsResult {
  const write = (key: string, value: string | null) =>
    value === null
      ? databaseUpdate(`could not clear ${key}`, () =>
          db.run(qb.deleteFrom('settings').where('key', '=', key)),
        )
      : databaseUpdate(`could not save ${key}`, () => db.setSetting(key, JSON.stringify(value)));
  if (input.agentCommand !== undefined) {
    const saved = write(KEY_AGENT, input.agentCommand);
    if (!saved.ok)
      return {
        ok: false,
        resultType: 'save_terminal_defaults',
        errorCode: 'database_error',
        errorMessage: saved.errorMessage,
      } satisfies SaveTerminalDefaultsFailure;
  }
  if (input.shellCommand !== undefined) {
    const saved = write(KEY_SHELL, input.shellCommand);
    if (!saved.ok)
      return {
        ok: false,
        resultType: 'save_terminal_defaults',
        errorCode: 'database_error',
        errorMessage: saved.errorMessage,
      } satisfies SaveTerminalDefaultsFailure;
  }
  const after = terminalDefaults(db);
  if (!after.ok)
    return {
      ok: false,
      resultType: 'save_terminal_defaults',
      errorCode: 'database_error',
      errorMessage: after.errorMessage ?? 'could not read the terminal defaults',
    } satisfies SaveTerminalDefaultsFailure;
  return { ok: true, resultType: 'save_terminal_defaults', data: after.data };
}
