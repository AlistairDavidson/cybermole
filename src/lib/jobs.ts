// jobs.ts — scheduled jobs ("cron") run by an in-process scheduler.
// A job = name + 5-field cron schedule + arbitrary shell command, stored
// in the state db (jobs table, src/lib/db.ts). The Scheduler ticks every
// ~30s and fires due jobs; every run — scheduler-fired or "run now" —
// opens a tmux session `webpi-<name>` on the app's own socket, so runs
// appear in the Live list and are attachable, exactly like a main-page
// session. Replaces the old systemd user-timer backend (DESIGN_REVIEW
// §3.1): jobs now work wherever the app runs, container included, at the
// cost of not firing while the server is down — boot catch-up covers that.
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
import { databaseRead, databaseUpdate, qb, type JobRunOrigin, type StateDb } from './db';
import { componentLogger } from './logger';
import type { CalendarCheck, JobsState, ScheduledJob } from './types';
import { hasSession, jobSessionName, liveSessionNames, newSession } from './tmux';
import type { ResultFailure, ResultSuccess } from '../types/result';
import type { JobName, TmuxSessionName } from '../types/branded';
import { MAX_SCHEDULE, type SaveInput } from '../schemas/jobs';

// ---------- results (HTTP statuses are mapped in the HTTP layer) ----------

export type JobData = { name: JobName };

/** invalid_schedule: the schedule is not valid 5-field cron (the shape —
 *  name, lengths, one line — was already checked by JobSaveSchema). */
export type SaveJobErrorCode = 'invalid_schedule' | 'database_error';
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

export type ListJobsErrorCode = 'database_error';
export type ListJobsSuccess = ResultSuccess<'list_jobs', JobsState>;
export type ListJobsFailure = ResultFailure<'list_jobs', JobsState, ListJobsErrorCode>;
export type ListJobsResult = ListJobsSuccess | ListJobsFailure;

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
    ({ ok: false, resultType: 'next_fire', errorCode: 'invalid_schedule', errorMessage }) satisfies NextFireFailure;
  const fields = schedule.trim().split(/\s+/).filter(Boolean);
  if (fields.length !== 5) return fail('schedule must be 5 cron fields: minute hour day-of-month month day-of-week');
  try {
    const at = CronExpressionParser.parse(fields.join(' '), { currentDate: new Date(afterMs) })
      .next().getTime();
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
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Validate a 5-field cron schedule (the old checkCalendar, now without
 *  systemd-analyze). Same response shape: valid + the first error, or the
 *  next fire time on success. Pure: `nowMs` is injectable for tests. */
export function checkCron(spec: string, nowMs: number = Date.now()): CalendarCheck {
  const by = 'cron-parser' as const;
  const s = spec.trim();
  if (!s) return { valid: false, next: null, error: 'schedule is required', validatedBy: by };
  if (s.length > MAX_SCHEDULE || /[\r\n]/.test(s)) {
    return { valid: false, next: null, error: 'invalid schedule (too long or multi-line)', validatedBy: by };
  }
  const next = nextFireMs(s, nowMs);
  if (!next.ok) return { valid: false, next: null, error: next.errorMessage, validatedBy: by };
  return { valid: true, next: formatFire(next.data.at), error: null, validatedBy: by };
}

// ---------- scheduler ----------

const TICK_MS = 30_000;
/** Run bookkeeping kept per job (only the newest last-fired is read). */
const RUN_HISTORY = 20;

/** How late a fire may be before it counts as catch-up (downtime) rather
 *  than ordinary tick latency — purely for the origin column. */
const CATCHUP_LATENESS_MS = 2 * TICK_MS;

export interface JobContext { cwd: string; env: Record<string, string> }

const log = componentLogger('scheduler');

interface JobRow { name: JobName; schedule: string; command: string; created_at: number }

/** The in-process scheduler: owns the jobs tables in the state db, fires
 *  due jobs into tmux, and serves the /api/jobs operations. */
export class Scheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  /** Jobs whose stored schedule no longer parses (hand-edited db) —
   *  warned about once, then skipped silently until re-saved. */
  private warned = new Set<JobName>();

  constructor(private db: StateDb, private ctx: JobContext) {}

  /** Start the tick loop. No immediate first tick on purpose: the state db
   *  opens lazily (src/lib/db.ts — the e2e webServer boots before
   *  global-setup resets its workspace), and an eager boot tick would
   *  latch a db file the reset then deletes. The first tick (≤ TICK_MS
   *  after boot) doubles as boot catch-up: isDue() treats any window
   *  missed while the server was down as due. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, TICK_MS);
  }

  /** Stop the tick loop. Runs already open in tmux are left alone — they
   *  outlive the scheduler (and, apart from the process, the server). */
  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  // The db boundary: every sqlite call the scheduler makes goes through
  // these (or saveJob/deleteJob's own catch), so a lock timeout or a
  // deleted state db comes back as a database_error result, never a throw.
  // Rows come back typed (and names branded) by the StateSchema in db.ts.
  private rows() {
    return databaseRead('could not read jobs', (): JobRow[] =>
      this.db.all(qb.selectFrom('jobs').select(['name', 'schedule', 'command', 'created_at']).orderBy('name')));
  }

  private row(name: JobName) {
    return databaseRead('could not read job', (): JobRow | undefined =>
      this.db.get(qb.selectFrom('jobs').select(['name', 'schedule', 'command', 'created_at']).where('name', '=', name)));
  }

  private lastFired(name: JobName) {
    // MAX over no rows is NULL — say so (Kysely types max() as the column's type).
    return databaseRead('could not read job runs', () =>
      this.db.get(qb.selectFrom('job_runs').select(eb => eb.fn.max<number | null>('fired_at').as('last'))
        .where('job', '=', name))?.last ?? null);
  }

  private recordRun(name: JobName, origin: JobRunOrigin) {
    return databaseUpdate('could not record the run', () => {
      const inserted = this.db.run(qb.insertInto('job_runs').values({ job: name, fired_at: Date.now(), origin }));
      this.db.run(qb.deleteFrom('job_runs').where('job', '=', name).where('fired_at', 'not in',
        qb.selectFrom('job_runs').select('fired_at').where('job', '=', name)
          .orderBy('fired_at', 'desc').limit(RUN_HISTORY)));
      return inserted;
    });
  }

  private async tick(): Promise<void> {
    if (this.ticking) return; // a slow tmux call must not stack ticks
    this.ticking = true;
    // A db failure ends the tick — the next one retries.
    const failed = (errorMessage: string): void => { log.error(`scheduler tick failed: ${errorMessage}`); };
    try {
      const rows = this.rows();
      if (!rows.ok) { failed(rows.errorMessage); return; }
      const live = await liveSessionNames();
      const now = Date.now();
      for (const row of rows.data.value) {
        // Concurrency: a job whose previous run's tmux session is still
        // alive is skipped — long-running agent jobs don't pile up.
        if (live.has(jobSessionName(row.name))) continue;
        const last = this.lastFired(row.name);
        if (!last.ok) { failed(last.errorMessage); return; }
        const reference = last.data.value ?? row.created_at;
        const next = nextFireMs(row.schedule, reference);
        if (!next.ok) {
          if (!this.warned.has(row.name)) {
            this.warned.add(row.name);
            log.warn(`job ${row.name}: stored schedule "${row.schedule}" does not parse — skipped until re-saved`);
          }
          continue;
        }
        const dueAt = next.data.at;
        if (dueAt <= now) {
          // Boot catch-up equivalent of Persistent=true: whatever windows
          // were missed, this fires ONCE — the recorded fire below resets
          // the reference past all of them.
          const fired = await this.fire(row, now - dueAt > CATCHUP_LATENESS_MS ? 'catchup' : 'schedule');
          if (!fired.ok) {
            switch (fired.errorCode) {
              case 'database_error': failed(fired.errorMessage); return;
              case 'server_not_running':
              case 'tmux_error': break; // logged by fire(); the fire is spent
              default: fired satisfies never;
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

  /** Record the fire, then open the run's tmux session. The run is
   *  recorded FIRST: even a failed spawn must count the fire as spent, or
   *  the next tick would retry it forever — so a fire that cannot be
   *  recorded is not spawned either. */
  private async fire(row: JobRow, origin: JobRunOrigin) {
    const recorded = this.recordRun(row.name, origin);
    if (!recorded.ok) return recorded;
    const session = jobSessionName(row.name);
    log.info(`job ${row.name} fired (${origin}) — opening run session ${session}`);
    const opened = await newSession(session, this.ctx.cwd, ['/bin/sh', '-c', row.command], this.ctx.env);
    if (!opened.ok) log.error(`job ${row.name}: could not open run session ${session} (${opened.errorMessage})`);
    return opened;
  }

  /** List jobs: db definitions + next fire from the schedule + tmux
   *  presence for "a run is live". */
  async listJobs() {
    const fail = (errorMessage: string) =>
      ({ ok: false, resultType: 'list_jobs', errorCode: 'database_error', errorMessage }) satisfies ListJobsFailure;
    const rows = this.rows();
    if (!rows.ok) return fail(rows.errorMessage);
    const live = await liveSessionNames();
    const now = Date.now();
    const jobs: ScheduledJob[] = [];
    for (const row of rows.data.value) {
      // An invalid schedule here is a hand-edited db row; the tick warns once.
      const nextFire = nextFireMs(row.schedule, now);
      const lastRead = this.lastFired(row.name);
      if (!lastRead.ok) return fail(lastRead.errorMessage);
      const last = lastRead.data.value;
      jobs.push({
        name: row.name,
        schedule: row.schedule,
        command: row.command,
        active: nextFire.ok,
        running: live.has(jobSessionName(row.name)),
        session: jobSessionName(row.name),
        next: nextFire.ok ? formatFire(nextFire.data.at) : null,
        last: last === null ? null : formatFire(last),
        lastResult: 'unknown',
      });
    }
    return { ok: true, resultType: 'list_jobs', data: { available: true, detail: null, jobs } } satisfies ListJobsSuccess;
  }

  /** Create or update a job: cron check, then upsert into the db. The
   *  input was parsed by JobSaveSchema at the boundary (name normalized +
   *  branded, schedule/command trimmed and shape-checked). The next tick
   *  (≤30s) picks the new schedule up; a schedule that is already overdue
   *  fires as a catch-up, like systemd's Persistent=true. */
  async saveJob(input: SaveInput) {
    const { name, schedule, command } = input;
    const fail = (errorCode: SaveJobErrorCode, errorMessage: string) =>
      ({ ok: false, resultType: 'save_job', data: { name }, errorCode, errorMessage }) satisfies SaveJobFailure;
    const check = checkCron(schedule);
    if (!check.valid) return fail('invalid_schedule', check.error ?? 'invalid schedule');
    try {
      this.db.run(qb.insertInto('jobs').values({ name, schedule, command, created_at: Date.now() })
        .onConflict(oc => oc.column('name').doUpdateSet(eb => ({
          schedule: eb.ref('excluded.schedule'), command: eb.ref('excluded.command'),
        }))));
    } catch (err) {
      return fail('database_error', `could not save job: ${(err as Error).message}`);
    }
    this.warned.delete(name);
    return { ok: true, resultType: 'save_job', data: { name } } satisfies SaveJobSuccess;
  }

  /** Delete a job: drop its definition and run bookkeeping. A live run's
   *  tmux session is deliberately left alone (kill it from Live). */
  async deleteJob(name: JobName) {
    let changed = 0;
    try {
      changed = Number(this.db.run(qb.deleteFrom('jobs').where('name', '=', name)).changes);
      this.db.run(qb.deleteFrom('job_runs').where('job', '=', name));
    } catch (err) {
      return {
        ok: false, resultType: 'delete_job', data: { name }, errorCode: 'database_error',
        errorMessage: `could not delete job: ${(err as Error).message}`,
      } satisfies DeleteJobFailure;
    }
    if (changed === 0) {
      return {
        ok: false, resultType: 'delete_job', data: { name }, errorCode: 'job_not_found', errorMessage: 'no such job',
      } satisfies DeleteJobFailure;
    }
    this.warned.delete(name);
    return { ok: true, resultType: 'delete_job', data: { name } } satisfies DeleteJobSuccess;
  }

  /** Run a job now (records origin 'manual'). Refused (run_active) while
   *  the previous run's session is still alive — the same semantics a
   *  scheduler fire has. */
  async runJob(name: JobName) {
    const session = jobSessionName(name);
    const fail = (errorCode: RunJobErrorCode, errorMessage: string) =>
      ({ ok: false, resultType: 'run_job', data: { name, session }, errorCode, errorMessage }) satisfies RunJobFailure;
    const found = this.row(name);
    if (!found.ok) return fail('database_error', found.errorMessage);
    const row = found.data.value;
    if (!row) return fail('job_not_found', 'no such job');
    if (await hasSession(session)) {
      return fail('run_active', 'previous run is still active — attach to it from Live, or kill it first');
    }
    const fired = await this.fire(row, 'manual');
    if (!fired.ok) {
      switch (fired.errorCode) {
        case 'database_error': return fail('database_error', fired.errorMessage);
        case 'server_not_running':
        case 'tmux_error': return fail('tmux_error', fired.errorMessage);
        default: return fired satisfies never;
      }
    }
    return { ok: true, resultType: 'run_job', data: { name, session } } satisfies RunJobSuccess;
  }
}
