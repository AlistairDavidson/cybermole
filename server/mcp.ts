// Jobs MCP server (stdio): tools 1:1 with the internal API's verbs, returning
// its response bodies verbatim. A domain failure (`run_not_active`, …) is a
// normal tool result the model should read; isError is reserved for
// transport failures (socket unreachable or disabled).
//
// stdout is the protocol channel, so nothing logs to it.
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { readInternalApiSocket } from '../src/lib/platform/env';
import {
  requestInternalApi,
  type InternalApiAnswer,
  type InternalApiCall,
} from '../src/lib/platform/internal-api-client';
import { AppSlugSchema, JobNameSchema } from '@cybermole/app-kit';
import {
  FiredAtSchema,
  JobPatchSchema,
  JobSaveSchema,
  JobValidateSchema,
} from '../src/schemas/jobs';

// ---------- the tools ----------

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
            'the internal API is disabled (CYBERMOLE_SOCK is empty on this cybermole instance) ' +
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
    const why = code !== undefined ? `(${code})` : `: ${(err as Error).message}`; // a mid-response reset has no errno
    return {
      content: [
        {
          type: 'text',
          text:
            `could not reach the internal API at ${socketPath} ${why} ` +
            '— is the cybermole server running, and does it serve this socket?',
        },
      ],
      isError: true,
    };
  }
  return { content: [{ type: 'text', text: answer.body }] };
}

/** jobs_runs reports a number; the API's path param is a digit string. Accept both. */
const firedAtSchema = z
  .union([z.number(), FiredAtSchema])
  .describe('the run, by fired_at — the epoch-ms id jobs_runs reported');

const nameSchema = JobNameSchema.describe('the job name, as jobs_list reported it');

/** socketPath null (listener off): every tool answers a "disabled" error. */
export function createJobsMcpServer(deps: { socketPath: string | null }): McpServer {
  const { socketPath } = deps;
  const call = (c: InternalApiCall): Promise<CallToolResult> => answerToolResult(socketPath, c);
  const jobPath = (name: string, rest: string): string =>
    `/jobs/${encodeURIComponent(name)}${rest}`;

  const server = new McpServer({ name: 'cybermole-jobs', version: '0.1.0' });

  server.registerTool(
    'jobs_list',
    {
      description:
        'List the scheduled jobs — the same rows the console /jobs page shows ' +
        "(name, cron schedule, command, app tag). Pass app to list only one app's " +
        'tagged jobs by its slug (from apps_list); an unknown slug answers the ' +
        'app_not_found failure code.',
      inputSchema: {
        app: AppSlugSchema.optional().describe("an app slug, to list only that app's jobs"),
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
        "Create a job — the console's new-job form. The name is a display name, " +
        'normalized into the job\'s id ("Nightly Check" → nightly-check); schedule is a ' +
        '5-field cron (minute hour day-of-month month day-of-week); command is the ' +
        'one-line shell every run executes, as the workspace user. appId optionally ' +
        "tags the job with an app (apps_list's id). The answer is the Result JSON: a " +
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
        // JSON.stringify drops an undefined appId: untagged.
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
        "Delete a job: its definition, run history and log files. A live run's " +
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
        "The newest 1 MiB tail of one run's log, as plain text. firedAt is the " +
        "run's id from jobs_runs. Answers run_not_found for an unknown run, " +
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
        "Start a manual run of the job now — the console's Run now button. It opens " +
        'a live terminal session (cybermole-<name>) and answers the Result JSON with ' +
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

// ---------- entry ----------

/** A bad CYBERMOLE_SOCK is reported on stderr with exit 1. */
export async function main(): Promise<void> {
  let socketPath: string | null;
  try {
    socketPath = readInternalApiSocket();
  } catch (err) {
    console.error(`cybermole-jobs mcp: ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }
  const server = createJobsMcpServer({ socketPath });
  await server.connect(new StdioServerTransport());
}

// The CJS build's self-exec guard: this file is both a module and an entry.
if (require.main === module) {
  main().catch(err => {
    console.error(`cybermole-jobs mcp: ${(err as Error).stack ?? err}`);
    process.exitCode = 1;
  });
}
