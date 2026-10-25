// jobs.ts — scheduled jobs ("cron") run by an in-process scheduler.
// A job = name + 5-field cron schedule + arbitrary shell command, stored
// in the state db (jobs table, src/lib/platform/db.ts). The Scheduler ticks every
// ~30s and fires due jobs; every run — scheduler-fired or "run now" —
// opens a tmux session `cybermole-<name>` on the app's own socket, so the
// jobs page can show a run as live and link its console view (/?run=)
// at it. Since plan §9 every fire also persists a DURABLE run log + exit
// code under the workspace-side log dir: the wrapper argv (runCommandArgv)
// appends output to a log file through a write-time-capped appender
// (job-log-appender.ts, plan §8) and captures the command's exit INSIDE
// the pipeline; the tick's finish observation reads the exit file back into
// job_runs (exit_code/finished_at), and pruning (RUN_HISTORY) unlinks
// the pruned runs' files. Replaces the old systemd user-timer backend
// (DESIGN_REVIEW §3.1): jobs now work wherever the app runs, container
// included, at the cost of not firing while the server is down — boot
// catch-up covers that.
//
// SECURITY INVARIANT: job names are validated (JOB_NAME_RE) before they
// touch the db or tmux — every entry point takes a JobName, which
// untrusted input only gets by passing JobNameSchema / JobSaveSchema
// (src/schemas) at the request boundary — and commands are arbitrary shell strings BY
// DESIGN (typed by the authenticated user, at a web shell's privilege) —
// but a command only ever reaches tmux as tmux's own command string,
// passed as argv elements to execFile: never through a server-side
// shell. argv-array spawns only.
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

// ---------- results (HTTP statuses are mapped in the HTTP layer) ----------

export type JobData = { name: JobName };

/** invalid_schedule: the schedule is not valid 5-field cron (the shape —
 *  name, lengths, one line — was already checked by JobSaveSchema).
 *  app_not_found: the optional tag names an app row that does not exist
 *  (pre-checked, not FK-message-sniffed — plan §2). */
export type SaveJobErrorCode = 'invalid_schedule' | 'app_not_found' | 'database_error';
export type SaveJobSuccess = ResultSuccess<'save_job', JobData>;
export type SaveJobFailure = ResultFailure<'save_job', JobData, SaveJobErrorCode>;
export type SaveJobResult = SaveJobSuccess | SaveJobFailure;

export type DeleteJobErrorCode = 'job_not_found' | 'database_error';
export type DeleteJobSuccess = ResultSuccess<'delete_job', JobData>;
export type DeleteJobFailure = ResultFailure<'delete_job', JobData, DeleteJobErrorCode>;
export type DeleteJobResult = DeleteJobSuccess | DeleteJobFailure;

export type RunJobData = { name: JobName; session: TmuxSessionName };
/** run_active: the previous run's session is still alive (409).
 *  tmux_error: the run session could not be opened. database_error: the
 *  job could not be read, or the fire could not be recorded (and so was
 *  not spawned). */
export type RunJobErrorCode = 'job_not_found' | 'run_active' | 'tmux_error' | 'database_error';
export type RunJobSuccess = ResultSuccess<'run_job', RunJobData>;
export type RunJobFailure = ResultFailure<'run_job', RunJobData, RunJobErrorCode>;
export type RunJobResult = RunJobSuccess | RunJobFailure;

/** Kill a job's live run (its tmux session). run_not_found: no run row
 *  with that fired_at. run_not_active: the run is not the job's CURRENT
 *  live run — already finished, or a newer run is the live one (a stale
 *  fired_at must never kill a newer run). tmux_error: the kill-session
 *  call itself failed. Service-level on purpose: the internal API's kill
 *  route (plan §4) calls THIS — and the run_killed event (plan §7) fires
 *  here for every killer. No browser route yet — the console view remains
 *  the human's kill path. */
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

/** One job's stored definition — the internal API's PATCH route's
 *  read-merge-write source (task/jobs-socket, plan §4). */
export type GetJobData = { name: JobName; schedule: string; command: string; appId: AppId | null };
export type GetJobErrorCode = 'job_not_found' | 'database_error';
export type GetJobSuccess = ResultSuccess<'get_job', GetJobData>;
export type GetJobFailure = ResultFailure<'get_job', GetJobData, GetJobErrorCode>;
export type GetJobResult = GetJobSuccess | GetJobFailure;

/** One run-history row (GET /api/jobs/:name/runs). hasLog is honest
 *  about the FILE, not the column: a fire whose wrapper could not create
 *  it (log dir unwritable) leaves hasLog false. */
export interface JobRunView {
  /** epoch ms the run's tmux session opened (the run's identity) */
  firedAt: number;
  origin: JobRunOrigin;
  /** the command's exit code, filled when the finish was observed and
   *  the exit file was readable; null = not (yet) known */
  exitCode: number | null;
  /** epoch ms the finish was observed (tick granularity); null while
   *  the run lives (or if it ended unseen) */
  finishedAt: number | null;
  hasLog: boolean;
}
export type ListRunsData = { runs: JobRunView[] };
export type ListRunsErrorCode = 'job_not_found' | 'database_error';
export type ListRunsSuccess = ResultSuccess<'list_runs', ListRunsData>;
export type ListRunsFailure = ResultFailure<'list_runs', ListRunsData, ListRunsErrorCode>;
export type ListRunsResult = ListRunsSuccess | ListRunsFailure;

/** The run's log tail (GET /api/jobs/:name/runs/:fired_at/log). */
export type RunLogData = { text: string; truncated: boolean };
/** log_missing: the run was fired without logging (pre-v6 row) or the
 *  wrapper never created the file. read_error: the file is there but
 *  could not be read (perms, vanished mid-read). */
export type RunLogErrorCode =
  'job_not_found' | 'run_not_found' | 'log_missing' | 'read_error' | 'database_error';
export type RunLogSuccess = ResultSuccess<'run_log', RunLogData>;
export type RunLogFailure = ResultFailure<'run_log', RunLogData, RunLogErrorCode>;
export type RunLogResult = RunLogSuccess | RunLogFailure;

/** at: epoch ms of the fire. */
export type NextFireData = { at: number };
export type NextFireErrorCode = 'invalid_schedule';
export type NextFireSuccess = ResultSuccess<'next_fire', NextFireData>;
export type NextFireFailure = ResultFailure<'next_fire', NextFireData, NextFireErrorCode>;
export type NextFireResult = NextFireSuccess | NextFireFailure;

// ---------- cron computation (pure — unit-tested with a fake now) ----------
// cron-parser takes 6/7-field expressions and even an empty string; the
// jobs UI is 5-field cron only, so the field count is enforced here first.

/** The next fire STRICTLY AFTER afterMs. cron-parser's next() never
 *  returns currentDate itself, so a fire at exactly the boundary is not
 *  counted twice. Fields are interpreted in the server's local time.
 *  invalid_schedule — including a field count other than 5: cron-parser
 *  would happily take 6/7-field (and shorter) expressions, but the jobs UI
 *  is 5-field cron only. The boundary for cron-parser's throws. */
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

/** Is a run due at nowMs, given the job's last fire (or its creation,
 *  before the first fire) at referenceMs? Due = the next fire after the
 *  reference has passed. The same check covers live ticking (≤ one tick
 *  of latency) and boot catch-up after downtime: any number of missed
 *  windows collapses into this one boolean, and firing re-records
 *  last-fired, so catch-up is ONE run per job per downtime — systemd's
 *  Persistent=true semantics, minus the pile-up. Can't fail by design: an
 *  invalid schedule is never due (the tick skips such rows the same way). */
export function isDue(schedule: string, referenceMs: number, nowMs: number): boolean {
  const next = nextFireMs(schedule, referenceMs);
  return next.ok && next.data.at <= nowMs;
}

/** One actionable line out of a cron-parser rejection. */
function cronError(err: unknown): string {
  const msg = (err instanceof Error ? err.message : String(err)).split('\n')[0] ?? '';
  return msg.trim() || 'invalid cron schedule';
}

/** Local-time "YYYY-MM-DD HH:mm" — the schedule fields are local time, so
 *  the display is too. */
function formatFire(ms: number): string {
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}`
  );
}

/** Validate a 5-field cron schedule (the old checkCalendar, now without
 *  systemd-analyze). Same response shape: valid + the first error, or the
 *  next fire time on success. Pure: `nowMs` is injectable for tests. */
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

// ---------- run files (plan §9) ----------

/** The log tail cap (GET …/log): the newest 1 MiB. Independent of the
 *  FILE's own write-time cap (plan §8, ctx.logMaxBytes): the read tail
 *  bounds what a response carries, the appender bounds what a run may
 *  put on disk while it lives. */
const LOG_TAIL_BYTES = 1024 * 1024;

/** Log + exit file paths for one run. Pure and shared by every side of
 *  the feature — the fire (wrapper argv + the persisted `log` column),
 *  the finish observation (exit file), the log route and pruning — so
 *  the pair is always consistent: nothing but `log` is persisted, and
 *  `firedAt` is unique per job (recordRun keeps it monotonic). */
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

/** The bundled log appender (src/lib/jobs/job-log-appender.ts), compiled next
 *  to this module. Resolved from THIS module's own location at load — the
 *  CommonJS build's equivalent of import.meta.url — never from cwd: the
 *  server process's cwd is unrelated, and the script must sit at a stable
 *  absolute path for the wrapper, which executes it inside the WORKSPACE
 *  container's tmux session (both containers of the split ship the same
 *  image at /opt/cybermole, so this module's directory there is this one). */
const LOG_APPENDER = path.join(__dirname, 'job-log-appender.js');

/** The wrapper every fire runs instead of the bare command (plan §9's
 *  exact argv shape, §8's sink — unit-tested as a pure function). The user
 *  command is $1, an ARGV element of an inner /bin/sh -c — never
 *  string-embedded into the wrapper (`{ <command>; }` breaks on a `#`
 *  comment, and any interpolation is a quoting lottery). NO pipefail:
 *  dash rejects `set -o pipefail`, and without it `$?` after
 *  `cmd | appender` is the APPENDER's — so the exit code is captured
 *  INSIDE the pipeline, before the appender, into $3. The wrapper's own
 *  exit (the appender's) is irrelevant — the code is read from the file.
 *  The appender ($4) caps the log at maxBytes ($5, ctx.logMaxBytes —
 *  CYBERMOLE_JOB_LOG_MAX) and never closes the pipe early, so a chatty or
 *  runaway job can neither fill the disk mid-run nor die of a SIGPIPE
 *  (plan §8). A failed mkdir/appender must not kill the run: output is
 *  lost, the exit file never appears, the run's result stays 'unknown'. */
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
/** Run bookkeeping kept per job (only the newest last-fired is read). */
const RUN_HISTORY = 20;

/** How late a fire may be before it counts as catch-up (downtime) rather
 *  than ordinary tick latency — purely for the origin column. */
const CATCHUP_LATENESS_MS = 2 * TICK_MS;

export interface JobContext {
  cwd: string;
  env: Record<string, string>;
  /** Run-log root (CYBERMOLE_JOB_LOG_DIR; /workspace/.cybermole/job-logs in the
   *  compose split — a path that exists in BOTH containers, plan §9). */
  logDir: string;
  /** The write-time cap each run's log is appended under (plan §8,
   *  CYBERMOLE_JOB_LOG_MAX): the wrapper's appender stops writing past this
   *  many bytes — one "[truncated at N bytes]" marker — while still
   *  draining the job's output. */
  logMaxBytes: number;
}

// ---------- domain events (plan §7 — emit at the choke points only) ----------

// Every emitDomainEvent call in this file sits INSIDE a service function
// (saveJob / deleteJob / fire / observeFinish / killRun), because every
// caller funnels through exactly those: the browser's /api/jobs routes,
// the internal socket API's routes (plan §4 — they call these same
// functions, never a parallel path), the scheduler tick and run-now
// (both go through fire), and kills. That placement is the whole
// guarantee: the event fires identically whoever acted, and no HTTP
// route can bypass it. /ws/events (src/lib/platform/events-ws.ts) forwards the
// events; the pages refresh on them.

/** The shared fire-success emission: a run was recorded AND its session
 *  opened — run-now, the tick and catch-up all land here. */
function emitRunStarted(job: JobName, firedAt: number): void {
  emitDomainEvent({ topic: 'jobs', type: 'run_started', job, firedAt });
}

const log = componentLogger('scheduler');

interface JobRow {
  name: JobName;
  schedule: string;
  command: string;
  created_at: number;
  /** the optional app tag + its display name (listJobs' LEFT JOIN) */
  appId: AppId | null;
  appName: string | null;
}

/** A run whose finish the tick is armed to observe: the job plus the
 *  fire's fired_at when this process opened the run (exact row), null
 *  when it armed a session it found already live (boot / out-of-band —
 *  the newest row of that job at finish time). */
interface ArmedRun {
  job: JobName;
  firedAt: number | null;
}

/** The in-process scheduler: owns the jobs tables in the state db, fires
 *  due jobs into tmux, and serves the /api/jobs operations. */
export class Scheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  /** Jobs whose stored schedule no longer parses (hand-edited db) —
   *  warned about once, then skipped silently until re-saved. */
  private warned = new Set<JobName>();
  /** Run sessions armed as live, run session → the run whose end the
   *  tick observes (see ArmedRun). Armed when a run opens (fire below)
   *  and at the tick's skip point (runs opened outside the tick: "run
   *  now", or alive at boot); a session that leaves the live set at a
   *  later tick has finished — completed, killed, or restarted away on
   *  the workspace side — and gets its exit code + finish recorded (or
   *  'unknown', when the exit file is missing). Armed at open, not at
   *  first sight: a run's end is reported by the first tick after it,
   *  and only a run that ends before any tick of this process could
   *  see it — while the server is down — is only counted as fired. */
  private running = new Map<TmuxSessionName, ArmedRun>();

  constructor(
    private db: StateDb,
    private ctx: JobContext,
  ) {}

  /** Start the tick loop. No immediate first tick on purpose: the state db
   *  opens lazily (src/lib/platform/db.ts — the e2e webServer boots before
   *  global-setup resets its workspace), and an eager boot tick would
   *  latch a db file the reset then deletes. The first tick (≤ TICK_MS
   *  after boot) doubles as boot catch-up: isDue() treats any window
   *  missed while the server was down as due. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, TICK_MS);
  }

  /** Stop the tick loop. Runs already open in tmux are left alone — they
   *  outlive the scheduler (and, apart from the process, the server). */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // The db boundary: every sqlite call the scheduler makes goes through
  // these (or saveJob/deleteJob's own catch), so a lock timeout or a
  // deleted state db comes back as a database_error result, never a throw.
  // Rows come back typed (and names branded) by the StateSchema in db.ts.
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

  /** The newest run row of a job (fired_at + exit_code) — listJobs'
   *  last-fired/lastResult source; MAX(fired_at) via the (job, fired_at)
   *  index, order+limit instead of the aggregate so the code comes along. */
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

  /** Record a fire and prune the run history. fired_at is kept monotonic
   *  per job (never the last row's value): it is the run's identity — the
   *  log file's name and the /runs/:fired_at path param. Returns the
   *  fired_at + the run's file paths so the fire can build the wrapper
   *  argv with exactly what was persisted. */
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

  /** RUN_HISTORY pruning, files first: the doomed rows' paths are
   *  SELECTed BEFORE the DELETE (they are gone after), the log + exit
   *  files unlinked best-effort (a read-only mount or a perms failure is
   *  logged and swallowed — the rows are pruned regardless), then the
   *  rows deleted (plan §9). */
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

  /** Best-effort unlink of one run's log + exit files (pruning, and a
   *  deleted job's whole history). */
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
    // A db failure ends the tick — the next one retries.
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
      // Run-finish observation (this.running): an armed run session that
      // is no longer live has ended. Map deletion during iteration is
      // safe; entries can only outlive their run by one tick. The exit
      // file read + row update inside are fail-soft — an observation
      // failure is logged, never takes the tick down.
      for (const [session, armed] of this.running) {
        if (live.has(session)) continue;
        this.running.delete(session);
        this.observeFinish(session, armed);
      }
      const now = Date.now();
      for (const row of rows.data.value) {
        const session = jobSessionName(row.name);
        // Concurrency: a job whose previous run's tmux session is still
        // alive is skipped — long-running agent jobs don't pile up — and
        // (re-)armed so its end is reported. An entry this process armed
        // at open keeps its exact fired_at (a later fire that failed to
        // spawn must not steal the finish); the skip-point arm is for
        // sessions opened outside the tick ("run now", alive at boot).
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
          // Boot catch-up equivalent of Persistent=true: whatever windows
          // were missed, this fires ONCE — the recorded fire below resets
          // the reference past all of them.
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
                break; // logged by fire(); the fire is spent
              default:
                fired satisfies never;
            }
          }
        }
      }
    } catch (err) {
      // Crash guard only (db and tmux failures come back as results): a
      // tick must never take the server (and, in the container, every
      // tmux session with it) down via an unhandled rejection.
      log.error(`scheduler tick failed: ${(err as Error)?.message ?? err}`);
    } finally {
      this.ticking = false;
    }
  }

  /** A run session left the live set: fill its row's exit_code +
   *  finished_at from the exit file the wrapper wrote (plan §9). The
   *  exit code lives in the FILE — the wrapper's own exit status is the
   *  appender's — and a missing/unreadable file leaves exit_code NULL: the
   *  run's result stays 'unknown' (never guessed). finished_at is the
   *  observation time (tick granularity, ≤ TICK_MS after the end). */
  private observeFinish(session: TmuxSessionName, armed: ArmedRun): void {
    const read = databaseRead(
      'could not read job runs',
      () =>
        (armed.firedAt === null
          ? this.db.get(
              qb
                .selectFrom('job_runs')
                .select(['fired_at', 'log'])
                .where('job', '=', armed.job)
                .orderBy('fired_at', 'desc')
                .limit(1),
            )
          : this.db.get(
              qb
                .selectFrom('job_runs')
                .select(['fired_at', 'log'])
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
        // `echo $?`: 0–255, three digits max — anything else (truncated
        // write, garbage) reads as unknown.
        if (/^\d{1,3}$/.test(raw)) exitCode = Number(raw);
      } catch {
        /* no exit file → unknown, by design */
      }
    }
    if (run !== null) {
      const updated = databaseUpdate('could not record the run finish', () =>
        this.db.run(
          qb
            .updateTable('job_runs')
            .set({ exit_code: exitCode, finished_at: Date.now() })
            .where('job', '=', armed.job)
            .where('fired_at', '=', run.fired_at),
        ),
      );
      if (!updated.ok) log.error(`job ${armed.job}: ${updated.errorMessage}`);
      else
        emitDomainEvent({
          topic: 'jobs',
          type: 'run_finished',
          job: armed.job,
          firedAt: run.fired_at,
        });
    }
    log.info(
      `job ${armed.job} run finished (run session ${session} gone, ` +
        `exit ${exitCode === null ? 'unknown' : exitCode})`,
    );
  }

  /** Record the fire, then open the run's tmux session. The run is
   *  recorded FIRST: even a failed spawn must count the fire as spent, or
   *  the next tick would retry it forever — so a fire that cannot be
   *  recorded is not spawned either. The command runs wrapped
   *  (runCommandArgv): its output is appended to the run's log file through
   *  the capped appender (plan §8) and its exit code captured for the
   *  finish observation. */
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
      this.running.set(session, { job: row.name, firedAt: recorded.firedAt }); // armed — its end gets the finish line
      emitRunStarted(row.name, recorded.firedAt);
    }
    return opened;
  }

  /** List jobs: db definitions + next fire from the schedule + tmux
   *  presence for "a run is live" + the app tag (LEFT JOIN — the page
   *  makes no second fetch). */
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
      // An invalid schedule here is a hand-edited db row; the tick warns once.
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
        // The last run's outcome, from the observed exit code — unknown
        // until the finish was observed AND the exit file was readable.
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

  /** One job's stored definition (the internal API's PATCH route merges
   *  into it and saves through saveJob — plan §4). Sync: a pure db read
   *  through the row() boundary. */
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

  /** Create or update a job: cron check, optional app-tag check, then
   *  upsert into the db. The input was parsed by JobSaveSchema at the
   *  boundary (name normalized + branded, schedule/command trimmed and
   * shape-checked). The tag is checked against the apps table BEFORE the
   *  write (constraint violations are closed codes, never message-sniffed
   *  — plan §2; the residual check-then-insert race degrades to
   *  database_error). The next tick (≤30s) picks the new schedule up; a
   *  schedule that is already overdue fires as a catch-up, like
   *  systemd's Persistent=true. */
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
    // Created vs updated (the event below): read BEFORE the upsert. The
    // residual read-then-write race degrades to job_updated — harmless,
    // the page refresh either way.
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

  /** Delete a job: drop its definition and run bookkeeping — and the
   *  run files with them (best-effort, after the rows are gone). A live
   *  run's tmux session is deliberately left alone (kill it via its
   *  console view). */
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
      // The job's log dir is server-built (logDir + a JOB_NAME_RE name —
      // no traversals); recursive + force swallow a missing dir.
      fs.rmSync(path.join(this.ctx.logDir, name), { recursive: true, force: true });
    } catch (err) {
      log.warn(`could not remove run logs of job ${name}: ${(err as Error).message}`);
    }
    this.warned.delete(name);
    emitDomainEvent({ topic: 'jobs', type: 'job_deleted', job: name });
    return { ok: true, resultType: 'delete_job', data: { name } } satisfies DeleteJobSuccess;
  }

  /** The job's run history, newest first (GET /api/jobs/:name/runs) —
   *  capped at RUN_HISTORY, like the pruning that enforces it. */
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

  /** One run's log TAIL (≤ LOG_TAIL_BYTES, the newest bytes — GET
   *  /api/jobs/:name/runs/:fired_at/log). The path is built server-side
   *  from the row + the configured log root; the client only ever names
   *  the run (job + integer fired_at), never a path. */
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
        // A multi-byte char split at the head of the tail decodes to
        // U+FFFD — cosmetic, and only in a >1 MiB log's first char.
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

  /** Run a job now (records origin 'manual'). Refused (run_active) while
   *  the previous run's session is still alive — the same semantics a
   *  scheduler fire has. */
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

  /** Kill the job's live run (the internal API's run-kill verb, plan §4).
   *  The named run row must exist AND be the job's newest — a live
   *  session can only be the newest run's (the tick skips a job whose
   *  session is live, and runJob refuses one), so a stale fired_at can
   *  never kill a NEWER run it didn't name. The kill itself is tmux's
   *  best-effort kill-session; the finish observation (exit 'unknown'
   *  unless the wrapper got its echo $? out before the SIGHUP) lands on
   *  the next tick like any run end — which then emits run_finished
   *  after this emits run_killed (plan §7: whoever kills, the event
   *  fires here — the service layer is the single source of truth). */
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
