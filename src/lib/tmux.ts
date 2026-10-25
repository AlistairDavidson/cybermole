// tmux.ts — typed helpers for the app's tmux socket.
// The app owns ONE socket (default "cybermole"): the tmux server starts on
// first new-session and dies with the last session (exit-empty). Closing
// the browser tab detaches; sessions keep running under tmux.
//
// Privilege split (DESIGN_REVIEW §1.1): CYBERMOLE_TMUX_SOCKET may instead be
// an ABSOLUTE path — the serving/working split, where the tmux server (and
// every pi session) runs as another uid/container and this process is
// only a client. tmux resolves a relative `-L <name>` per-client as
// $TMUX_TMPDIR/tmux-<uid>/<name> — a different path per uid — so the
// cross-uid shape REQUIRES `-S <absolute path>`. In that mode this side
// must NEVER be the one to fork the tmux server: new-session against a
// down server forks one AS THE CLIENT'S UID (verified footgun), which
// would silently undo the split — hence the guard in newSession
// (and every attach). See also docker-workspace-entrypoint.sh (server
// lifecycle) and README "The privilege split".
// Pattern note: a LONG-LIVED externally-supervised session should get
// its OWN socket + supervisor — never share this one, or a crashing
// supervised session would look "alive". Scheduled-job runs are the
// sanctioned exception (src/lib/jobs.ts): the run is the session, it
// dies with the command, and sharing this socket keeps runs addressable
// like any interactive session.
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import { ENV, RAW_ENV } from './env';
import { componentLogger } from './logger';
import {
  asTmuxSessionName,
  type JobName,
  type ResultFailure,
  type ResultSuccess,
  type TerminalId,
  type TmuxSessionName,
} from '@cybermole/app-kit';

export const SOCKET = ENV.CYBERMOLE_TMUX_SOCKET;

// In-project tmux config, applied when the tmux server starts. `-f` is read
// at server start only; carrying it on every call is a no-op afterwards and
// guarantees whichever call boots the server (first new-session) uses it.
// Exported for the /settings dashboard (resolved path, shown only).
export const CONF = ENV.CYBERMOLE_TMUX_CONF;
const log = componentLogger('tmux');
if (RAW_ENV.CYBERMOLE_TMUX_CONF && !fs.existsSync(CONF)) {
  log.warn(`CYBERMOLE_TMUX_CONF=${CONF} does not exist — using tmux defaults`);
}

/** Session name a scheduled job's run opens on this socket (src/lib/jobs.ts
 *  fires runs under it; the jobs page's running badge and ?run= view link
 *  address it). Always a valid session name: JOB_NAME_RE caps names at 40,
 *  'cybermole-' + 40 = 46 fits TMUX_SESSION_NAME_RE's 64 (unit-tested). */
export function jobSessionName(job: JobName): TmuxSessionName {
  return asTmuxSessionName(`cybermole-${job}`);
}

/** Session name a terminal tab runs under (docs/plans/workspaces-plan.md §4):
 *  't-' + the terminal row's uuid — DERIVED, never stored, so the db row
 *  and the tmux session can never drift apart. Always a valid session
 *  name: a uuid v4 is 36 chars, 't-' + 36 = 38 fits TMUX_SESSION_NAME_RE's
 *  64 (same trick as r-<uuid> above). */
export function terminalSessionName(id: TerminalId): TmuxSessionName {
  return asTmuxSessionName(`t-${id}`);
}

/** Best-effort kill of one session. Can't fail by design: the answer is
 *  whether the session was killed (false = not running, or tmux itself
 *  errored — the caller decides what that means; failures are logged at
 *  debug here so a delete of never-spawned rows — branch task/ws-schema
 *  creates rows without spawning — doesn't spam the console). */
export async function killSession(name: TmuxSessionName): Promise<boolean> {
  const { error } = await tmux(SOCKET, ['kill-session', '-t', name]);
  if (error) {
    log.debug(`kill-session ${name} failed: ${error.message}`);
    return false;
  }
  log.info(`tmux session ${name} killed`);
  return true;
}

/** tmux socket-selection args: `-S <path>` for an absolute path (the
 *  split shape — one socket shared across uids/containers), `-L <name>`
 *  for a relative name (single-user: the per-uid default dir). */
export function socketArgs(socket: string): string[] {
  return socket.startsWith('/') ? ['-S', socket] : ['-L', socket];
}

/** Does this socket name keep today's fork-to-start behaviour (the
 *  first new-session starts the tmux server as this same uid)? Only
 *  relative names do; an absolute path means somebody else owns the
 *  server and this side must never fork one. */
export function forksServer(socket: string): boolean {
  return !socket.startsWith('/');
}

/** User-facing message when the guard refuses to fork: surfaced verbatim
 *  by the terminal family (the create route's 503) and the terminal WS
 *  error path. */
export const SERVER_NOT_RUNNING_MSG = 'workspace tmux server not running';

type TmuxError = Error & { stderr?: string | Buffer };

/** Did a list-sessions probe fail because there is no server behind the
 *  socket (as opposed to an alive-but-sessionless server answering)?
 *  Pure decision half of the never-fork guard, unit-tested.
 *  Down-server errors come in two texts — `error connecting to <path>
 *  (…)` (no socket file at all) and `no server running on <path>` (a
 *  stale socket a dead server left behind) — while an alive server can
 *  only answer with sessions or the `no sessions` error. Anything else
 *  (a hung timeout, permission denied on the socket) also reads as down:
 *  refusing is always safe, forking never is. */
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
/** server_not_running: the never-fork guard refused (absolute socket, no
 *  server behind it). tmux_error: tmux itself failed — for new-session
 *  that is almost always "duplicate session" (name taken). */
export type TmuxSessionErrorCode = 'server_not_running' | 'tmux_error';
export type TmuxSessionSuccess = ResultSuccess<'tmux_session', TmuxSessionData>;
export type TmuxSessionFailure = ResultFailure<
  'tmux_session',
  TmuxSessionData,
  TmuxSessionErrorCode
>;

/** Never-fork gate for EVERY path that can start a tmux server as this
 *  uid — new-session AND attach (both are forking commands in tmux):
 *  on an absolute-path socket, first confirm a server actually answers;
 *  otherwise fail instead of silently forking one as this (web) uid.
 *  Relative names skip the probe entirely — fork-to-start is their
 *  documented behaviour.
 *  Residual race (accepted): the probe and the follow-up command are two
 *  steps, so a server dying between them still forks one as this uid —
 *  nothing short of a protocol change removes that window; the probe
 *  closes the steady-state case (workspace never started / crashed long
 *  ago), which is what the split must never paper over. */
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

/** One tmux call. Never rejects: the error (with tmux's stderr) is part
 *  of the answer — callers decide what it means. */
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

/** `-e NAME=value` args for new-session: per-session environment, so the
 *  spawned command's env doesn't depend on when the tmux server (and the
 *  env it inherited at startup) came up. */
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

/** Session names alive on the app socket, as a name set. Can't fail by
 *  design: no server yet (or any error — the split's down server included)
 *  is simply an empty set, i.e. "nothing is live". The name-set shape is
 *  what remains after the pi-session UI died (plan §11): /api/state's
 *  live diff (a terminal tab is live when `t-<uuid>` is in the set) and
 *  the job state checks. Names are [a-zA-Z0-9_-] by TMUX_SESSION_NAME_RE,
 *  one per line — no separator games needed. */
export async function liveSessionNames(): Promise<Set<TmuxSessionName>> {
  const { error, stdout } = await tmux(SOCKET, ['list-sessions', '-F', '#{session_name}']);
  if (error) return new Set();
  return new Set(stdout.split('\n').filter(Boolean).map(asTmuxSessionName));
}

/** Does the session exist? Can't fail by design: any tmux error reads as
 *  "no such session". */
export async function hasSession(name: TmuxSessionName): Promise<boolean> {
  const { error } = await tmux(SOCKET, ['has-session', '-t', name]);
  return !error;
}

/** The new-session argv (minus the socket/-f prefix `tmux()` adds):
 *  detached, named, started at cwd, per-session -e env, then the command
 *  after `--`. Pure so the spawn (new_terminal, plan §4) and the WS
 *  respawn path build the identical argv — unit-tested without tmux. */
export function newSessionArgs(
  name: TmuxSessionName,
  cwd: string,
  command: string[],
  env: Record<string, string>,
): string[] {
  return ['new-session', '-d', '-s', name, '-c', cwd, ...envArgs(env), '--', ...command];
}

/** Start a session running the configured command (a terminal tab's
 *  spawn and respawn, and a job run — plan §4/§9). Never-fork guard
 *  first on absolute sockets (see requireServer). */
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

// ---------- scrollback backfill (the attach-time capture) ----------

/** History lines the attach backfill captures (`-S`, tmux.ts). Matches
 *  the browser terminal's scrollback (agent-terminal.ts) — enough to
 *  search recent history without shipping the whole 100k-line pane. */
export const BACKFILL_LINES = 5000;

/** The capture-pane argv (minus the socket/-f prefix `tmux()` adds) for
 *  the attach backfill. Pure, so the spawn and the unit test share one
 *  contract: `-E -1` stops at the LAST HISTORY line — the visible screen
 *  is deliberately excluded, because tmux's attach redraw repaints the
 *  screen itself and backfilling it too would double it (the client
 *  writes the history, then pushes the viewport down so the redraw lands
 *  below it — see agent-terminal.ts). */
export function capturePaneHistoryArgs(name: TmuxSessionName): string[] {
  return ['capture-pane', '-p', '-S', String(-BACKFILL_LINES), '-E', '-1', '-t', name];
}

/** A pane's history line count — the empty-history gate for the
 *  backfill capture: with NO history, capture-pane's `-E -1` clamps to
 *  the first SCREEN line (observed: a 2-line pane's first line comes
 *  back), which would backfill a line the attach redraw paints too.
 *  Can't fail by design: any error (no session — the attach race — a
 *  dead server) reads as 0, i.e. "no history to backfill". */
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

/** A pane's scrollback history as terminal-ready text (one `\r\n` per
 *  line), for the WS backfill on attach (server/main.ts). HISTORY ONLY —
 *  the visible screen is the redraw's job. Can't fail by design: no
 *  session (race: killed between the attach's checks and here), an empty
 *  history, or any tmux error reads as null — "skip the backfill", the
 *  attach itself is unaffected. capture-pane is not a forking command:
 *  on a down server it errors instead of starting one, so unlike
 *  new-session and attach it needs no never-fork gate. Trailing blank
 *  lines are trimmed: a shell that cleared the screen leaves dozens, and
 *  the client would pad the buffer with them. Lines are re-terminated
 *  \r\n — capture-pane emits bare \n, and a terminal's LF moves the
 *  cursor DOWN only (the column persists): bare-\n lines would land each
 *  one further right than the last. */
export async function capturePaneHistory(name: TmuxSessionName): Promise<string | null> {
  // Shorter than tmux()'s 5s default: the caller holds the attach's
  // output until this resolves, so a wedged capture must not stall the
  // terminal for the full default.
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
