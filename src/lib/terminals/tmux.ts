// Helpers for the app's tmux socket. The server starts on the first
// new-session and exits with the last session.
//
// CYBERMOLE_TMUX_SOCKET may be an absolute path, where another uid owns the
// tmux server and this process is only a client. tmux resolves `-L <name>`
// per uid, so that shape needs `-S <path>`. In that mode this side must
// never fork the server: new-session against a down server forks one as
// the client's uid, silently undoing the split. Hence requireServer().
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import { ENV, RAW_ENV } from '../platform/env';
import { componentLogger } from '../platform/logger';
import {
  asTmuxSessionName,
  type JobName,
  type ResultFailure,
  type ResultSuccess,
  type TerminalId,
  type TmuxSessionName,
} from '@cybermole/app-kit';

export const SOCKET = ENV.CYBERMOLE_TMUX_SOCKET;

// `-f` only matters at server start; passing it on every call ensures
// whichever call boots the server uses it.
export const CONF = ENV.CYBERMOLE_TMUX_CONF;
const log = componentLogger('tmux');
if (RAW_ENV.CYBERMOLE_TMUX_CONF && !fs.existsSync(CONF)) {
  log.warn(`CYBERMOLE_TMUX_CONF=${CONF} does not exist — using tmux defaults`);
}

/** JOB_NAME_RE caps names at 40, so this fits the 64-char session name limit. */
export function jobSessionName(job: JobName): TmuxSessionName {
  return asTmuxSessionName(`cybermole-${job}`);
}

/** Derived from the row id, never stored, so row and session can't drift. */
export function terminalSessionName(id: TerminalId): TmuxSessionName {
  return asTmuxSessionName(`t-${id}`);
}

/** False if not running or tmux errored; logged at debug since closing a
 *  never-spawned tab is routine. */
export async function killSession(name: TmuxSessionName): Promise<boolean> {
  const { error } = await tmux(SOCKET, ['kill-session', '-t', name]);
  if (error) {
    log.debug(`kill-session ${name} failed: ${error.message}`);
    return false;
  }
  log.info(`tmux session ${name} killed`);
  return true;
}

export function socketArgs(socket: string): string[] {
  return socket.startsWith('/') ? ['-S', socket] : ['-L', socket];
}

/** Relative names fork-to-start as this uid; an absolute path means
 *  someone else owns the server. */
export function forksServer(socket: string): boolean {
  return !socket.startsWith('/');
}

export const SERVER_NOT_RUNNING_MSG = 'workspace tmux server not running';

type TmuxError = Error & { stderr?: string | Buffer };

/** Did a probe fail because no server is behind the socket? A live server
 *  answers with sessions or "no sessions"; anything else (no socket, stale
 *  socket, timeout, EACCES) reads as down: refusing is always safe. */
export function isServerDown(err: TmuxError | null): boolean {
  if (!err) return false;
  const se =
    typeof err.stderr === 'string'
      ? err.stderr
      : err.stderr === undefined || err.stderr === null
        ? ''
        : err.stderr.toString('utf8');
  return !se.includes('no sessions');
}

// ---------- results ----------

export type TmuxServerData = { socket: string };
export type TmuxServerSuccess = ResultSuccess<'tmux_server', TmuxServerData>;
export type TmuxServerFailure = ResultFailure<'tmux_server', TmuxServerData, 'server_not_running'>;

export type TmuxSessionData = { name: TmuxSessionName };
/** server_not_running: the never-fork guard refused. tmux_error on
 *  new-session is almost always a duplicate name. */
export type TmuxSessionErrorCode = 'server_not_running' | 'tmux_error';
export type TmuxSessionSuccess = ResultSuccess<'tmux_session', TmuxSessionData>;
export type TmuxSessionFailure = ResultFailure<
  'tmux_session',
  TmuxSessionData,
  TmuxSessionErrorCode
>;

/** Gate for anything that can fork a server (new-session and attach): on
 *  an absolute socket, confirm a server answers first. A server dying
 *  between probe and command can still fork one; that race is accepted. */
export async function requireServer() {
  const ok = {
    ok: true,
    resultType: 'tmux_server',
    data: { socket: SOCKET },
  } satisfies TmuxServerSuccess;
  if (forksServer(SOCKET)) return ok;
  const { error } = await tmux(SOCKET, ['list-sessions']);
  if (isServerDown(error)) {
    return {
      ok: false,
      resultType: 'tmux_server',
      data: { socket: SOCKET },
      errorCode: 'server_not_running',
      errorMessage: `${SERVER_NOT_RUNNING_MSG} on ${SOCKET} — refusing to fork one as the web user; start it on the workspace side`,
    } satisfies TmuxServerFailure;
  }
  return ok;
}

/** Never rejects: the error (with stderr) is part of the answer. */
function tmux(
  socket: string,
  args: string[],
  env?: Record<string, string>,
  timeout = 5000,
): Promise<{ error: TmuxError | null; stdout: string }> {
  const conf = fs.existsSync(CONF) ? ['-f', CONF] : [];
  return new Promise(resolve => {
    execFile(
      'tmux',
      [...conf, ...socketArgs(socket), ...args],
      { timeout, ...(env ? { env: Object.assign({}, process.env, env) } : {}) },
      (err, stdout) => {
        resolve({
          error: err instanceof Error ? err : null,
          stdout: typeof stdout === 'string' ? stdout : '',
        });
      },
    );
  });
}

/** Per-session env, independent of what env the tmux server started with. */
function envArgs(env: Record<string, string>): string[] {
  return Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
}

function sessionFailure(name: TmuxSessionName, server: TmuxServerFailure) {
  return {
    ok: false,
    resultType: 'tmux_session',
    data: { name },
    errorCode: server.errorCode,
    errorMessage: server.errorMessage ?? SERVER_NOT_RUNNING_MSG,
  } satisfies TmuxSessionFailure;
}

function tmuxFailure(name: TmuxSessionName, what: string, error: TmuxError) {
  return {
    ok: false,
    resultType: 'tmux_session',
    data: { name },
    errorCode: 'tmux_error',
    errorMessage: `tmux ${what} failed: ${error.message}`,
  } satisfies TmuxSessionFailure;
}

/** Can't fail: any error (including no server) is an empty set. */
export async function liveSessionNames(): Promise<Set<TmuxSessionName>> {
  const { error, stdout } = await tmux(SOCKET, ['list-sessions', '-F', '#{session_name}']);
  if (error) return new Set();
  return new Set(stdout.split('\n').filter(Boolean).map(asTmuxSessionName));
}

/** Any tmux error reads as "no such session". */
export async function hasSession(name: TmuxSessionName): Promise<boolean> {
  const { error } = await tmux(SOCKET, ['has-session', '-t', name]);
  return !error;
}

/** Shared by spawn and WS respawn so both build the same argv. */
export function newSessionArgs(
  name: TmuxSessionName,
  cwd: string,
  command: string[],
  env: Record<string, string>,
): string[] {
  return ['new-session', '-d', '-s', name, '-c', cwd, ...envArgs(env), '--', ...command];
}

/** Never-fork guard first on absolute sockets. */
export async function newSession(
  name: TmuxSessionName,
  cwd: string,
  command: string[],
  env: Record<string, string>,
) {
  const server = await requireServer();
  if (!server.ok) return sessionFailure(name, server);
  const { error } = await tmux(SOCKET, newSessionArgs(name, cwd, command, env), env);
  if (error) return tmuxFailure(name, 'new-session', error);
  log.info(`tmux session ${name} started`, { command: command.join(' ') });
  return { ok: true, resultType: 'tmux_session', data: { name } } satisfies TmuxSessionSuccess;
}

// ---------- scrollback backfill ----------

/** Matches the browser terminal's scrollback. */
export const BACKFILL_LINES = 5000;

/** `-E -1` stops at the last history line: the visible screen is excluded
 *  because the attach redraw paints it. */
export function capturePaneHistoryArgs(name: TmuxSessionName): string[] {
  return ['capture-pane', '-p', '-S', String(-BACKFILL_LINES), '-E', '-1', '-t', name];
}

/** With no history, `-E -1` clamps to the first screen line, which the
 *  redraw would paint twice, so check first. Errors read as 0. */
export async function paneHistorySize(name: TmuxSessionName): Promise<number> {
  const { error, stdout } = await tmux(
    SOCKET,
    ['display-message', '-p', '-t', name, '#{history_size}'],
    undefined,
    2000,
  );
  if (error) return 0;
  const n = Number.parseInt(stdout.trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Scrollback as terminal-ready text, or null to skip the backfill (any
 *  error). capture-pane doesn't fork a server, so needs no guard.
 *  Trailing blank lines are trimmed (a cleared screen leaves dozens), and
 *  lines are re-terminated \r\n: a bare LF keeps the column, so each line
 *  would land further right. */
export async function capturePaneHistory(name: TmuxSessionName): Promise<string | null> {
  // 2s timeouts: the attach's output is held until this resolves.
  if ((await paneHistorySize(name)) === 0) return null;
  const { error, stdout } = await tmux(SOCKET, capturePaneHistoryArgs(name), undefined, 2000);
  if (error) {
    log.debug(`capture-pane ${name} failed: ${error.message}`);
    return null;
  }
  const trimmed = stdout.replace(/(?:[ \t]*\r?\n)+$/, '');
  if (trimmed === '') return null;
  return trimmed.split(/\r?\n/).join('\r\n') + '\r\n';
}
