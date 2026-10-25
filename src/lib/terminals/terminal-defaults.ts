// What new terminals run: the shell command for every tab, and the agent
// command for a new workspace's first tab. Each resolves db override ?? env
// at spawn time, so a /settings save applies to the next tab. The env
// values carry their own defaults (env.ts): a login shell, and the vendored
// pi binary when installed.
import { qb, type StateDb } from '../platform/db';
import { databaseRead, databaseUpdate, type DatabaseReadResult } from '@cybermole/app-kit';
import { ENV } from '../platform/env';
import type { TerminalDefaults } from '../platform/types';
import type { ResultFailure, ResultSuccess } from '@cybermole/app-kit';

const KEY_AGENT = 'terminalDefaults.agentCommand';
const KEY_SHELL = 'terminalDefaults.shellCommand';

/** The env value already carries its built-in default. */
export function resolveCommand(override: string | null, envValue: string): string {
  return override ?? envValue;
}

export function splitCommandLine(line: string): string[] {
  return line.trim().split(/\s+/).filter(Boolean);
}

/** A corrupt row reads as unset; only a db failure throws. */
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

export function resolvedAgentCommand(db: StateDb): DatabaseReadResult<string> {
  return databaseRead('could not read the agent command', () =>
    resolveCommand(readOverride(db, KEY_AGENT), ENV.CYBERMOLE_AGENT_COMMAND),
  );
}

export function resolvedShellCommand(db: StateDb): DatabaseReadResult<string> {
  return databaseRead('could not read the shell command', () =>
    resolveCommand(readOverride(db, KEY_SHELL), ENV.CYBERMOLE_COMMAND),
  );
}

export type TerminalDefaultsErrorCode = 'database_error';
export type TerminalDefaultsSuccess = ResultSuccess<'terminal_defaults', TerminalDefaults>;
export type TerminalDefaultsFailure = ResultFailure<
  'terminal_defaults',
  TerminalDefaults,
  TerminalDefaultsErrorCode
>;
export type TerminalDefaultsResult = TerminalDefaultsSuccess | TerminalDefaultsFailure;

/** The effective commands plus which are overridden (for the reset UI). */
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

/** Per field: a string sets, null deletes the row (back to default), absent
 *  keeps. Returns the effective pair for the page to re-render from. */
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
