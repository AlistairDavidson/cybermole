// Child-process runner for the apps MCP's local tools. Timeouts kill the
// whole process group, since npm's grandchildren (astro, tsc, node --test)
// would otherwise outlive it.
import { type ChildProcess, spawn } from 'node:child_process';

/** code is null when killed by a signal. */
export interface ChildRun {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationS: number;
}

export class CommandNotFoundError extends Error {
  constructor(readonly command: string) {
    super(`${command} not found on PATH`);
    this.name = 'CommandNotFoundError';
  }
}

export interface RunChildOptions {
  cwd: string;
  /** TERM the process group, then KILL. Default: none. */
  timeoutMs?: number;
  /** merged over this process's env */
  env?: Record<string, string>;
}

export type RunChildFn = (
  command: string,
  args: string[],
  options: RunChildOptions,
) => Promise<ChildRun>;

function killGroup(child: ChildProcess, signal: 'SIGTERM' | 'SIGKILL'): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    /* already gone */
  }
  try {
    child.kill(signal);
  } catch {
    /* ditto */
  }
}

/** Rejects only with CommandNotFoundError; nonzero exits, signals and timeouts are normal answers. */
export const runChild: RunChildFn = (command, args, options) =>
  new Promise((resolve, reject) => {
    const startedAt = Date.now();
    let child: ChildProcess;
    try {
      // Its own process group, so one signal reaches the grandchildren.
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
      // The detached group outlives the leader (astro check's language
      // server once starved a test host), so clean up stragglers.
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
