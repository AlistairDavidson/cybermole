// Scheduled jobs: name + 5-field cron + shell command, fired by an
// in-process scheduler into a tmux session `cybermole-<name>`. Each run's
// output and exit code are written to files under the log dir and read
// back when the tick sees the session end. Jobs don't fire while the server
// is down; the first tick after boot catches up.
//
// Commands are arbitrary shell by design, but only ever reach tmux as an
// argv element via execFile, never through a server-side shell.
import { CronExpressionParser } from 'cron-parser';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { qb, type JobRunOrigin, type StateDb } from '../platform/db';
import { componentLogger } from '../platform/logger';
import type { CalendarCheck, JobsState, ScheduledJob } from '../platform/types';
import {
  hasSession,
  jobSessionName,
  killSession,
  liveSessionNames,
  newSession,
} from '../terminals/tmux';
import { emitDomainEvent } from '../platform/events';
import {
  databaseRead,
  databaseUpdate,
  type AppId,
  type DatabaseUpdateFailure,
  type JobName,
  type ResultFailure,
  type ResultSuccess,
  type TmuxSessionName,
} from '@cybermole/app-kit';
import { MAX_SCHEDULE, type SaveInput } from '../../schemas/jobs';
import type { RunFinishedWebhook } from './notify';

// ---------- results (HTTP statuses are mapped in the HTTP layer) ----------

export type JobData = { name: JobName };

/** app_not_found is pre-checked, not sniffed from an FK error. */
export type SaveJobErrorCode = 'invalid_schedule' | 'app_not_found' | 'database_error';
export type SaveJobSuccess = ResultSuccess<'save_job', JobData>;
export type SaveJobFailure = ResultFailure<'save_job', JobData, SaveJobErrorCode>;
export type SaveJobResult = SaveJobSuccess | SaveJobFailure;

export type DeleteJobErrorCode = 'job_not_found' | 'database_error';
export type DeleteJobSuccess = ResultSuccess<'delete_job', JobData>;
export type DeleteJobFailure = ResultFailure<'delete_job', JobData, DeleteJobErrorCode>;
export type DeleteJobResult = DeleteJobSuccess | DeleteJobFailure;

export type RunJobData = { name: JobName; session: TmuxSessionName };
/** run_active: the previous run's session is still alive. database_error
 *  includes a fire that couldn't be recorded (and so wasn't spawned). */
export type RunJobErrorCode = 'job_not_found' | 'run_active' | 'tmux_error' | 'database_error';
export type RunJobSuccess = ResultSuccess<'run_job', RunJobData>;
export type RunJobFailure = ResultFailure<'run_job', RunJobData, RunJobErrorCode>;
export type RunJobResult = RunJobSuccess | RunJobFailure;

/** run_not_active: not the job's current live run (finished, or a newer
 *  one is live): a stale fired_at must never kill a newer run. */
export type KillRunData = { name: JobName; firedAt: number };
export type KillRunErrorCode =
  'job_not_found' | 'run_not_found' | 'run_not_active' | 'tmux_error' | 'database_error';
export type KillRunSuccess = ResultSuccess<'kill_run', KillRunData>;
export type KillRunFailure = ResultFailure<'kill_run', KillRunData, KillRunErrorCode>;
export type KillRunResult = KillRunSuccess | KillRunFailure;

export type ListJobsErrorCode = 'database_error';
export type ListJobsSuccess = ResultSuccess<'list_jobs', JobsState>;
export type ListJobsFailure = ResultFailure<'list_jobs', JobsState, ListJobsErrorCode>;
export type ListJobsResult = ListJobsSuccess | ListJobsFailure;

export type GetJobData = { name: JobName; schedule: string; command: string; appId: AppId | null };
export type GetJobErrorCode = 'job_not_found' | 'database_error';
export type GetJobSuccess = ResultSuccess<'get_job', GetJobData>;
export type GetJobFailure = ResultFailure<'get_job', GetJobData, GetJobErrorCode>;
export type GetJobResult = GetJobSuccess | GetJobFailure;

/** hasLog reflects the file, not the column: the wrapper may have failed to create it. */
export interface JobRunView {
  /** Epoch ms the run's session opened: the run's identity. */
  firedAt: number;
  origin: JobRunOrigin;
  /** null until the finish is observed with a readable exit file. */
  exitCode: number | null;
  /** Observation time (tick granularity); null while live or if the end went unseen. */
  finishedAt: number | null;
  hasLog: boolean;
}
export type ListRunsData = { runs: JobRunView[] };
export type ListRunsErrorCode = 'job_not_found' | 'database_error';
export type ListRunsSuccess = ResultSuccess<'list_runs', ListRunsData>;
export type ListRunsFailure = ResultFailure<'list_runs', ListRunsData, ListRunsErrorCode>;
export type ListRunsResult = ListRunsSuccess | ListRunsFailure;

export type RunLogData = { text: string; truncated: boolean };
/** log_missing: the run has no log column or the wrapper never created the file. */
export type RunLogErrorCode =
  'job_not_found' | 'run_not_found' | 'log_missing' | 'read_error' | 'database_error';
export type RunLogSuccess = ResultSuccess<'run_log', RunLogData>;
export type RunLogFailure = ResultFailure<'run_log', RunLogData, RunLogErrorCode>;
export type RunLogResult = RunLogSuccess | RunLogFailure;

export type NextFireData = { at: number };
export type NextFireErrorCode = 'invalid_schedule';
export type NextFireSuccess = ResultSuccess<'next_fire', NextFireData>;
export type NextFireFailure = ResultFailure<'next_fire', NextFireData, NextFireErrorCode>;
export type NextFireResult = NextFireSuccess | NextFireFailure;

// ---------- cron ----------

/** The next fire strictly after afterMs, in server local time. Only
 *  5-field cron: cron-parser would accept 6/7 fields and even ''. */
export function nextFireMs(schedule: string, afterMs: number) {
  const fail = (errorMessage: string) =>
    ({
      ok: false,
      resultType: 'next_fire',
      errorCode: 'invalid_schedule',
      errorMessage,
    }) satisfies NextFireFailure;
  const fields = schedule.trim().split(/\s+/).filter(Boolean);
  if (fields.length !== 5)
    return fail('schedule must be 5 cron fields: minute hour day-of-month month day-of-week');
  try {
    const at = CronExpressionParser.parse(fields.join(' '), { currentDate: new Date(afterMs) })
      .next()
      .getTime();
    return { ok: true, resultType: 'next_fire', data: { at } } satisfies NextFireSuccess;
  } catch (err) {
    return fail(cronError(err));
  }
}

/** Due once the next fire after the reference (last fire, or creation) has
 *  passed. Any number of missed windows collapse into one catch-up run,
 *  since firing resets the reference. Invalid schedules are never due. */
export function isDue(schedule: string, referenceMs: number, nowMs: number): boolean {
  const next = nextFireMs(schedule, referenceMs);
  return next.ok && next.data.at <= nowMs;
}

function cronError(err: unknown): string {
  const msg = (err instanceof Error ? err.message : String(err)).split('\n')[0] ?? '';
  return msg.trim() || 'invalid cron schedule';
}

/** Local "YYYY-MM-DD HH:mm", matching the schedule's local time. */
function formatFire(ms: number): string {
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}`
  );
}

export function checkCron(spec: string, nowMs: number = Date.now()): CalendarCheck {
  const by = 'cron-parser' as const;
  const s = spec.trim();
  if (!s) return { valid: false, next: null, error: 'schedule is required', validatedBy: by };
  if (s.length > MAX_SCHEDULE || /[\r\n]/.test(s)) {
    return {
      valid: false,
      next: null,
      error: 'invalid schedule (too long or multi-line)',
      validatedBy: by,
    };
  }
  const next = nextFireMs(s, nowMs);
  if (!next.ok) return { valid: false, next: null, error: next.errorMessage, validatedBy: by };
  return { valid: true, next: formatFire(next.data.at), error: null, validatedBy: by };
}

// ---------- run files ----------

/** Read-side cap on a log response; the appender caps the file at write time. */
const LOG_TAIL_BYTES = 1024 * 1024;

export function runLogPaths(
  logDir: string,
  job: JobName,
  firedAt: number,
): { log: string; exit: string } {
  return {
    log: path.join(logDir, job, `${firedAt}.log`),
    exit: path.join(logDir, job, `${firedAt}.exit`),
  };
}

/** Resolved from this module's location, not cwd: the wrapper runs it inside
 *  the workspace container's tmux session, and both containers ship the
 *  same image path. */
const LOG_APPENDER = path.join(__dirname, 'job-log-appender.js');

/** The command is $1, an argv element of an inner sh -c, never interpolated
 *  (a `#` or quote would break it). dash has no pipefail, so the exit code
 *  is captured inside the pipeline into $3. The appender caps the log at
 *  $5 bytes but keeps draining, so a chatty job neither fills the disk nor
 *  dies of SIGPIPE. A failed mkdir/appender loses output, not the run. */
export function runCommandArgv(
  command: string,
  logPath: string,
  exitPath: string,
  maxBytes: number,
): string[] {
  return [
    '/bin/sh',
    '-c',
    'mkdir -p "$(dirname "$2")"; { /bin/sh -c "$1" 2>&1; echo $? > "$3"; } | node "$4" "$2" "$5"',
    'sh',
    command,
    logPath,
    exitPath,
    LOG_APPENDER,
    String(maxBytes),
  ];
}

// ---------- scheduler ----------

const TICK_MS = 30_000;
/** Only the newest last-fired is read; the rest is history for the UI. */
const RUN_HISTORY = 20;

/** Only decides the origin column: later than this counts as catch-up. */
const CATCHUP_LATENESS_MS = 2 * TICK_MS;

export interface JobContext {
  cwd: string;
  env: Record<string, string>;
  /** Must exist in both containers. */
  logDir: string;
  /** Write-time log cap; the appender keeps draining output past it. */
  logMaxBytes: number;
  /** Fired once per observed run finish, after the exit code is recorded
   *  (src/lib/jobs/notify.ts). Absent = notifications off (tests). Never
   *  awaited: delivery must not hold the tick. */
  notifyRunFinished?: (payload: RunFinishedWebhook) => void;
}

// Domain events are emitted only inside the service functions below, which
// every caller (browser routes, internal API, tick, run-now) goes through,
// so no route can bypass them.

function emitRunStarted(job: JobName, firedAt: number): void {
  emitDomainEvent({ topic: 'jobs', type: 'run_started', job, firedAt });
}

const log = componentLogger('scheduler');

interface JobRow {
  name: JobName;
  schedule: string;
  command: string;
  created_at: number;
  appId: AppId | null;
  appName: string | null;
}

/** firedAt is the exact row when this process fired the run; null when it
 *  found the session already live (then the job's newest row is used). */
interface ArmedRun {
  job: JobName;
  firedAt: number | null;
}

export class Scheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  /** Stored schedules that no longer parse: warned once, then skipped until re-saved. */
  private warned = new Set<JobName>();
  /** Run sessions to watch; one that leaves the live set has finished.
   *  Armed when this process opens a run, or when a tick finds one live
   *  (run-now, alive at boot). A run that ends while the server is down
   *  is never observed. */
  private running = new Map<TmuxSessionName, ArmedRun>();

  constructor(
    private db: StateDb,
    private ctx: JobContext,
  ) {}

  /** No eager first tick: the state db opens lazily (the e2e webServer
   *  boots before its workspace reset). */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, TICK_MS);
  }

  /** Open runs are left alone; they outlive the scheduler. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // Every db call goes through these (or a local catch), so db failures
  // come back as results, never throws.
  private rows() {
    return databaseRead('could not read jobs', (): JobRow[] =>
      this.db.all(
        qb
          .selectFrom('jobs')
          .leftJoin('apps', join => join.onRef('apps.id', '=', 'jobs.app_id'))
          .select([
            'jobs.name as name',
            'jobs.schedule as schedule',
            'jobs.command as command',
            'jobs.created_at as created_at',
            'jobs.app_id as appId',
            'apps.name as appName',
          ])
          .orderBy('jobs.name'),
      ),
    );
  }

  private row(name: JobName) {
    return databaseRead('could not read job', (): JobRow | undefined =>
      this.db.get(
        qb
          .selectFrom('jobs')
          .leftJoin('apps', join => join.onRef('apps.id', '=', 'jobs.app_id'))
          .select([
            'jobs.name as name',
            'jobs.schedule as schedule',
            'jobs.command as command',
            'jobs.created_at as created_at',
            'jobs.app_id as appId',
            'apps.name as appName',
          ])
          .where('jobs.name', '=', name),
      ),
    );
  }

  /** order+limit instead of MAX() so exit_code comes along. */
  private lastRun(name: JobName) {
    return databaseRead(
      'could not read job runs',
      () =>
        this.db.get(
          qb
            .selectFrom('job_runs')
            .select(['fired_at', 'exit_code'])
            .where('job', '=', name)
            .orderBy('fired_at', 'desc')
            .limit(1),
        ) ?? null,
    );
  }

  /** fired_at is kept monotonic per job: it's the run's identity (log
   *  file name, URL param). */
  private recordRun(
    name: JobName,
    origin: JobRunOrigin,
  ):
    | { ok: true; firedAt: number; paths: { log: string; exit: string } }
    | { ok: false; errorMessage: string } {
    try {
      const last =
        this.db.get(
          qb
            .selectFrom('job_runs')
            .select('fired_at')
            .where('job', '=', name)
            .orderBy('fired_at', 'desc')
            .limit(1),
        )?.fired_at ?? 0;
      const firedAt = Math.max(Date.now(), last + 1);
      const paths = runLogPaths(this.ctx.logDir, name, firedAt);
      this.db.run(
        qb.insertInto('job_runs').values({ job: name, fired_at: firedAt, origin, log: paths.log }),
      );
      this.pruneRuns(name);
      return { ok: true, firedAt, paths };
    } catch (err) {
      return { ok: false, errorMessage: `could not record the run: ${(err as Error).message}` };
    }
  }

  /** Paths are selected before the delete; unlink is best-effort and the
   *  rows are pruned regardless. */
  private pruneRuns(name: JobName): void {
    const keep = () =>
      qb
        .selectFrom('job_runs')
        .select('fired_at')
        .where('job', '=', name)
        .orderBy('fired_at', 'desc')
        .limit(RUN_HISTORY);
    for (const row of this.db.all(
      qb
        .selectFrom('job_runs')
        .select(['fired_at', 'log'])
        .where('job', '=', name)
        .where('fired_at', 'not in', keep()),
    )) {
      if (row.log === null) continue;
      this.unlinkRunFiles(name, row.fired_at);
    }
    this.db.run(
      qb.deleteFrom('job_runs').where('job', '=', name).where('fired_at', 'not in', keep()),
    );
  }

  private unlinkRunFiles(name: JobName, firedAt: number): void {
    const paths = runLogPaths(this.ctx.logDir, name, firedAt);
    for (const file of [paths.log, paths.exit]) {
      try {
        fs.rmSync(file, { force: true });
      } catch (err) {
        log.warn(`could not prune run file ${file}: ${(err as Error).message}`);
      }
    }
  }

  private async tick(): Promise<void> {
    if (this.ticking) return; // a slow tmux call must not stack ticks
    this.ticking = true;
    const failed = (errorMessage: string): void => {
      log.error(`scheduler tick failed: ${errorMessage}`);
    };
    try {
      const rows = this.rows();
      if (!rows.ok) {
        failed(rows.errorMessage);
        return;
      }
      const live = await liveSessionNames();
      // Armed sessions no longer live have finished.
      for (const [session, armed] of this.running) {
        if (live.has(session)) continue;
        this.running.delete(session);
        this.observeFinish(session, armed);
      }
      const now = Date.now();
      for (const row of rows.data.value) {
        const session = jobSessionName(row.name);
        // A live previous run skips the job (no pile-up). Don't overwrite
        // an existing arm: it has the exact fired_at.
        if (live.has(session)) {
          if (!this.running.has(session))
            this.running.set(session, { job: row.name, firedAt: null });
          continue;
        }
        const last = this.lastRun(row.name);
        if (!last.ok) {
          failed(last.errorMessage);
          return;
        }
        const reference = last.data.value?.fired_at ?? row.created_at;
        const next = nextFireMs(row.schedule, reference);
        if (!next.ok) {
          if (!this.warned.has(row.name)) {
            this.warned.add(row.name);
            log.warn(
              `job ${row.name}: stored schedule "${row.schedule}" does not parse — skipped until re-saved`,
            );
          }
          continue;
        }
        const dueAt = next.data.at;
        if (dueAt <= now) {
          // Fires once however many windows were missed.
          const fired = await this.fire(
            row,
            now - dueAt > CATCHUP_LATENESS_MS ? 'catchup' : 'schedule',
          );
          if (!fired.ok) {
            switch (fired.errorCode) {
              case 'database_error':
                failed(fired.errorMessage);
                return;
              case 'server_not_running':
              case 'tmux_error':
                break; // logged by fire()
              default:
                fired satisfies never;
            }
          }
        }
      }
    } catch (err) {
      // Crash guard only: db and tmux failures come back as results.
      log.error(`scheduler tick failed: ${(err as Error)?.message ?? err}`);
    } finally {
      this.ticking = false;
    }
  }

  /** The exit code comes from the file (the wrapper's own exit is the
   *  appender's). Missing or unreadable means unknown, never guessed. */
  private observeFinish(session: TmuxSessionName, armed: ArmedRun): void {
    const read = databaseRead(
      'could not read job runs',
      () =>
        (armed.firedAt === null
          ? this.db.get(
              qb
                .selectFrom('job_runs')
                .select(['fired_at', 'origin', 'log'])
                .where('job', '=', armed.job)
                .orderBy('fired_at', 'desc')
                .limit(1),
            )
          : this.db.get(
              qb
                .selectFrom('job_runs')
                .select(['fired_at', 'origin', 'log'])
                .where('job', '=', armed.job)
                .where('fired_at', '=', armed.firedAt),
            )) ?? null,
    );
    if (!read.ok) log.error(`job ${armed.job}: ${read.errorMessage}`);
    const run = read.ok ? read.data.value : null;
    let exitCode: number | null = null;
    if (run !== null && run.log !== null) {
      const paths = runLogPaths(this.ctx.logDir, armed.job, run.fired_at);
      try {
        const raw = fs.readFileSync(paths.exit, 'utf8').trim();
        // `echo $?` writes 0–255; anything else (a truncated write) is unknown.
        if (/^\d{1,3}$/.test(raw)) exitCode = Number(raw);
      } catch {
        /* unknown */
      }
    }
    if (run !== null) {
      const finishedAt = Date.now();
      const updated = databaseUpdate('could not record the run finish', () =>
        this.db.run(
          qb
            .updateTable('job_runs')
            .set({ exit_code: exitCode, finished_at: finishedAt })
            .where('job', '=', armed.job)
            .where('fired_at', '=', run.fired_at),
        ),
      );
      if (!updated.ok) log.error(`job ${armed.job}: ${updated.errorMessage}`);
      else {
        emitDomainEvent({
          topic: 'jobs',
          type: 'run_finished',
          job: armed.job,
          firedAt: run.fired_at,
        });
        void this.ctx.notifyRunFinished?.({
          event: 'job_run_finished',
          job: armed.job,
          origin: run.origin,
          firedAt: run.fired_at,
          finishedAt,
          exitCode,
        });
      }
    }
    log.info(
      `job ${armed.job} run finished (run session ${session} gone, ` +
        `exit ${exitCode === null ? 'unknown' : exitCode})`,
      // Structured fields, not Loki labels (those stay low-cardinality by
      // design): the provisioned Grafana job alert parses these with
      // `| json` — deploy/grafana/provisioning/alerting/. jobName is the
      // JSON field; the stream's `job` label stays the deployment id.
      {
        jobName: armed.job,
        exitCode,
        origin: run?.origin ?? null,
        firedAt: run?.fired_at ?? null,
      },
    );
  }

  /** Recorded first: a failed spawn must still spend the fire, or the tick
   *  would retry it forever. */
  private async fire(row: JobRow, origin: JobRunOrigin) {
    const recorded = this.recordRun(row.name, origin);
    if (!recorded.ok) {
      return {
        ok: false,
        resultType: 'database_update',
        errorCode: 'database_error',
        errorMessage: recorded.errorMessage,
      } satisfies DatabaseUpdateFailure;
    }
    const session = jobSessionName(row.name);
    log.info(`job ${row.name} fired (${origin}) — opening run session ${session}`);
    const opened = await newSession(
      session,
      this.ctx.cwd,
      runCommandArgv(row.command, recorded.paths.log, recorded.paths.exit, this.ctx.logMaxBytes),
      this.ctx.env,
    );
    if (!opened.ok)
      log.error(`job ${row.name}: could not open run session ${session} (${opened.errorMessage})`);
    else {
      this.running.set(session, { job: row.name, firedAt: recorded.firedAt });
      emitRunStarted(row.name, recorded.firedAt);
    }
    return opened;
  }

  async listJobs() {
    const fail = (errorMessage: string) =>
      ({
        ok: false,
        resultType: 'list_jobs',
        errorCode: 'database_error',
        errorMessage,
      }) satisfies ListJobsFailure;
    const rows = this.rows();
    if (!rows.ok) return fail(rows.errorMessage);
    const live = await liveSessionNames();
    const now = Date.now();
    const jobs: ScheduledJob[] = [];
    for (const row of rows.data.value) {
      // Invalid only via a hand-edited db row; the tick warns.
      const nextFire = nextFireMs(row.schedule, now);
      const lastRead = this.lastRun(row.name);
      if (!lastRead.ok) return fail(lastRead.errorMessage);
      const last = lastRead.data.value;
      jobs.push({
        name: row.name,
        schedule: row.schedule,
        command: row.command,
        appId: row.appId,
        appName: row.appName,
        active: nextFire.ok,
        running: live.has(jobSessionName(row.name)),
        session: jobSessionName(row.name),
        next: nextFire.ok ? formatFire(nextFire.data.at) : null,
        last: last === null ? null : formatFire(last.fired_at),
        lastResult:
          last === null || last.exit_code === null
            ? 'unknown'
            : last.exit_code === 0
              ? 'success'
              : 'failed',
      });
    }
    return {
      ok: true,
      resultType: 'list_jobs',
      data: { available: true, detail: null, jobs },
    } satisfies ListJobsSuccess;
  }

  getJob(name: JobName): GetJobResult {
    const found = this.row(name);
    if (!found.ok) {
      return {
        ok: false,
        resultType: 'get_job',
        errorCode: 'database_error',
        errorMessage: found.errorMessage,
      } satisfies GetJobFailure;
    }
    const row = found.data.value;
    if (row === undefined) {
      return {
        ok: false,
        resultType: 'get_job',
        errorCode: 'job_not_found',
        errorMessage: 'no such job',
      } satisfies GetJobFailure;
    }
    return {
      ok: true,
      resultType: 'get_job',
      data: { name, schedule: row.schedule, command: row.command, appId: row.appId },
    } satisfies GetJobSuccess;
  }

  /** The app tag is checked before the write so it's a closed code; the
   *  check-then-insert race degrades to database_error. An already-overdue
   *  schedule fires as a catch-up on the next tick. */
  async saveJob(input: SaveInput) {
    const { name, schedule, command, appId } = input;
    const fail = (errorCode: SaveJobErrorCode, errorMessage: string) =>
      ({
        ok: false,
        resultType: 'save_job',
        data: { name },
        errorCode,
        errorMessage,
      }) satisfies SaveJobFailure;
    const check = checkCron(schedule);
    if (!check.valid) return fail('invalid_schedule', check.error ?? 'invalid schedule');
    // Read before the upsert to pick created vs updated; the race is harmless.
    const existing = this.row(name);
    if (!existing.ok) return fail('database_error', existing.errorMessage);
    if (appId != null) {
      const app = databaseRead(
        'could not read the app tag',
        () => this.db.get(qb.selectFrom('apps').select('id').where('id', '=', appId)) ?? null,
      );
      if (!app.ok) return fail('database_error', app.errorMessage);
      if (app.data.value === null) return fail('app_not_found', 'the tagged app does not exist');
    }
    try {
      this.db.run(
        qb
          .insertInto('jobs')
          .values({ name, schedule, command, created_at: Date.now(), app_id: appId ?? null })
          .onConflict(oc =>
            oc.column('name').doUpdateSet(eb => ({
              schedule: eb.ref('excluded.schedule'),
              command: eb.ref('excluded.command'),
              app_id: eb.ref('excluded.app_id'),
            })),
          ),
      );
    } catch (err) {
      return fail('database_error', `could not save job: ${(err as Error).message}`);
    }
    this.warned.delete(name);
    emitDomainEvent({
      topic: 'jobs',
      type: existing.data.value === undefined ? 'job_created' : 'job_updated',
      job: name,
    });
    return { ok: true, resultType: 'save_job', data: { name } } satisfies SaveJobSuccess;
  }

  /** A live run's tmux session is deliberately left alone. */
  async deleteJob(name: JobName) {
    let changed = 0;
    try {
      changed = Number(this.db.run(qb.deleteFrom('jobs').where('name', '=', name)).changes);
      this.db.run(qb.deleteFrom('job_runs').where('job', '=', name));
    } catch (err) {
      return {
        ok: false,
        resultType: 'delete_job',
        data: { name },
        errorCode: 'database_error',
        errorMessage: `could not delete job: ${(err as Error).message}`,
      } satisfies DeleteJobFailure;
    }
    if (changed === 0) {
      return {
        ok: false,
        resultType: 'delete_job',
        data: { name },
        errorCode: 'job_not_found',
        errorMessage: 'no such job',
      } satisfies DeleteJobFailure;
    }
    try {
      // Server-built path (JOB_NAME_RE name): no traversal.
      fs.rmSync(path.join(this.ctx.logDir, name), { recursive: true, force: true });
    } catch (err) {
      log.warn(`could not remove run logs of job ${name}: ${(err as Error).message}`);
    }
    this.warned.delete(name);
    emitDomainEvent({ topic: 'jobs', type: 'job_deleted', job: name });
    return { ok: true, resultType: 'delete_job', data: { name } } satisfies DeleteJobSuccess;
  }

  listRuns(name: JobName): ListRunsResult {
    const fail = (errorCode: ListRunsErrorCode, errorMessage: string) =>
      ({ ok: false, resultType: 'list_runs', errorCode, errorMessage }) satisfies ListRunsFailure;
    const found = this.row(name);
    if (!found.ok) return fail('database_error', found.errorMessage);
    if (found.data.value === undefined) return fail('job_not_found', 'no such job');
    const rows = databaseRead('could not read job runs', () =>
      this.db.all(
        qb
          .selectFrom('job_runs')
          .select(['fired_at', 'origin', 'exit_code', 'finished_at', 'log'])
          .where('job', '=', name)
          .orderBy('fired_at', 'desc')
          .limit(RUN_HISTORY),
      ),
    );
    if (!rows.ok) return fail('database_error', rows.errorMessage);
    return {
      ok: true,
      resultType: 'list_runs',
      data: {
        runs: rows.data.value.map(r => ({
          firedAt: r.fired_at,
          origin: r.origin,
          exitCode: r.exit_code,
          finishedAt: r.finished_at,
          hasLog:
            r.log !== null && fs.existsSync(runLogPaths(this.ctx.logDir, name, r.fired_at).log),
        })),
      },
    } satisfies ListRunsSuccess;
  }

  /** Newest LOG_TAIL_BYTES. The client names the run, never a path. */
  readRunLog(name: JobName, firedAt: number): RunLogResult {
    const fail = (errorCode: RunLogErrorCode, errorMessage: string) =>
      ({ ok: false, resultType: 'run_log', errorCode, errorMessage }) satisfies RunLogFailure;
    const found = this.row(name);
    if (!found.ok) return fail('database_error', found.errorMessage);
    if (found.data.value === undefined) return fail('job_not_found', 'no such job');
    const row = databaseRead(
      'could not read job runs',
      () =>
        this.db.get(
          qb
            .selectFrom('job_runs')
            .select(['fired_at', 'log'])
            .where('job', '=', name)
            .where('fired_at', '=', firedAt),
        ) ?? null,
    );
    if (!row.ok) return fail('database_error', row.errorMessage);
    if (row.data.value === null) return fail('run_not_found', 'no such run');
    if (row.data.value.log === null) return fail('log_missing', 'the run left no log');
    const paths = runLogPaths(this.ctx.logDir, name, row.data.value.fired_at);
    if (!fs.existsSync(paths.log)) return fail('log_missing', 'the run left no log');
    try {
      const fd = fs.openSync(paths.log, 'r');
      try {
        const size = fs.fstatSync(fd).size;
        const len = Math.min(size, LOG_TAIL_BYTES);
        const buf = Buffer.alloc(len);
        // A multi-byte char split at the tail's head decodes to U+FFFD; cosmetic.
        fs.readSync(fd, buf, 0, len, size - len);
        return {
          ok: true,
          resultType: 'run_log',
          data: { text: buf.toString('utf8'), truncated: size > len },
        } satisfies RunLogSuccess;
      } finally {
        fs.closeSync(fd);
      }
    } catch (err) {
      return fail('read_error', `could not read the run log: ${(err as Error).message}`);
    }
  }

  /** Refused with run_active while the previous run is alive, like a scheduled fire. */
  async runJob(name: JobName) {
    const session = jobSessionName(name);
    const fail = (errorCode: RunJobErrorCode, errorMessage: string) =>
      ({
        ok: false,
        resultType: 'run_job',
        data: { name, session },
        errorCode,
        errorMessage,
      }) satisfies RunJobFailure;
    const found = this.row(name);
    if (!found.ok) return fail('database_error', found.errorMessage);
    const row = found.data.value;
    if (!row) return fail('job_not_found', 'no such job');
    if (await hasSession(session)) {
      return fail(
        'run_active',
        'previous run is still active — view it from the console, or kill it first',
      );
    }
    const fired = await this.fire(row, 'manual');
    if (!fired.ok) {
      switch (fired.errorCode) {
        case 'database_error':
          return fail('database_error', fired.errorMessage);
        case 'server_not_running':
        case 'tmux_error':
          return fail('tmux_error', fired.errorMessage);
        default:
          return fired satisfies never;
      }
    }
    return { ok: true, resultType: 'run_job', data: { name, session } } satisfies RunJobSuccess;
  }

  /** Only the job's newest run can be live (the tick and runJob refuse to
   *  overlap), so the named run must be the newest. The finish is observed
   *  on the next tick like any other run end. */
  async killRun(name: JobName, firedAt: number): Promise<KillRunResult> {
    const session = jobSessionName(name);
    const fail = (errorCode: KillRunErrorCode, errorMessage: string) =>
      ({
        ok: false,
        resultType: 'kill_run',
        data: { name, firedAt },
        errorCode,
        errorMessage,
      }) satisfies KillRunFailure;
    const found = this.row(name);
    if (!found.ok) return fail('database_error', found.errorMessage);
    if (found.data.value === undefined) return fail('job_not_found', 'no such job');
    const run = databaseRead(
      'could not read job runs',
      () =>
        this.db.get(
          qb
            .selectFrom('job_runs')
            .select('fired_at')
            .where('job', '=', name)
            .where('fired_at', '=', firedAt),
        ) ?? null,
    );
    if (!run.ok) return fail('database_error', run.errorMessage);
    if (run.data.value === null) return fail('run_not_found', 'no such run');
    const newest = this.lastRun(name);
    if (!newest.ok) return fail('database_error', newest.errorMessage);
    if (newest.data.value?.fired_at !== firedAt) {
      return fail('run_not_active', 'that run is not the current run — a newer one is live');
    }
    if (!(await hasSession(session))) return fail('run_not_active', 'the run is not running');
    const killed = await killSession(session);
    if (!killed) return fail('tmux_error', `could not kill the run session ${session}`);
    emitDomainEvent({ topic: 'jobs', type: 'run_killed', job: name, firedAt });
    log.info(`job ${name} run ${firedAt} killed`);
    return { ok: true, resultType: 'kill_run', data: { name, firedAt } } satisfies KillRunSuccess;
  }
}
