// mcp.ts — the jobs MCP server (docs/jobs-agent-plan.md §6): a stdio MCP
// server whose tools are 1:1 with the internal jobs API's verbs
// (server/internal-api.ts, plan §3–§4) plus apps_list, exposing the jobs
// surface to pi sessions as tools instead of CLI round-trips. The CLI
// (plan §5, task/jobs-cli) stays the substrate; this is the in-session
// convenience — which is why the tools carry the API's answers verbatim
// and add no logic of their own.
//
// Tool results are the internal API's response bodies VERBATIM as text
// content — the same wire JSON the browser routes and the CLI read (plan
// §4: "the same Result JSON"): successes are the data shape, failures are
// `{ error, code, … }` where `code` is the closed error code of the
// src/types/result.ts family (`invalid_schedule`, `job_not_found`,
// `run_not_active`, …). No second vocabulary is minted here — the API's
// failure codes ARE the tools'. An API failure is a normal tool result,
// not an MCP error: the model must read it (a kill answered
// `run_not_active` is information, not a tool malfunction). The only
// isError results are TRANSPORT failures — the socket unreachable, or
// the listener off (WEB_PI_SOCK empty, plan §3) — which are no answer at
// all, never a domain code.
//
// stdout is the protocol channel: this process logs NOTHING (no logger —
// componentLogger's winston console transport writes to stdout and would
// corrupt the stream); the one boot-time diagnostic (a bad WEB_PI_SOCK)
// goes to stderr.
//
// Importable standalone (tests, a future in-process wiring) and runnable
// as an entry: `node dist-server/server/mcp.js` — the pi template's
// mcp.json registers exactly that (pi/mcp.json), and the `webpi mcp`
// subcommand (task/jobs-cli, merged by the orchestrator) execs the same
// main().
import * as http from 'node:http';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { readInternalApiSocket } from '../src/lib/env';
import { AppSlugSchema, JobNameSchema } from '../src/schemas/ids';
import { FiredAtSchema, JobPatchSchema, JobSaveSchema, JobValidateSchema } from '../src/schemas/jobs';

// ---------- the internal API socket client (plan §6) ----------

/** One request to the internal API: method + request path (params already
 *  interpolated, percent-encoded) and, for the body verbs, a JSON string.
 *  Minimal and local for now: task/jobs-cli (the parallel branch) builds
 *  the shared socket-client layer for the CLI verbs and this server; the
 *  orchestrator may unify the two at merge. */
export interface InternalApiCall {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  /** A PRESENT body is sent with a Content-Length header, always. The
   *  internal API refuses a body without a declared length with 411
   *  (§3/§4's body policy — the same stance as the public JSON API);
   *  never letting node stream it chunked is this client's side of that
   *  contract. */
  body?: string;
}

/** The internal API's answer: the wire body verbatim (JSON, except the log
 *  route's plain text) plus the status and headers it came with. */
export interface InternalApiAnswer {
  status: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}

/** One HTTP request over the internal API's unix socket. Rejects on
 *  transport failure (ECONNREFUSED/ENOENT: no server answering on the
 *  file; a reset mid-response) — the caller turns that into the tool's
 *  isError result. `agent: false`: a one-shot socket per request, so the
 *  process holds nothing open between calls and exits the moment the
 *  client closes stdin (how pi stops stdio servers). */
export function requestInternalApi(
  socketPath: string,
  call: InternalApiCall,
): Promise<InternalApiAnswer> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (call.body !== undefined) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(Buffer.byteLength(call.body, 'utf8'));
    }
    const req = http.request(
      { socketPath, method: call.method, path: call.path, headers, agent: false },
      res => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('error', reject);
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
            headers: res.headers,
          }),
        );
      },
    );
    req.on('error', reject);
    if (call.body === undefined) req.end();
    else req.end(call.body);
  });
}

// ---------- the tools ----------

/** Every tool's shared ending: the API's body verbatim, or the transport's
 *  own failure as the one isError shape. A 2xx answer and a domain
 *  failure both come back as plain text content — the body (its `code`
 *  field) is the vocabulary. */
async function answerToolResult(
  socketPath: string | null,
  call: InternalApiCall,
): Promise<CallToolResult> {
  if (socketPath === null) {
    return {
      content: [
        {
          type: 'text',
          text:
            'the internal API is disabled (WEB_PI_SOCK is empty on this web-pi instance) ' +
            '— the jobs tools cannot work until the operator turns the socket on; ' +
            'until then the console /jobs page is the only surface',
        },
      ],
      isError: true,
    };
  }
  let answer: InternalApiAnswer;
  try {
    answer = await requestInternalApi(socketPath, call);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const why =
      code !== undefined
        ? `(${code})`
        : `: ${(err as Error).message}`; // a reset mid-response — no errno
    return {
      content: [
        {
          type: 'text',
          text:
            `could not reach the internal API at ${socketPath} ${why} ` +
            '— is the web-pi server running, and does it serve this socket?',
        },
      ],
      isError: true,
    };
  }
  // The API's answer, byte for byte — JSON for every verb except the log
  // route's tail, which is the tool's text content as-is.
  return { content: [{ type: 'text', text: answer.body }] };
}

/** The runs' identity, as jobs_runs reports it (a JSON number) and as it
 *  rides the routes' path params (a digit string): both spellings
 *  accepted, the digit-string arm exactly the API's FiredAtSchema — the
 *  same rule text, and a non-digit still reaches the API's own
 *  invalid_fired_at answer when it is a number that is not an epoch-ms
 *  integer (a float, say). */
const firedAtSchema = z
  .union([z.number(), FiredAtSchema])
  .describe('the run, by fired_at — the epoch-ms id jobs_runs reported');

/** The job name, exactly as jobs_list reported it (the API's own
 *  JobNameSchema: letters, digits, - and _; run sessions reserve webpi-…). */
const nameSchema = JobNameSchema.describe('the job name, as jobs_list reported it');

/** Build the stdio MCP server. socketPath is the resolved internal API
 *  socket (src/lib/env.ts readInternalApiSocket — imported, not
 *  duplicated: the $WEB_PI_SOCK → /run/web-pi/webpi.sock → <state
 *  dir>/webpi.sock discovery is §5's rule and the server's, one logic)
 *  — or null when the listener is off, in which case every tool call
 *  answers the clear "disabled" error instead of the server dying
 *  (§3: the operator's knob, not the session's). */
export function createJobsMcpServer(deps: { socketPath: string | null }): McpServer {
  const { socketPath } = deps;
  const call = (c: InternalApiCall): Promise<CallToolResult> => answerToolResult(socketPath, c);
  const jobPath = (name: string, rest: string): string =>
    `/jobs/${encodeURIComponent(name)}${rest}`;

  const server = new McpServer({ name: 'webpi-jobs', version: '0.1.0' });

  server.registerTool(
    'jobs_list',
    {
      description:
        'List the scheduled jobs — the same rows the console /jobs page shows ' +
        '(name, cron schedule, command, app tag). Pass app to list only one app\'s ' +
        'tagged jobs by its slug (from apps_list); an unknown slug answers the ' +
        'app_not_found failure code.',
      inputSchema: {
        app: AppSlugSchema.optional().describe('an app slug, to list only that app\'s jobs'),
      },
    },
    async ({ app }) =>
      call({
        method: 'GET',
        path: app === undefined ? '/jobs' : `/jobs?app=${encodeURIComponent(app)}`,
      }),
  );

  server.registerTool(
    'jobs_create',
    {
      description:
        'Create a job — the console\'s new-job form. The name is a display name, ' +
        'normalized into the job\'s id ("Nightly Check" → nightly-check); schedule is a ' +
        '5-field cron (minute hour day-of-month month day-of-week); command is the ' +
        'one-line shell every run executes, as the workspace user. appId optionally ' +
        'tags the job with an app (apps_list\'s id). The answer is the Result JSON: a ' +
        'bad schedule carries the invalid_schedule code, a taken name stays a plain ' +
        'update (jobs are upserted by name).',
      inputSchema: {
        name: JobSaveSchema.shape.name.describe(
          'display name; normalized into the id (Nightly Check → nightly-check)',
        ),
        schedule: JobSaveSchema.shape.schedule.describe(
          '5-field cron: minute hour day-of-month month day-of-week',
        ),
        command: JobSaveSchema.shape.command.describe(
          'the one-line shell command every run executes',
        ),
        appId: JobSaveSchema.shape.appId.describe(
          'optional app tag, by id from apps_list; null = untagged',
        ),
      },
    },
    async args =>
      call({
        method: 'POST',
        path: '/jobs',
        // JSON.stringify drops the undefined appId — the API treats it as untagged.
        body: JSON.stringify({
          name: args.name,
          schedule: args.schedule,
          command: args.command,
          appId: args.appId,
        }),
      }),
  );

  server.registerTool(
    'jobs_set',
    {
      description:
        "Change a job's schedule, command and/or app tag — the console's edit form. " +
        'Absent fields keep their stored values; appId null clears the tag. Nothing ' +
        'else changes (a reschedule keeps the run history). The answer is the Result ' +
        'JSON; an unknown job carries job_not_found.',
      inputSchema: {
        name: nameSchema,
        schedule: JobPatchSchema.shape.schedule.describe('new cron schedule; absent keeps'),
        command: JobPatchSchema.shape.command.describe('new command; absent keeps'),
        appId: JobPatchSchema.shape.appId.describe('new app tag by id; null clears; absent keeps'),
      },
    },
    async args =>
      call({
        method: 'PATCH',
        path: jobPath(args.name, ''),
        body: JSON.stringify({
          schedule: args.schedule,
          command: args.command,
          appId: args.appId,
        }),
      }),
  );

  server.registerTool(
    'jobs_delete',
    {
      description:
        'Delete a job: its definition, run history and log files. A live run\'s ' +
        'terminal session is deliberately left alone (kill it first if that ' +
        'matters). An unknown name answers job_not_found.',
      inputSchema: { name: nameSchema },
    },
    async ({ name }) => call({ method: 'DELETE', path: jobPath(name, '') }),
  );

  server.registerTool(
    'jobs_runs',
    {
      description:
        "One job's run history, newest first: firedAt (the run's epoch-ms id), " +
        'origin (manual | scheduled | catchup), exitCode (null until the finish is ' +
        'observed), finishedAt, hasLog. An unknown job answers job_not_found.',
      inputSchema: { name: nameSchema },
    },
    async ({ name }) => call({ method: 'GET', path: jobPath(name, '/runs') }),
  );

  server.registerTool(
    'jobs_log',
    {
      description:
        'The newest 1 MiB tail of one run\'s log, as plain text. firedAt is the ' +
        'run\'s id from jobs_runs. Answers run_not_found for an unknown run, ' +
        'log_missing when the run left no log file.',
      inputSchema: { name: nameSchema, firedAt: firedAtSchema },
    },
    async ({ name, firedAt }) =>
      call({ method: 'GET', path: jobPath(name, `/runs/${String(firedAt)}/log`) }),
  );

  server.registerTool(
    'jobs_run_now',
    {
      description:
        'Start a manual run of the job now — the console\'s Run now button. It opens ' +
        'a live terminal session (webpi-<name>) and answers the Result JSON with ' +
        'the session name. A previous run still being alive answers run_active: ' +
        'jobs never pile up — check jobs_runs and kill the old run first.',
      inputSchema: { name: nameSchema },
    },
    async ({ name }) => call({ method: 'POST', path: jobPath(name, '/run') }),
  );

  server.registerTool(
    'jobs_kill',
    {
      description:
        "Kill the job's live run (its terminal session). The named run must be the " +
        "job's current live one: an unknown firedAt answers run_not_found, a run " +
        'that already ended (or was superseded) answers run_not_active, a failed ' +
        'kill answers tmux_error.',
      inputSchema: { name: nameSchema, firedAt: firedAtSchema },
    },
    async ({ name, firedAt }) =>
      call({ method: 'POST', path: jobPath(name, `/runs/${String(firedAt)}/kill`) }),
  );

  server.registerTool(
    'jobs_validate',
    {
      description:
        'Check a cron schedule and/or a command without saving anything — the ' +
        "dialog's live feedback. An invalid value is an ANSWER (valid: false, with " +
        'the error), not a failed request; send at least one field.',
      inputSchema: {
        schedule: JobValidateSchema.shape.schedule.describe(
          'a candidate cron schedule, checked as-is',
        ),
        command: JobValidateSchema.shape.command.describe(
          'a candidate command, checked as-is (an empty one answers valid: false)',
        ),
      },
    },
    async args =>
      call({
        method: 'POST',
        path: '/jobs/validate',
        body: JSON.stringify({ schedule: args.schedule, command: args.command }),
      }),
  );

  server.registerTool(
    'apps_list',
    {
      description:
        "The app rows for jobs' app-tag picker: id, name, slug, cwd, order — the " +
        'same list the console renders. Read-only: apps are created and managed ' +
        'from the console.',
    },
    async () => call({ method: 'GET', path: '/apps' }),
  );

  return server;
}

// ---------- the entry ----------

/** Resolve the internal API socket and serve the tools over stdio.
 *  WEB_PI_SOCK's rules are env.ts's (§3): unset = the shape default,
 *  empty = the listener off (serve on — every call answers the disabled
 *  error), a non-absolute value = operator wiring mistake, reported to
 *  stderr with exit 1 — the same stop-the-boot stance the web server
 *  takes on that one. Returns when the transport closes (the client
 *  closing stdin — how pi stops stdio servers); the process then exits
 *  on its own: request sockets are one-shot, nothing else is held. */
export async function main(): Promise<void> {
  let socketPath: string | null;
  try {
    socketPath = readInternalApiSocket();
  } catch (err) {
    console.error(`webpi-jobs mcp: ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }
  const server = createJobsMcpServer({ socketPath });
  await server.connect(new StdioServerTransport());
}

// The self-exec guard, in the CommonJS build's terms — the compiled
// `import.meta.url === argv[1]` idiom (the server build emits CJS; the
// repo's equivalent is jobs.ts's __dirname note). This file is both the
// importable module and a runnable entry.
if (require.main === module) {
  main().catch(err => {
    console.error(`webpi-jobs mcp: ${(err as Error).stack ?? err}`);
    process.exitCode = 1;
  });
}
