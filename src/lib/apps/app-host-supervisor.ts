// With CYBERMOLE_APPS_SOCK unset (single-user), main.ts spawns the app host
// as a supervised child with the same uid and env; when it's set, someone
// else owns the host. The child's log lines are re-logged at their own
// level; a crashed host restarts with doubling backoff (reset after a
// stable run) and the supervisor never gives up.
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

export interface SupervisorLog {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export type SupervisorSpawn = (
  command: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; stdio: ['ignore', 'pipe', 'pipe'] },
) => ChildProcess;

export interface AppHostSupervisorDeps {
  /** process.execPath */
  command: string;
  /** [dist-server/server/app-host.js] */
  args: readonly string[];
  /** The child derives the same socket defaults from it. */
  env: NodeJS.ProcessEnv;
  log: SupervisorLog;
  spawn?: SupervisorSpawn;
  /** Default 1 s, doubling per consecutive quick death. */
  restartDelayMs?: number;
  /** Default 10 s. */
  backoffCapMs?: number;
  /** A child that lived this long resets the backoff. Default 30 s. */
  stableMs?: number;
  /** SIGTERM → SIGKILL grace. Default 2 s: the web server's drain mustn't wait on the host's own 5 s. */
  killGraceMs?: number;
  now?: () => number;
}

export interface AppHostSupervisorHandle {
  /** null while starting, between restarts, or stopped. */
  readonly pid: number | null;
  /** 1 = the initial spawn */
  readonly starts: number;
  /** No more restarts; SIGTERM, then SIGKILL after the grace. Idempotent. */
  stop(): Promise<void>;
}

/** Strips a child winston line's prefix so it re-logs natively at its own
 *  level; anything else forwards at info. */
const CHILD_LINE_RE = /^\d{4}-\d{2}-\d{2}T[^\s]+\s+(debug|info|http|warn|error)\s+\[[^\]]+\]\s?/;

function forwardChildLine(log: SupervisorLog, line: string): void {
  const match = line.match(CHILD_LINE_RE);
  if (match) {
    const level = match[1] === 'error' ? 'error' : match[1] === 'warn' ? 'warn' : 'info';
    log[level](line.slice(match[0].length) || line);
    return;
  }
  log.info(line);
}

/** A trailing partial line flushes on end, so a crash's last words survive. */
function pipeLines(
  stream: ChildProcess['stdout'] | ChildProcess['stderr'],
  log: SupervisorLog,
): void {
  if (stream === null || stream === undefined) return;
  let buf = '';
  stream.on('data', (chunk: Buffer) => {
    buf += chunk.toString('utf8');
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      if (line.trim() !== '') forwardChildLine(log, line);
    }
  });
  stream.on('end', () => {
    const line = buf.replace(/\r$/, '');
    if (line.trim() !== '') forwardChildLine(log, line);
  });
}

export function startAppHostSupervisor(deps: AppHostSupervisorDeps): AppHostSupervisorHandle {
  const spawnFn = deps.spawn ?? (spawn as SupervisorSpawn);
  const log = deps.log;
  const now = deps.now ?? Date.now;
  const restartDelayMs = deps.restartDelayMs ?? 1000;
  const backoffCapMs = deps.backoffCapMs ?? 10_000;
  const stableMs = deps.stableMs ?? 30_000;
  const killGraceMs = deps.killGraceMs ?? 2000;

  let child: ChildProcess | null = null;
  let stopping = false;
  let starts = 0;
  let delay = restartDelayMs;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;
  let stopDone: (() => void) | null = null;

  const spawnChild = (): void => {
    if (stopping) return;
    starts++;
    const bornAt = now();
    const c = spawnFn(deps.command, deps.args, {
      env: deps.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child = c;
    pipeLines(c.stdout, log);
    pipeLines(c.stderr, log);
    log.info(`app host started (pid ${c.pid ?? '?'})`);

    // A failed spawn emits 'error' but never 'exit'; both count as a death.
    const onDeath = (code: number | null, signal: string | null): void => {
      if (c !== child) return; // superseded child
      child = null;
      if (stopDone !== null) {
        stopDone();
        stopDone = null;
        return;
      }
      if (stopping) return;
      const lived = Math.max(0, now() - bornAt);
      if (lived >= stableMs) delay = restartDelayMs;
      log.warn(
        `app host (pid ${c.pid ?? '?'}) exited (code ${code}, signal ${signal}) after ${lived}ms — ` +
          `restarting in ${delay}ms (the /apps/* surface 502s until it is back)`,
      );
      const wait = delay;
      delay = Math.min(delay * 2, backoffCapMs);
      restartTimer = setTimeout(() => {
        restartTimer = null;
        spawnChild();
      }, wait);
      restartTimer.unref();
    };
    c.on('error', err => {
      log.error(`app host could not be spawned: ${err.message}`);
      onDeath(null, null);
    });
    c.on('exit', (code, signal) => onDeath(code, signal));
  };
  spawnChild();

  let stopPromise: Promise<void> | null = null;
  return {
    get pid(): number | null {
      return child?.pid ?? null;
    },
    get starts(): number {
      return starts;
    },
    stop(): Promise<void> {
      if (stopPromise) return stopPromise;
      stopping = true;
      if (restartTimer !== null) {
        clearTimeout(restartTimer);
        restartTimer = null;
      }
      stopPromise = new Promise(resolve => {
        if (child === null) {
          resolve();
          return;
        }
        const killTimer = setTimeout(() => {
          child?.kill('SIGKILL');
        }, killGraceMs);
        // Not unref'd: it lets a stop() awaiting the grace stay scheduled.
        stopDone = () => {
          clearTimeout(killTimer);
          resolve();
        };
        child.kill('SIGTERM');
      });
      return stopPromise;
    },
  };
}
