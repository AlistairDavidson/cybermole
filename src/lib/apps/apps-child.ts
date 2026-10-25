// apps-child.ts — the child-process runner the apps MCP's local tools
// (scaffold's setup/git, check/build's npm scripts) share: capture
// stdout/stderr, a per-call timeout that kills the child's whole process
// GROUP (npm runs spawn grandchildren — astro, tsc, node --test — and a
// timeout that only killed npm would leave them running), and one typed
// failure for a missing command (git/npm not on PATH — a clear answer,
// never a stack trace). Plain data out: the callers map to their own
// Result families or envelopes (docs/conventions/CODE_STYLE.md §2 — the boundary
// catches; nothing above it sees an exception from here).
import { type ChildProcess, spawn } from 'node:child_process';

/** One finished child: exit code (null when killed by signal), both
 *  output streams captured whole, whether the timeout cut it off, and
 *  the wall-clock seconds it took. */
export interface ChildRun {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationS: number;
}

/** The command was not found on PATH — git missing in an image, npm
 *  renamed, a mistyped runner. Carries the command name for the message. */
export class CommandNotFoundError extends Error {
  constructor(readonly command: string) {
    super(`${command} not found on PATH`);
    this.name = 'CommandNotFoundError';
  }
}

export interface RunChildOptions {
  cwd: string;
  /** Cut the run off after this many ms (process group TERM, then KILL).
   *  Default: no timeout. */
  timeoutMs?: number;
  /** Extra env for the child (PATH additions); inherits this process's
   *  env otherwise. */
  env?: Record<string, string>;
}

export type RunChildFn = (
  command: string,
  args: string[],
  options: RunChildOptions,
) => Promise<ChildRun>;

/** Kill a child's process group, then its stragglers — TERM first, KILL
 *  after a grace beat (a few ms is plenty: the TERM travels instantly;
 *  the KILL only needs to outlive it in the event loop). */
function killGroup(child: ChildProcess, signal: 'SIGTERM' | 'SIGKILL'): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    /* the group is already gone */
  }
  try {
    child.kill(signal);
  } catch {
    /* ditto */
  }
}

/** Run one child to completion. Rejects ONLY on a missing command
 *  (CommandNotFoundError); a nonzero exit, a signal death and a timeout
 *  are normal answers. */
export const runChild: RunChildFn = (command, args, options) =>
  new Promise((resolve, reject) => {
    const startedAt = Date.now();
    let child: ChildProcess;
    try {
      // detached: its own process group, so a timeout kill reaches the
      // grandchildren (the runners npm spawns) with one signal.
      child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env ? { ...process.env, ...options.env } : process.env,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      reject(err as Error);
      return;
    }
    child.on('error', err => {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') reject(new CommandNotFoundError(command));
      else reject(e);
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (c: Buffer) => {
      stdout += c.toString('utf8');
    });
    child.stderr?.on('data', (c: Buffer) => {
      stderr += c.toString('utf8');
    });
    let timedOut = false;
    let killer: NodeJS.Timeout | null = null;
    if (options.timeoutMs !== undefined) {
      killer = setTimeout(() => {
        timedOut = true;
        killGroup(child, 'SIGTERM');
        killer = setTimeout(() => killGroup(child, 'SIGKILL'), 2000);
        killer.unref?.();
      }, options.timeoutMs);
    }
    child.on('close', code => {
      if (killer !== null) clearTimeout(killer);
      // The leader's exit does NOT take its detached group with it — npm
      // done can leave `astro check`'s language-server grandchildren
      // running (observed starving a test host until Playwright restarted
      // its worker mid-file). The group is this child's OWN (never ours);
      // TERM the stragglers, KILL a beat later, best-effort both.
      killGroup(child, 'SIGTERM');
      setTimeout(() => killGroup(child, 'SIGKILL'), 2000).unref?.();
      resolve({
        code,
        stdout,
        stderr,
        timedOut,
        durationS: (Date.now() - startedAt) / 1000,
      });
    });
  });
