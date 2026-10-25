// app-host-supervisor.ts — the SINGLE-USER spawn rule (task/app-web,
// docs/plans/apps-plan.md §3, the CYBERMOLE_TMUX_SOCKET precedent): when
// CYBERMOLE_APPS_SOCK is UNSET (the default single-user shape),
// server/main.ts OWNS the app host — it spawns
// `node dist-server/server/app-host.js` as a supervised child at the
// default socket path, same uid and same env (the child resolves the
// same defaults from the inherited environment; nothing is
// re-negotiated). When the env is explicitly SET (the compose split,
// the e2e suite) the web server is ONLY a client — never spawns: the
// operator/workspace entrypoint owns the process, exactly the tmux
// socket's ownership rule.
//
// Supervision: stdout/stderr into the logger (the child's winston lines
// re-logged at their own level, prefix stripped), SIGTERM at shutdown
// (SIGKILL after a grace period), and a crashed child RESTARTS with
// backoff — a poison app never takes the host down (the host is
// crash-tolerant at the registry level), but a crashed HOST is this
// supervisor's business. Backoff doubles per consecutive quick death
// and resets once a child ran stably; it never gives up.
//
// The spawn function, the clocks and the logger are injected deps, so
// the whole behavior is unit-testable without real children (tests/unit/
// app-host-supervisor.test.mjs); main.ts wires the real ones.
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

/** The logger surface the supervisor needs (componentLogger's shape). */
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
  /** node — main.ts passes process.execPath. */
  command: string;
  /** [appHostJs] — dist-server/server/app-host.js. */
  args: readonly string[];
  /** The web server's own env, verbatim: the child computes the same
   *  socket defaults from it (same uid, same wiring). */
  env: NodeJS.ProcessEnv;
  log: SupervisorLog;
  spawn?: SupervisorSpawn;
  /** First restart delay after a crash; doubles per consecutive quick
   *  death. Default 1 s. */
  restartDelayMs?: number;
  /** Backoff ceiling. Default 10 s. */
  backoffCapMs?: number;
  /** A child that lived at least this long counts as stable — the next
   *  crash restarts from the base delay, not the doubled one. Default
   *  30 s. */
  stableMs?: number;
  /** How long stop() waits after SIGTERM before SIGKILL. Default 2 s
   *  (the host's own shutdown deadline is 5 s; the web server's whole
   *  drain must not wait for it). */
  killGraceMs?: number;
  /** Clock injectable for units. */
  now?: () => number;
}

export interface AppHostSupervisorHandle {
  /** The running child's pid, or null (starting up / between restarts /
   *  stopped). */
  readonly pid: number | null;
  /** How many times a child has been started (1 = the initial spawn). */
  readonly starts: number;
  /** Stop supervising: no more restarts, SIGTERM to the live child,
   *  SIGKILL after the grace period. Resolves once the child is gone
   *  (or was never started). Idempotent. */
  stop(): Promise<void>;
}

/** Strip a child winston line's `timestamp level [component] ` prefix —
 *  the re-logged line then looks native in the parent's console and
 *  carries the child's own level into OUR logger (loki labels included).
 *  Anything that does not match forwards verbatim at info. */
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

/** Pipe a child stream into the logger line by line (a trailing partial
 *  line flushes on end — a crash's last words must not be lost). */
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

    // One death handler for both faces of dying: a crashed child emits
    // 'exit'; a spawn that never happened (EMFILE, a missing script) emits
    // 'error' only. Either way: a pending stop() resolves and a live
    // supervisor arms the backoff restart.
    const onDeath = (code: number | null, signal: string | null): void => {
      if (c !== child) return; // a superseded child (stop() already ran): not ours anymore
      child = null;
      if (stopDone !== null) {
        // stop() is waiting on exactly this death.
        stopDone();
        stopDone = null;
        return;
      }
      if (stopping) return;
      const lived = Math.max(0, now() - bornAt);
      if (lived >= stableMs) delay = restartDelayMs; // ran stable: a fresh crash is a fresh first crash
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
      // A FAILED spawn emits 'error' (+'close') but never 'exit' — treat it
      // as a death like any other (the same bookkeeping: a pending stop()
      // resolves, a live supervisor schedules the backoff restart). The
      // c===child guard makes the post-exit socket-error case a no-op.
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
        // Deliberately NOT unref'd, unlike the restart timer: it only
        // exists mid-stop (the restart timer is cleared above), and the
        // shutdown's own deadline backstop dominates — while a ref'd
        // timer here is what lets a stop() awaiting the grace stay
        // scheduled even when nothing else is pending.
        stopDone = () => {
          clearTimeout(killTimer);
          resolve();
        };
        child.kill('SIGTERM'); // the host closes its listener and exits (its own shutdown path)
      });
      return stopPromise;
    },
  };
}
