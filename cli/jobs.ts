// jobs.ts — the `cybermole-cli jobs` verb group (task/jobs-cli,
// docs/plans/jobs-agent-plan.md §5): every user action on the /jobs page has
// a verb here, and each verb is a THIN client over the internal API's
// route of the same meaning (server/internal-api.ts, plan §4) — same
// path, same body, same answer; no parallel logic to drift. Human
// output is tables and one-liners; --json prints the server's body
// verbatim for scripting. The help text below is the agent-facing
// documentation (plan §5's parity line: self-describing, no discovery
// round-trip needed).
//
// Exit codes: 0 success · 1 the operation failed (the server's error
// answer, or no server on the socket) · 2 usage error. validate is the
// one nuance: its ANSWER is the validity, so 0 = all valid,
// 1 = something invalid — still printed, still --json-able.
import { discoverInternalSocket, internalRequest } from './client';
import { formatLocalMs, renderTable, truncate, type ApiResponse, type Output } from './output';
import { parseArgs, type ArgSpec, type ParsedArgs } from './args';

// ---------- the wire (the internal API's bodies, typed for the CLI) ----------

/** One ScheduledJob as GET /jobs answers it (src/lib/jobs.ts listJobs). */
interface JobView {
  name: string;
  schedule: string;
  command: string;
  appId: string | null;
  appName: string | null;
  active: boolean;
  running: boolean;
  session: string;
  /** "YYYY-MM-DD HH:mm" (local), pre-formatted server-side */
  next: string | null;
  last: string | null;
  lastResult: 'success' | 'failed' | 'unknown';
}
interface JobsBody {
  jobs: JobView[];
}
/** One run-history row (GET /jobs/:name/runs) — firedAt is the run's
 *  identity (the log/kill path params). */
interface RunView {
  firedAt: number;
  origin: string;
  exitCode: number | null;
  finishedAt: number | null;
  hasLog: boolean;
}
interface RunsBody {
  runs: RunView[];
}
/** POST /jobs/validate's answer: each present field's check, absent
 *  fields null — an invalid value is an ANSWER (200), not a failure. */
interface CalendarCheckView {
  valid: boolean;
  next: string | null;
  error: string | null;
}
interface ValidateBody {
  schedule: CalendarCheckView | null;
  command: { valid: boolean; error: string | null } | null;
}
/** The failure body every route answers with ({ error, detail, code,
 *  issues? } — src/lib/web/responses.service.ts): the `error` text is
 *  the same one the /jobs page shows. */
interface FailureBody {
  error?: string;
  detail?: string | null;
  code?: string;
  issues?: Record<string, string>;
}

function parseJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

// ---------- verb plumbing ----------

interface VerbContext {
  io: Output;
  json: boolean;
  socketPath: string;
}

/** Failure codes → a short human line, for the never-today case of a
 *  body arriving without its `error` text. The body's own error/detail
 *  is always preferred (it is the message /jobs shows, and it is where
 *  new codes surface first). */
const CODE_FALLBACK: Record<string, string> = {
  validation_failure: 'the request body did not validate',
  invalid_schedule: 'invalid schedule',
  invalid_job_name: 'invalid job name',
  invalid_fired_at: 'invalid firedAt (integer epoch ms)',
  invalid_app_slug: 'invalid app slug',
  app_not_found: 'no such app',
  job_not_found: 'no such job',
  run_not_found: 'no such run',
  run_not_active: "that run is not the job's current live run",
  run_active: 'a previous run is still active',
  log_missing: 'the run left no log',
  read_error: 'could not read the run log',
  tmux_error: 'tmux error',
  database_error: 'database error',
  unsupported_content_type: 'unsupported content type',
  invalid_json: 'invalid JSON',
  body_too_large: 'request body too large',
  length_required: 'request body needs a Content-Length',
  not_found: 'not found',
  bad_request: 'bad request',
  internal_error: 'internal error',
};

/** One failure answer: short human message + code on stderr (the raw
 *  body with --json), per-field issues when the server sent them. */
function printFailure(ctx: VerbContext, response: ApiResponse): void {
  if (ctx.json) {
    ctx.io.out(response.text);
    return;
  }
  const body = parseJson<FailureBody>(response.text);
  if (body === null) {
    ctx.io.err(`cybermole-cli: the server answered ${response.status}:\n${response.text}`);
    return;
  }
  const head =
    body.error ?? CODE_FALLBACK[body.code ?? ''] ?? `the server answered ${response.status}`;
  const code = body.code === undefined ? '' : ` (code: ${body.code})`;
  ctx.io.err(`cybermole-cli: ${head}${code}`);
  if (typeof body.detail === 'string' && body.detail !== '') ctx.io.err(`  ${body.detail}`);
  if (body.issues !== undefined) {
    for (const [field, message] of Object.entries(body.issues)) {
      // the head line is the first issue ('field: message') — don't echo it
      if (`${field}: ${message}` !== head) ctx.io.err(`  ${field}: ${message}`);
    }
  }
}

/** One request from a verb. Non-2xx → the failure is printed (see
 *  printFailure) and null returns, so the verb's failure path is just
 *  `return 1`. 2xx → the parsed body plus the raw response (--json
 *  prints it verbatim). */
async function api<T extends object>(
  ctx: VerbContext,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  urlPath: string,
  body?: string,
): Promise<{ response: ApiResponse; body: T } | null> {
  const response = await internalRequest(ctx.socketPath, method, urlPath, body);
  if (response.status < 200 || response.status >= 300) {
    printFailure(ctx, response);
    return null;
  }
  const parsed = parseJson<T>(response.text);
  if (parsed === null) {
    ctx.io.err(
      `cybermole-cli: the server answered ${response.status} with a body that is not JSON — ` +
        `report this. Raw body:\n${response.text}`,
    );
    return null;
  }
  return { response, body: parsed };
}

/** A usage error: the message, the verb's usage line, the way out. */
function usage(ctx: VerbContext, message: string, usageLine: string): number {
  ctx.io.err(`cybermole-cli: ${message}`);
  ctx.io.err(`usage: ${usageLine}`);
  ctx.io.err('try: cybermole-cli jobs --help');
  return 2;
}

/** A /jobs/… path with every segment escaped (names and firedAts are
 *  CLI arguments — never spliced raw into the path). */
function jobPath(...segments: string[]): string {
  return `/${segments.map(s => encodeURIComponent(s)).join('/')}`;
}

/** A value option's value (undefined for absent — never a flag's true). */
function valueOf(options: Record<string, string | boolean>, name: string): string | undefined {
  const v = options[name];
  return typeof v === 'string' ? v : undefined;
}

// ---------- the verbs (plan §4's routes, one client each) ----------

/** GET /jobs — the /jobs page's list. */
async function listVerb(ctx: VerbContext, args: ParsedArgs): Promise<number> {
  const USAGE = 'cybermole-cli jobs list [-a <app-slug>] [--json]';
  if (args.positionals.length > 0) return usage(ctx, 'list takes no positional arguments', USAGE);
  const app = valueOf(args.options, '--app');
  const url = app === undefined ? '/jobs' : `/jobs?app=${encodeURIComponent(app)}`;
  const answer = await api<JobsBody>(ctx, 'GET', url);
  if (answer === null) return 1;
  if (ctx.json) {
    ctx.io.out(answer.response.text);
    return 0;
  }
  const jobs = answer.body.jobs;
  if (jobs.length === 0) {
    ctx.io.out(app === undefined ? 'no jobs\n' : `no jobs tagged app '${app}'\n`);
    return 0;
  }
  const rows = jobs.map(j => [
    j.name,
    j.schedule,
    truncate(j.command, 40),
    j.appName ?? '—',
    j.active ? (j.next ?? '—') : 'invalid schedule',
    j.running ? 'live' : '—',
  ]);
  ctx.io.out(`${renderTable(['NAME', 'SCHEDULE', 'COMMAND', 'APP', 'NEXT', 'RUN'], rows)}\n`);
  return 0;
}

/** GET /jobs/:name/runs — the job's run history. */
async function runsVerb(ctx: VerbContext, args: ParsedArgs): Promise<number> {
  const USAGE = 'cybermole-cli jobs runs <name> [--json]';
  if (args.positionals.length !== 1) return usage(ctx, 'runs takes exactly one job name', USAGE);
  const name = args.positionals[0] ?? '';
  const answer = await api<RunsBody>(ctx, 'GET', jobPath('jobs', name, 'runs'));
  if (answer === null) return 1;
  if (ctx.json) {
    ctx.io.out(answer.response.text);
    return 0;
  }
  const runs = answer.body.runs;
  if (runs.length === 0) {
    ctx.io.out(`no runs recorded for ${name}\n`);
    return 0;
  }
  const rows = runs.map(r => [
    String(r.firedAt),
    formatLocalMs(r.firedAt),
    r.origin,
    r.exitCode === null ? '?' : String(r.exitCode),
    r.finishedAt === null ? '—' : formatLocalMs(r.finishedAt),
    r.hasLog ? 'yes' : 'no',
  ]);
  ctx.io.out(`${renderTable(['FIRED-AT', 'AT', 'ORIGIN', 'EXIT', 'FINISHED', 'LOG'], rows)}\n`);
  return 0;
}

/** GET /jobs/:name/runs/:firedAt/log — the run's log tail (text/plain:
 *  the one non-JSON success body, printed verbatim; --json wraps it so
 *  the flag always means valid JSON on stdout). */
async function logVerb(ctx: VerbContext, args: ParsedArgs): Promise<number> {
  const USAGE = 'cybermole-cli jobs log <name> <firedAt> [--json]';
  if (args.positionals.length !== 2)
    return usage(ctx, 'log takes a job name and a firedAt (epoch ms — copy it from `runs`)', USAGE);
  const name = args.positionals[0] ?? '';
  const firedAt = args.positionals[1] ?? '';
  const response = await internalRequest(
    ctx.socketPath,
    'GET',
    jobPath('jobs', name, 'runs', firedAt, 'log'),
  );
  if (response.status !== 200) {
    printFailure(ctx, response);
    return 1;
  }
  const truncated = response.headers['x-run-log-truncated'] !== undefined;
  if (ctx.json) {
    ctx.io.out(
      `${JSON.stringify({ name, firedAt: Number(firedAt), truncated, text: response.text }, null, 2)}\n`,
    );
    return 0;
  }
  ctx.io.out(response.text);
  if (truncated) ctx.io.err('note: the log is over the 1 MiB tail — the newest bytes are shown\n');
  return 0;
}

/** POST /jobs — create, or overwrite a same-named job (the browser
 *  form's save is the same upsert; the CLI verb keeps the page's name). */
async function createVerb(ctx: VerbContext, args: ParsedArgs): Promise<number> {
  const USAGE =
    'cybermole-cli jobs create --name <name> --schedule <cron> --command <cmd> [--app <app-id>] [--json]';
  if (args.positionals.length > 0) return usage(ctx, 'create takes no positional arguments', USAGE);
  const name = valueOf(args.options, '--name');
  const schedule = valueOf(args.options, '--schedule');
  const command = valueOf(args.options, '--command');
  const app = valueOf(args.options, '--app');
  if (name === undefined || schedule === undefined || command === undefined) {
    return usage(ctx, 'create needs --name, --schedule and --command', USAGE);
  }
  // the browser save sends appId: null when the picker is empty (jobs-app.ts)
  const answer = await api<{ name: string; session: string | null }>(
    ctx,
    'POST',
    '/jobs',
    JSON.stringify({ name, schedule, command, appId: app === undefined ? null : app }),
  );
  if (answer === null) return 1;
  if (ctx.json) {
    ctx.io.out(answer.response.text);
    return 0;
  }
  ctx.io.out(`job ${answer.body.name} saved\n`);
  return 0;
}

/** PATCH /jobs/:name — set fields; absent keeps the stored value, null
 *  clears the app tag (the internal route's read-merge-write contract). */
async function setVerb(ctx: VerbContext, args: ParsedArgs): Promise<number> {
  const USAGE =
    'cybermole-cli jobs set <name> [--schedule <cron>] [--command <cmd>] [--app <app-id> | --clear-app] [--json]';
  if (args.positionals.length !== 1) return usage(ctx, 'set takes exactly one job name', USAGE);
  const name = args.positionals[0] ?? '';
  const schedule = valueOf(args.options, '--schedule');
  const command = valueOf(args.options, '--command');
  const app = valueOf(args.options, '--app');
  const clearApp = args.options['--clear-app'] === true;
  if (schedule === undefined && command === undefined && app === undefined && !clearApp) {
    return usage(ctx, 'nothing to set — pass --schedule, --command, --app or --clear-app', USAGE);
  }
  if (app !== undefined && clearApp) {
    return usage(ctx, '--app and --clear-app contradict each other', USAGE);
  }
  const body: Record<string, string | null> = {};
  if (schedule !== undefined) body.schedule = schedule;
  if (command !== undefined) body.command = command;
  if (clearApp) body.appId = null;
  else if (app !== undefined) body.appId = app;
  const answer = await api<{ name: string; session: string | null }>(
    ctx,
    'PATCH',
    jobPath('jobs', name),
    JSON.stringify(body),
  );
  if (answer === null) return 1;
  if (ctx.json) {
    ctx.io.out(answer.response.text);
    return 0;
  }
  ctx.io.out(`job ${answer.body.name} saved\n`);
  return 0;
}

/** DELETE /jobs/:name. */
async function deleteVerb(ctx: VerbContext, args: ParsedArgs): Promise<number> {
  const USAGE = 'cybermole-cli jobs delete <name> [--json]';
  if (args.positionals.length !== 1) return usage(ctx, 'delete takes exactly one job name', USAGE);
  const name = args.positionals[0] ?? '';
  const answer = await api<{ name: string; session: string | null }>(
    ctx,
    'DELETE',
    jobPath('jobs', name),
  );
  if (answer === null) return 1;
  if (ctx.json) {
    ctx.io.out(answer.response.text);
    return 0;
  }
  ctx.io.out(`job ${answer.body.name} deleted\n`);
  return 0;
}

/** POST /jobs/:name/run — fire now, NO request body (the route reads
 *  none; a bodyless request needs no Content-Length either). ok means
 *  FIRED — the run session opened — and the output says so: outcomes
 *  land in the run history when the server's tick observes the finish. */
async function runVerb(ctx: VerbContext, args: ParsedArgs): Promise<number> {
  const USAGE = 'cybermole-cli jobs run <name> [--json]';
  if (args.positionals.length !== 1) return usage(ctx, 'run takes exactly one job name', USAGE);
  const name = args.positionals[0] ?? '';
  const answer = await api<{ name: string; session: string }>(
    ctx,
    'POST',
    jobPath('jobs', name, 'run'),
  );
  if (answer === null) return 1;
  if (ctx.json) {
    ctx.io.out(answer.response.text);
    return 0;
  }
  ctx.io.out(`job ${answer.body.name} fired — run session ${answer.body.session} is open\n`);
  ctx.io.out(
    `  fired = the session opened, not the command finished: poll \`cybermole-cli jobs runs ${answer.body.name}\` for the outcome\n`,
  );
  return 0;
}

/** POST /jobs/:name/runs/:firedAt/kill — no request body, like run. */
async function killVerb(ctx: VerbContext, args: ParsedArgs): Promise<number> {
  const USAGE = 'cybermole-cli jobs kill <name> <firedAt> [--json]';
  if (args.positionals.length !== 2)
    return usage(
      ctx,
      'kill takes a job name and a firedAt (epoch ms — copy it from `runs`)',
      USAGE,
    );
  const name = args.positionals[0] ?? '';
  const firedAt = args.positionals[1] ?? '';
  const answer = await api<{ name: string; firedAt: number }>(
    ctx,
    'POST',
    jobPath('jobs', name, 'runs', firedAt, 'kill'),
  );
  if (answer === null) return 1;
  if (ctx.json) {
    ctx.io.out(answer.response.text);
    return 0;
  }
  ctx.io.out(`run ${answer.body.firedAt} of job ${answer.body.name} killed\n`);
  return 0;
}

/** POST /jobs/validate — cron and/or command checks; an invalid value
 *  is the ANSWER (200), and the exit code carries it: 0 all valid,
 *  1 something invalid, 2 usage. */
async function validateVerb(ctx: VerbContext, args: ParsedArgs): Promise<number> {
  const USAGE = 'cybermole-cli jobs validate [--schedule <cron>] [--command <cmd>] [--json]';
  if (args.positionals.length > 0)
    return usage(ctx, 'validate takes no positional arguments', USAGE);
  const schedule = valueOf(args.options, '--schedule');
  const command = valueOf(args.options, '--command');
  if (schedule === undefined && command === undefined) {
    return usage(ctx, 'nothing to validate — pass --schedule and/or --command', USAGE);
  }
  const body: Record<string, string> = {};
  if (schedule !== undefined) body.schedule = schedule;
  if (command !== undefined) body.command = command;
  const answer = await api<ValidateBody>(ctx, 'POST', '/jobs/validate', JSON.stringify(body));
  if (answer === null) return 1;
  let invalid = false;
  const lines: string[] = [];
  const scheduleCheck = answer.body.schedule;
  if (scheduleCheck !== null && scheduleCheck !== undefined) {
    if (scheduleCheck.valid)
      lines.push(`schedule: valid — next fire ${scheduleCheck.next} (local)`);
    else {
      invalid = true;
      lines.push(`schedule: invalid — ${scheduleCheck.error ?? 'invalid schedule'}`);
    }
  }
  const commandCheck = answer.body.command;
  if (commandCheck !== null && commandCheck !== undefined) {
    if (commandCheck.valid) lines.push('command: valid');
    else {
      invalid = true;
      lines.push(`command: invalid — ${commandCheck.error ?? 'invalid command'}`);
    }
  }
  if (ctx.json) ctx.io.out(answer.response.text);
  else ctx.io.out(`${lines.join('\n')}\n`);
  return invalid ? 1 : 0;
}

// ---------- the verb table + help (the agent-facing documentation) ----------

interface Verb {
  readonly name: string;
  readonly usage: string;
  /** verb-specific options; --json/--help (-h) are added for every verb */
  readonly spec: ArgSpec;
  readonly help: string;
  run(ctx: VerbContext, args: ParsedArgs): Promise<number>;
}

const VERBS: Record<string, Verb> = {
  list: {
    name: 'list',
    usage: 'cybermole-cli jobs list [-a <app-slug>] [--json]',
    spec: { values: ['--app'], aliases: { '-a': '--app' } },
    help: `cybermole-cli jobs list [-a <app-slug>] [--json]

The job definitions — the same list the /jobs page shows, one row per
job. Columns: NAME, SCHEDULE (5-field cron), COMMAND (truncated —
--json carries it whole), APP (the tag's display name), NEXT (local
next fire; "invalid schedule" = a stored schedule that no longer
parses), RUN (a run is live right now).

Options:
  -a, --app <slug>   only jobs tagged with that app — by SLUG, not name
                     (an unknown slug answers 'no such app', exit 1)
  --json             the server's raw answer (full fields: command,
                     appId, appName, last, lastResult, session, …)
  -h, --help         this text

Examples:
  cybermole-cli jobs list --json
  cybermole-cli jobs list -a deploy-tools`,
    run: listVerb,
  },
  runs: {
    name: 'runs',
    usage: 'cybermole-cli jobs runs <name> [--json]',
    spec: {},
    help: `cybermole-cli jobs runs <name> [--json]

The job's run history, newest first (the same 20-row history the page
shows). FIRED-AT (epoch ms) is each run's identity — copy it into the
\`log\` and \`kill\` verbs. EXIT is the observed exit code; '?' = not
(yet) known: the server's tick observes finishes (≤30s after the end),
and a run whose exit file never appeared stays unknown forever.
FINISHED '—' = not observed yet (usually: still running). ORIGIN is
manual (run-now / the page's Run button), schedule, or catchup (fired
on boot for a window missed while the server was down).

Example:
  cybermole-cli jobs runs nightly`,
    run: runsVerb,
  },
  log: {
    name: 'log',
    usage: 'cybermole-cli jobs log <name> <firedAt> [--json]',
    spec: {},
    help: `cybermole-cli jobs log <name> <firedAt> [--json]

One run's log tail: the newest 1 MiB of what the run wrote, printed
verbatim (a stderr note marks truncation). --json wraps it as
{name, firedAt, truncated, text} — with --json, stdout is always
valid JSON. The firedAt comes from \`cybermole-cli jobs runs <name>\`.

Example:
  cybermole-cli jobs log nightly 1736395200000`,
    run: logVerb,
  },
  create: {
    name: 'create',
    usage:
      'cybermole-cli jobs create --name <name> --schedule <cron> --command <cmd> [--app <app-id>] [--json]',
    spec: {
      values: ['--name', '--schedule', '--command', '--app'],
      aliases: { '-n': '--name', '-s': '--schedule', '-c': '--command' },
    },
    help: `cybermole-cli jobs create --name <name> --schedule <cron> --command <cmd> [--app <app-id>] [--json]

Create a job — or overwrite one with the same name: the save is an
upsert, exactly the /jobs form's save. The name slug-normalizes
("Nightly Check" → nightly-check): letters, digits, - and _, and never
cybermole-… (reserved for run sessions). The schedule is 5-field cron —
minute hour day-of-month month day-of-week, local time; check one with
\`cybermole-cli jobs validate\` first. The command is ONE line of arbitrary
shell, run as the workspace user in the job's tmux session cybermole-<name>
— its output goes to the run log (read it with \`log\`), and its exit
code into the run history.

Options:
  -n, --name <name>       required (normalized as above)
  -s, --schedule <cron>   required, 5-field cron
  -c, --command <cmd>     required, one line, ≤4000 chars
  --app <app-id>          the app tag's id (uuid) — the same value the
                          /jobs form's app picker uses; \`cybermole-cli jobs
                          list --json\` shows appId on tagged jobs.
                          Absent = untagged.

Examples:
  cybermole-cli jobs create --name nightly --schedule '0 4 * * *' --command 'npm test'
  cybermole-cli jobs create -n rebuild -s '*/15 * * * *' -c 'make build'`,
    run: createVerb,
  },
  set: {
    name: 'set',
    usage:
      'cybermole-cli jobs set <name> [--schedule <cron>] [--command <cmd>] [--app <app-id> | --clear-app] [--json]',
    spec: {
      values: ['--schedule', '--command', '--app'],
      aliases: { '-s': '--schedule', '-c': '--command' },
      flags: ['--clear-app'],
    },
    help: `cybermole-cli jobs set <name> [--schedule <cron>] [--command <cmd>] [--app <app-id> | --clear-app] [--json]

Change a job's fields. Every option is optional — an absent field KEEPS
its stored value (only what you pass is rewritten); --clear-app removes
the app tag. A schedule change takes effect within one scheduler tick
(≤30 s); a schedule that is already overdue fires one catch-up run,
like a reboot does.

Options:
  -s, --schedule <cron>   5-field cron, local time
  -c, --command <cmd>     one line, ≤4000 chars
  --app <app-id>          set the app tag (uuid — see \`create --help\`)
  --clear-app             remove the app tag

Examples:
  cybermole-cli jobs set nightly --schedule '30 4 * * *'
  cybermole-cli jobs set nightly --command 'npm test --silent' --clear-app`,
    run: setVerb,
  },
  delete: {
    name: 'delete',
    usage: 'cybermole-cli jobs delete <name> [--json]',
    spec: {},
    help: `cybermole-cli jobs delete <name> [--json]

Drop the job: its definition, its run history and its log files. A
LIVE run's tmux session is deliberately left alive (the page's
semantics — killing it is a separate decision): kill it first with
\`cybermole-cli jobs kill\` if it must not outlive the job.

Example:
  cybermole-cli jobs delete nightly`,
    run: deleteVerb,
  },
  run: {
    name: 'run',
    usage: 'cybermole-cli jobs run <name> [--json]',
    spec: {},
    help: `cybermole-cli jobs run <name> [--json]

Fire the job NOW (origin 'manual'). ok means FIRED — the run session
cybermole-<name> opened and the command is starting — NOT that it
finished. Outcomes are observed by the server's tick (≤30 s after the
end) into the run history: poll \`cybermole-cli jobs runs <name>\` (or \`log\`)
and CHECK THE EXIT CODE before declaring success. Refused — run_active,
exit 1 — while the previous run's session is still alive; kill that
one or wait.

Example:
  cybermole-cli jobs run nightly`,
    run: runVerb,
  },
  kill: {
    name: 'kill',
    usage: 'cybermole-cli jobs kill <name> <firedAt> [--json]',
    spec: {},
    help: `cybermole-cli jobs kill <name> <firedAt> [--json]

Kill the job's live run — its tmux session. The run named must be the
job's CURRENT one (the newest firedAt in \`runs\`): an older firedAt
answers run_not_active, and a newer run is never touched. The finish
lands in the run history on the next tick, usually with an unknown
exit code (the wrapper rarely gets its exit line out before the
SIGHUP).

Example:
  cybermole-cli jobs kill nightly 1736395200000`,
    run: killVerb,
  },
  validate: {
    name: 'validate',
    usage: 'cybermole-cli jobs validate [--schedule <cron>] [--command <cmd>] [--json]',
    spec: {
      values: ['--schedule', '--command'],
      aliases: { '-s': '--schedule', '-c': '--command' },
    },
    help: `cybermole-cli jobs validate [--schedule <cron>] [--command <cmd>] [--json]

Check values WITHOUT saving anything: the cron schedule (with its next
fire time) and/or the command (one line, non-empty, ≤4000 chars — the
same rule \`create\` enforces). An invalid value is an ANSWER, not a
failed request — the exit code carries it either way: 0 all valid,
1 something invalid (see the output), 2 usage error.

Examples:
  cybermole-cli jobs validate --schedule '0 4 * * *'
  cybermole-cli jobs validate --schedule '*/5 * * * *' --command 'npm test'`,
    run: validateVerb,
  },
};

/** `cybermole-cli jobs` / `cybermole-cli jobs --help`: the group's map — one line per
 *  verb, one example per verb (plan §5: the help is the documentation). */
export function jobsGroupHelp(): string {
  return `cybermole-cli jobs — scheduled jobs (parity with the /jobs page)

A job = name + 5-field cron schedule (local time) + one-line shell
command, optionally tagged with an app. Runs open in tmux as
cybermole-<name>: "run" reporting ok means the session OPENED (fired), not
that the command finished — the server's tick (≤30 s) observes
finishes and exit codes into the run history.

Usage: cybermole-cli jobs <verb> [options]        (options after the verb)

  list [-a <app-slug>]              definitions, next fire, live runs
  runs <name>                       run history (firedAt = run identity)
  log <name> <firedAt>              a run's log tail (newest 1 MiB)
  create --name N --schedule S --command C [--app <id>]
                                    create — or overwrite — a job
  set <name> [--schedule S] [--command C] [--app <id> | --clear-app]
                                    change fields; absent fields keep
  delete <name>                     drop the job, history and logs
  run <name>                        fire now (409 while one is live)
  kill <name> <firedAt>             kill the job's live run
  validate [--schedule S] [--command C]
                                    check values without saving

Every verb takes --json (the server's raw answer, for scripting) and
--help (that verb's full documentation). firedAt values are epoch ms —
copy them from \`runs\`.

Examples:
  cybermole-cli jobs list --json
  cybermole-cli jobs list -a deploy-tools
  cybermole-cli jobs runs nightly
  cybermole-cli jobs log nightly 1736395200000
  cybermole-cli jobs create --name nightly --schedule '0 4 * * *' --command 'npm test'
  cybermole-cli jobs set nightly --schedule '30 4 * * *'
  cybermole-cli jobs delete nightly
  cybermole-cli jobs run nightly
  cybermole-cli jobs kill nightly 1736395200000
  cybermole-cli jobs validate --schedule '*/5 * * * *' --command 'npm test'

The server side is the internal API over the unix socket — see
\`cybermole --help\` (Socket) for how the CLI finds it.`;
}

/** Run `cybermole-cli jobs <verb> …`: parse, help, discover the socket, run.
 *  Never throws — every failure is a printed message + exit code (the
 *  connect-time socket failure names the CYBERMOLE_SOCK knob). */
export async function runJobsCommand(argv: string[], io: Output): Promise<number> {
  const [verbName, ...rest] = argv;
  if (verbName === undefined) {
    // no verb at all is the group's help, like `git` with nothing
    io.out(jobsGroupHelp());
    return 0;
  }
  const verb = VERBS[verbName];
  if (verb === undefined) {
    io.err(`cybermole-cli: unknown jobs verb '${verbName}' — try: cybermole-cli jobs --help`);
    return 2;
  }
  const spec: ArgSpec = {
    flags: ['--json', '--help', ...(verb.spec.flags ?? [])],
    ...(verb.spec.values !== undefined ? { values: verb.spec.values } : {}),
    aliases: { '-h': '--help', ...(verb.spec.aliases ?? {}) },
  };
  const args = parseArgs(rest, spec);
  if (args.options['--help'] === true) {
    io.out(verb.help);
    return 0;
  }
  if (args.usageErrors.length > 0) {
    for (const problem of args.usageErrors) io.err(`cybermole-cli: ${problem}`);
    io.err(`usage: ${verb.usage}`);
    return 2;
  }
  // Help and usage errors answer before any socket is needed.
  const discovery = discoverInternalSocket();
  if (!discovery.ok) {
    io.err(`cybermole-cli: ${discovery.message}`);
    return 1;
  }
  const ctx: VerbContext = {
    io,
    json: args.options['--json'] === true,
    socketPath: discovery.socketPath,
  };
  try {
    return await verb.run(ctx, args);
  } catch (err) {
    // The CLI's crash guard (main.ts's stance): one printed line, never
    // a stack trace — a verb bug costs one exit 1, not a Node dump.
    io.err(`cybermole-cli: ${(err as Error).message}`);
    return 1;
  }
}
