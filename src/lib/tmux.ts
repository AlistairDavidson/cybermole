// tmux.ts — typed helpers for the app's tmux socket.
// The app owns ONE socket (default "web-pi"): the tmux server starts on
// first new-session and dies with the last session (exit-empty). Closing
// the browser tab detaches; sessions keep running under tmux.
//
// Privilege split (DESIGN_REVIEW §1.1): WEB_PI_TMUX_SOCKET may instead be
// an ABSOLUTE path — the serving/working split, where the tmux server (and
// every pi session) runs as another uid/container and this process is
// only a client. tmux resolves a relative `-L <name>` per-client as
// $TMUX_TMPDIR/tmux-<uid>/<name> — a different path per uid — so the
// cross-uid shape REQUIRES `-S <absolute path>`. In that mode this side
// must NEVER be the one to fork the tmux server: new-session against a
// down server forks one AS THE CLIENT'S UID (verified footgun), which
// would silently undo the split — hence the guard in newSession/
// resumeSession. See also docker-workspace-entrypoint.sh (server
// lifecycle) and README "The privilege split".
// Pattern note: a LONG-LIVED externally-supervised session should get
// its OWN socket + supervisor — never share this one, or a crashing
// supervised session would look "alive". Scheduled-job runs are the
// sanctioned exception (src/lib/jobs.ts): the run is the session, it
// dies with the command, and sharing this socket is precisely what makes
// runs appear in the Live list next to interactive sessions.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { ENV, RAW_ENV } from './env';
import { componentLogger } from './logger';
import type { LiveSession } from './types';
import type { ResultFailure, ResultSuccess } from '../types/result';
import { asTmuxSessionName, type JobName, type PiSessionId, type TerminalId, type TmuxSessionName } from '../types/branded';
import { TMUX_SESSION_NAME_RE } from '../schemas/patterns';

export const SOCKET = ENV.WEB_PI_TMUX_SOCKET;

// In-project tmux config, applied when the tmux server starts. `-f` is read
// at server start only; carrying it on every call is a no-op afterwards and
// guarantees whichever call boots the server (first new-session) uses it.
// Exported for the /settings dashboard (resolved path, shown only).
export const CONF = ENV.WEB_PI_TMUX_CONF;
const log = componentLogger('tmux');
if (RAW_ENV.WEB_PI_TMUX_CONF && !fs.existsSync(CONF)) {
  log.warn(`WEB_PI_TMUX_CONF=${CONF} does not exist — using tmux defaults`);
}

/** Session name a resumed pi session runs under: 'r-' + the FULL session id.
 *  pi ids are UUIDv7, so any prefix is just the creation timestamp's high
 *  bits — sessions started within about a minute of each other share their
 *  first 8 hex chars, and a truncated name attached the second one's resume
 *  to the first one's running pi. Ids too long (or not tmux-safe) for
 *  TMUX_SESSION_NAME_RE get a hash of the id instead. */
export function resumeSessionName(id: PiSessionId): TmuxSessionName {
  const name = `r-${id}`;
  return asTmuxSessionName(TMUX_SESSION_NAME_RE.test(name)
    ? name : `r-${createHash('sha256').update(id).digest('hex').slice(0, 32)}`);
}

/** Session name a scheduled job's run opens on this socket (src/lib/jobs.ts
 *  fires runs under it; the Live list shows it like any session). Always a
 *  valid session name: JOB_NAME_RE caps names at 40, 'webpi-' + 40 = 46
 *  fits TMUX_SESSION_NAME_RE's 64 (unit-tested). */
export function jobSessionName(job: JobName): TmuxSessionName {
  return asTmuxSessionName(`webpi-${job}`);
}

/** Session name a terminal tab runs under (docs/workspaces-plan.md §4):
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
 *  by /api/new (503) and the terminal WS error path. */
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
  const se = typeof err.stderr === 'string' ? err.stderr
    : err.stderr === undefined || err.stderr === null ? '' : err.stderr.toString('utf8');
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
export type TmuxSessionFailure = ResultFailure<'tmux_session', TmuxSessionData, TmuxSessionErrorCode>;

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
  const ok = { ok: true, resultType: 'tmux_server', data: { socket: SOCKET } } satisfies TmuxServerSuccess;
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
function tmux(socket: string, args: string[], env?: Record<string, string>):
  Promise<{ error: TmuxError | null; stdout: string }> {
  const conf = fs.existsSync(CONF) ? ['-f', CONF] : [];
  return new Promise(resolve => {
    execFile('tmux', [...conf, ...socketArgs(socket), ...args],
      { timeout: 5000, ...(env ? { env: Object.assign({}, process.env, env) } : {}) },
      (err, stdout) => {
        resolve({ error: err instanceof Error ? err : null, stdout: typeof stdout === 'string' ? stdout : '' });
      });
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

/** Live sessions on the app socket. Can't fail by design: no server yet
 *  (or any error) is simply no live sessions. Explicit -F format: the
 *  default layout varies across tmux versions, and the cwd (resolved via
 *  the session's active pane) is what the sidebar's "open in editor" needs.
 *  That field is #{pane_current_path} falling back to
 *  #{pane_start_path}: current needs the pane tty's foreground pgrp
 *  (tmux's osdep_get_cwd → tcgetpgrp → /proc/<pgrp>/cwd), which a normal
 *  Linux kernel sets when the pane process acquires the tty as session
 *  leader — but not every pty layer does (the agent sandbox's is one:
 *  tcgetpgrp on the pane pty fails ENOTTY, verified against tmux 3.3a;
 *  a foreground pager can lose it too). #{?pane_current_path,A,B} is
 *  tmux's own name-condition conditional — verified on the prod image's
 *  tmux (3.3a) — and the spawn cwd is what `new-session -c` started the
 *  session in, i.e. exactly the session's working directory for pi and
 *  job sessions. Separator notes: '|' not '\t' — the prod image's
 *  bookworm apt tmux (3.3a) rewrites tab characters in list output to
 *  underscores (observed: a real tab in the format comes out as '_'),
 *  and '|' is stable either way; and #{session_created} is the raw epoch
 *  — #{session_created_string} only exists from tmux 3.4 (empty on
 *  3.3a), so the epoch is formatted in JS instead. A '|' in a session
 *  name would make the row unparseable — same as the old default-format
 *  regex, and names are [a-zA-Z0-9_-] by TMUX_SESSION_NAME_RE. */
export async function listSessions(): Promise<LiveSession[]> {
  const { error, stdout } = await tmux(SOCKET, ['list-sessions', '-F',
    '#{session_name}|#{session_windows}|#{session_created}|#{?session_attached,attached,}|#{?pane_current_path,#{pane_current_path},#{pane_start_path}}']);
  if (error) return [];
  const out: LiveSession[] = [];
  for (const line of stdout.split('\n')) {
    const m = line.match(/^([^|]+)\|(\d+)\|(\d+)\|(attached)?\|(.*)$/);
    if (m) {
      out.push({
        name: asTmuxSessionName(m[1] ?? ''), windows: parseInt(m[2] ?? '1', 10),
        created: new Date(parseInt(m[3] ?? '0', 10) * 1000).toLocaleString(),
        attached: m[4] === 'attached', cwd: m[5] || null, socket: SOCKET,
      });
    }
  }
  return out;
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
  name: TmuxSessionName, cwd: string, command: string[], env: Record<string, string>): string[] {
  return ['new-session', '-d', '-s', name, '-c', cwd, ...envArgs(env), '--', ...command];
}

/** Start a session running the configured command (a terminal tab's
 *  spawn and respawn — plan §4; /api/new and job runs land here too).
 *  Never-fork guard first on absolute sockets (see requireServer). */
export async function newSession(name: TmuxSessionName, cwd: string, command: string[],
  env: Record<string, string>) {
  const server = await requireServer();
  if (!server.ok) return sessionFailure(name, server);
  const { error } = await tmux(SOCKET, newSessionArgs(name, cwd, command, env), env);
  if (error) return tmuxFailure(name, 'new-session', error);
  log.info(`tmux session ${name} started`, { command: command.join(' ') });
  return { ok: true, resultType: 'tmux_session', data: { name } } satisfies TmuxSessionSuccess;
}

/** Start (or reuse) a resume session; the caller then attaches. The
 *  create branch carries the same never-fork guard as newSession. */
export async function resumeSession(name: TmuxSessionName, cwd: string, command: string[],
  sessionId: PiSessionId, env: Record<string, string>) {
  const ok = { ok: true, resultType: 'tmux_session', data: { name } } satisfies TmuxSessionSuccess;
  if (await hasSession(name)) return ok;
  const server = await requireServer();
  if (!server.ok) return sessionFailure(name, server);
  const { error } = await tmux(SOCKET,
    ['new-session', '-d', '-s', name, '-c', cwd, ...envArgs(env), '--', ...command, '--session', sessionId], env);
  if (error) return tmuxFailure(name, 'new-session', error);
  log.info(`tmux session ${name} started (resume of pi session ${sessionId})`);
  return ok;
}

/** Sessions alive on the app socket, as a name set (job state checks). */
export async function liveSessionNames(): Promise<Set<TmuxSessionName>> {
  return new Set((await listSessions()).map(s => s.name));
}
