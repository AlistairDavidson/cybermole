// Internal API: an HTTP listener on a unix socket serving the workspace side
// (agents) the jobs and apps services. The socket's file mode is the only
// auth. Routes call the same services and response mappers as the browser
// API, so bodies are byte-identical.
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { componentLogger } from '../src/lib/platform/logger';
import { checkCron, type ListJobsFailure, type Scheduler } from '../src/lib/jobs/jobs';
import type { Apps } from '../src/lib/apps/apps';
import {
  appFailureResponse,
  appFilterNotFoundResponse,
  failureResponse,
  invalidAppSlugResponse,
  invalidFiredAtResponse,
  invalidJobNameResponse,
  jobFailureResponse,
  runLogResponse,
} from '../src/lib/web/responses.service';
import { parseAndValidateAPIRequest } from '../src/lib/web/parsing.service';
import { appCreateBody, appPatchBody } from '../src/schemas/api';
import {
  jsonResponse,
  AppSlugSchema,
  JobNameSchema,
  type AppId,
  type AppSlug,
  type JobName,
} from '@cybermole/app-kit';
import {
  FiredAtSchema,
  JobPatchSchema,
  JobSaveSchema,
  JobValidateSchema,
} from '../src/schemas/jobs';

const log = componentLogger('internal-api');

// 10 KiB covers every jobs body (MAX_COMMAND is 4000 chars).
const BODY_MAX_BYTES = 10 * 1024;

export interface InternalApiDeps {
  socketPath: string;
  /** Must be the same instance main.ts hands to Astro, never a second Scheduler. */
  scheduler: Scheduler;
  apps: Pick<Apps, 'listApps' | 'saveApp' | 'renameApp' | 'deleteApp'>;
}

export interface InternalApiHandle {
  readonly socketPath: string;
  /** Unlink is best-effort; the next boot's stale-socket check covers a crash. */
  close(): Promise<void>;
}

/** Another live server owns the socket. main.ts serves on without the
 *  internal API rather than let a second instance take it down. */
export class InternalSocketOwnedError extends Error {
  constructor(readonly socketPath: string) {
    super(
      `another cybermole server owns the socket (${socketPath}) — ` +
        'this instance serves without the internal API; stop the other server, or point CYBERMOLE_SOCK elsewhere',
    );
    this.name = 'InternalSocketOwnedError';
  }
}

// ---------- socket lifecycle ----------

/** 'stale' only on ECONNREFUSED/ENOENT; anything else (timeout, EACCES)
 *  counts as live, so a possibly-owned socket is never stolen. */
export function probeSocketFile(socketPath: string, timeoutMs = 500): Promise<'live' | 'stale'> {
  return new Promise(resolve => {
    const socket = net.connect({ path: socketPath });
    const finish = (state: 'live' | 'stale'): void => {
      clearTimeout(timer);
      socket.destroy();
      resolve(state);
    };
    const timer = setTimeout(() => finish('live'), timeoutMs);
    socket.on('connect', () => finish('live'));
    socket.on('error', err => {
      const code = (err as NodeJS.ErrnoException).code;
      finish(code === 'ECONNREFUSED' || code === 'ENOENT' ? 'stale' : 'live');
    });
  });
}

/** Claim the socket (unlink a stale file), listen, then chmod 0660: group
 *  access is the gate (the setgid /run/cybermole dir supplies the group). */
export async function startInternalApi(deps: InternalApiDeps): Promise<InternalApiHandle> {
  // The state-dir default may not exist yet when the db and agent dir point
  // elsewhere (e2e's spawned servers, a first run).
  fs.mkdirSync(path.dirname(deps.socketPath), { recursive: true });
  if (fs.existsSync(deps.socketPath)) {
    const state = await probeSocketFile(deps.socketPath);
    if (state === 'live') {
      throw new InternalSocketOwnedError(deps.socketPath);
    }
    log.info(`removing stale internal socket ${deps.socketPath}`);
    fs.rmSync(deps.socketPath, { force: true });
  }
  const routes = createRoutes(deps);
  const server = http.createServer((req, res) => {
    logAccess(req, res);
    // A throwing route costs one 500, never the process.
    routes(req, res).catch(err => {
      log.error('request handler error', { error: err });
      if (!res.headersSent) {
        void sendWebResponse(
          res,
          jsonResponse({ error: 'internal error', detail: null, code: 'internal_error' }, 500),
        ).catch(() => {
          /* client gone */
        });
      } else res.destroy();
    });
  });
  await new Promise<void>((resolve, reject) => {
    const onListenError = (err: Error): void => reject(err);
    server.once('error', onListenError);
    server.listen(deps.socketPath, () => {
      server.off('error', onListenError);
      server.on('error', err => log.error('server error', { error: err }));
      resolve();
    });
  });
  fs.chmodSync(deps.socketPath, 0o660);
  log.info(`internal API listening on ${deps.socketPath} (0660) — jobs for the workspace side`);
  return {
    socketPath: deps.socketPath,
    close() {
      return new Promise(resolve => {
        server.close(() => {
          try {
            fs.rmSync(deps.socketPath, { force: true });
          } catch (err) {
            log.warn(`could not unlink ${deps.socketPath}: ${(err as Error).message}`);
          }
          resolve();
        });
        server.closeIdleConnections(); // keep-alive agents must not hold the drain
      });
    },
  };
}

// ---------- request plumbing ----------

function logAccess(req: http.IncomingMessage, res: http.ServerResponse): void {
  const start = Date.now();
  res.on('finish', () => {
    log.http(
      `${req.method} ${(req.url ?? '').split('?')[0]} ${res.statusCode} in ${Date.now() - start}ms`,
    );
  });
}

function bodyCapStatus(req: http.IncomingMessage): 411 | 413 | null {
  if (req.method === 'GET' || req.method === 'HEAD') return null;
  const declared = req.headers['content-length'];
  if (declared === undefined) {
    return req.headers['transfer-encoding'] !== undefined ? 411 : null;
  }
  return Number(declared) <= BODY_MAX_BYTES ? null : 413;
}

/** Null when over the cap (the stream is destroyed). */
function readBody(req: http.IncomingMessage): Promise<Buffer | null> {
  return new Promise(resolve => {
    let n = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      n += c.length;
      if (n > BODY_MAX_BYTES) {
        req.destroy();
        resolve(null);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', () => resolve(Buffer.concat(chunks))); // client gone: parse what arrived
  });
}

/** For the shared parser; content-type is the only header it reads. */
function toFetchRequest(req: http.IncomingMessage, body: Buffer): Request {
  const headers: Record<string, string> = {};
  const ct = req.headers['content-type'];
  if (ct !== undefined) headers['content-type'] = Array.isArray(ct) ? ct.join(', ') : ct;
  const hasBody = body.length > 0 && req.method !== 'GET' && req.method !== 'HEAD';
  return new Request(`http://internal${req.url ?? '/'}`, {
    method: req.method ?? 'GET',
    headers,
    ...(hasBody ? { body } : {}),
  });
}

/** The streaming cap catches clients that lie about Content-Length. */
async function readRequest(
  req: http.IncomingMessage,
): Promise<{ ok: true; request: Request } | { ok: false; response: Response }> {
  const body = await readBody(req);
  if (body === null) {
    return {
      ok: false,
      response: jsonResponse(
        { error: 'request body too large', detail: null, code: 'body_too_large' },
        413,
      ),
    };
  }
  return { ok: true, request: toFetchRequest(req, body) };
}

async function sendWebResponse(res: http.ServerResponse, r: Response): Promise<void> {
  const headers: Record<string, string> = {};
  r.headers.forEach((value, name) => {
    headers[name] = value;
  });
  res.writeHead(r.status, headers);
  res.end(await r.text());
}

/** Matches path+method like Astro's route table: no match is a JSON 404. */
function notFoundResponse(): Response {
  return jsonResponse({ error: 'not found', detail: null, code: 'not_found' }, 404);
}

// ---------- routes ----------

function createRoutes(
  deps: InternalApiDeps,
): (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void> {
  const { scheduler, apps } = deps;

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const capped = bodyCapStatus(req);
    if (capped !== null) {
      return sendWebResponse(
        res,
        jsonResponse(
          {
            error:
              capped === 413 ? 'request body too large' : 'request body needs a Content-Length',
            detail: null,
            code: capped === 413 ? 'body_too_large' : 'length_required',
          },
          capped,
        ),
      );
    }
    const url = new URL(req.url ?? '/', 'http://internal');
    // Decode per segment like Astro; a bad %-escape is a 400.
    const segments: string[] = [];
    for (const segment of url.pathname.split('/').filter(Boolean)) {
      try {
        segments.push(decodeURIComponent(segment));
      } catch {
        return sendWebResponse(
          res,
          jsonResponse({ error: 'bad request', detail: null, code: 'bad_request' }, 400),
        );
      }
    }

    if (segments.length === 1 && segments[0] === 'apps') {
      // App registration is the workspace side's power, like job creation.
      if (req.method === 'GET') return listApps(res);
      if (req.method === 'POST') return saveApp(req, res);
      return sendWebResponse(res, notFoundResponse());
    }
    if (segments.length === 2 && segments[0] === 'apps') {
      const slug = AppSlugSchema.safeParse(segments[1]);
      if (!slug.success) return sendWebResponse(res, invalidAppSlugResponse());
      if (req.method === 'PATCH') return patchApp(req, res, slug.data);
      if (req.method === 'DELETE') return deleteApp(res, slug.data);
      return sendWebResponse(res, notFoundResponse());
    }

    if (segments.length === 1 && segments[0] === 'jobs') {
      if (req.method === 'GET') return listJobs(res, url.searchParams.get('app'));
      if (req.method === 'POST') return saveJob(req, res);
      return sendWebResponse(res, notFoundResponse());
    }
    if (segments.length === 2 && segments[0] === 'jobs') {
      // The static route shadows :name, as in Astro (a job named "validate" is unaddressable).
      if (segments[1] === 'validate' && req.method === 'POST') return validate(req, res);
      const name = JobNameSchema.safeParse(segments[1]);
      if (!name.success) return sendWebResponse(res, invalidJobNameResponse());
      if (req.method === 'PATCH') return patchJob(req, res, name.data);
      if (req.method === 'DELETE') return deleteJob(res, name.data);
      return sendWebResponse(res, notFoundResponse());
    }
    if (segments.length === 3 && segments[0] === 'jobs') {
      const name = JobNameSchema.safeParse(segments[1]);
      if (!name.success) return sendWebResponse(res, invalidJobNameResponse());
      if (segments[2] === 'runs' && req.method === 'GET') return listRuns(res, name.data);
      if (segments[2] === 'run' && req.method === 'POST') return runJob(res, name.data);
      return sendWebResponse(res, notFoundResponse());
    }
    if (
      segments.length === 5 &&
      segments[0] === 'jobs' &&
      segments[2] === 'runs' &&
      (segments[4] === 'kill' || segments[4] === 'log')
    ) {
      const name = JobNameSchema.safeParse(segments[1]);
      if (!name.success) return sendWebResponse(res, invalidJobNameResponse());
      const firedAt = FiredAtSchema.safeParse(segments[3]);
      if (!firedAt.success) return sendWebResponse(res, invalidFiredAtResponse());
      if (segments[4] === 'kill' && req.method === 'POST')
        return killRun(res, name.data, firedAt.data);
      if (segments[4] === 'log' && req.method === 'GET')
        return runLog(res, name.data, firedAt.data);
    }
    return sendWebResponse(res, notFoundResponse());
  }

  async function listApps(res: http.ServerResponse): Promise<void> {
    const listed = apps.listApps();
    if (!listed.ok) return sendWebResponse(res, appFailureResponse(listed));
    return sendWebResponse(res, jsonResponse(listed.data, 200));
  }

  async function saveApp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await readRequest(req);
    if (!body.ok) return sendWebResponse(res, body.response);
    const parsed = await parseAndValidateAPIRequest(body.request, appCreateBody);
    if (!parsed.ok) return sendWebResponse(res, failureResponse(parsed));
    const saved = await apps.saveApp(parsed.data.name, parsed.data.cwd);
    if (!saved.ok) return sendWebResponse(res, appFailureResponse(saved));
    return sendWebResponse(res, jsonResponse(saved.data, 200));
  }

  async function patchApp(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    slug: AppSlug,
  ): Promise<void> {
    const body = await readRequest(req);
    if (!body.ok) return sendWebResponse(res, body.response);
    const parsed = await parseAndValidateAPIRequest(body.request, appPatchBody);
    if (!parsed.ok) return sendWebResponse(res, failureResponse(parsed));
    const saved = await apps.renameApp(slug, parsed.data.name, parsed.data.cwd);
    if (!saved.ok) return sendWebResponse(res, appFailureResponse(saved));
    return sendWebResponse(res, jsonResponse(saved.data, 200));
  }

  async function deleteApp(res: http.ServerResponse, slug: AppSlug): Promise<void> {
    const deleted = await apps.deleteApp(slug);
    if (!deleted.ok) return sendWebResponse(res, appFailureResponse(deleted));
    return sendWebResponse(res, jsonResponse(deleted.data, 200));
  }

  /** ?app=<slug>: an unknown slug is a 404, not an empty list, so "no such
   *  app" can't be mistaken for "no jobs". */
  async function listJobs(res: http.ServerResponse, appSlug: string | null): Promise<void> {
    let appId: AppId | null | undefined; // undefined = no filter
    if (appSlug !== null) {
      const slug = AppSlugSchema.safeParse(appSlug);
      if (!slug.success) return sendWebResponse(res, invalidAppSlugResponse());
      const listed = apps.listApps();
      if (!listed.ok) {
        return sendWebResponse(
          res,
          jobFailureResponse({
            ok: false,
            resultType: 'list_jobs',
            errorCode: 'database_error',
            errorMessage: listed.errorMessage ?? 'could not read apps',
          } satisfies ListJobsFailure),
        );
      }
      const app = listed.data.apps.find(a => a.slug === slug.data);
      if (app === undefined) return sendWebResponse(res, appFilterNotFoundResponse());
      appId = app.id;
    }
    const jobsListed = await scheduler.listJobs();
    if (!jobsListed.ok) return sendWebResponse(res, jobFailureResponse(jobsListed));
    const jobs =
      appId === undefined
        ? jobsListed.data.jobs
        : jobsListed.data.jobs.filter(j => j.appId === appId);
    return sendWebResponse(res, jsonResponse({ ...jobsListed.data, jobs }, 200));
  }

  async function saveJob(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await readRequest(req);
    if (!body.ok) return sendWebResponse(res, body.response);
    const parsed = await parseAndValidateAPIRequest(body.request, JobSaveSchema);
    if (!parsed.ok) return sendWebResponse(res, failureResponse(parsed));
    const saved = await scheduler.saveJob(parsed.data);
    if (!saved.ok) return sendWebResponse(res, jobFailureResponse(saved));
    return sendWebResponse(res, jsonResponse({ name: saved.data.name, session: null }, 200));
  }

  /** Validates cron and command (the browser verb is schedule-only). An
   *  invalid value answers 200 with valid:false, not a failed request. */
  async function validate(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await readRequest(req);
    if (!body.ok) return sendWebResponse(res, body.response);
    const parsed = await parseAndValidateAPIRequest(body.request, JobValidateSchema);
    if (!parsed.ok) return sendWebResponse(res, failureResponse(parsed));
    const schedule = parsed.data.schedule === undefined ? null : checkCron(parsed.data.schedule);
    const command =
      parsed.data.command === undefined
        ? null
        : (() => {
            // Same rule as JobSaveSchema.
            const checked = JobPatchSchema.shape.command.safeParse(parsed.data.command);
            return checked.success
              ? { valid: true, error: null }
              : { valid: false, error: checked.error.issues[0]?.message ?? 'invalid command' };
          })();
    return sendWebResponse(res, jsonResponse({ schedule, command }, 200));
  }

  /** Absent fields keep their value; appId null clears the tag. */
  async function patchJob(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    name: JobName,
  ): Promise<void> {
    const current = scheduler.getJob(name);
    if (!current.ok) return sendWebResponse(res, jobFailureResponse(current));
    const body = await readRequest(req);
    if (!body.ok) return sendWebResponse(res, body.response);
    const parsed = await parseAndValidateAPIRequest(body.request, JobPatchSchema);
    if (!parsed.ok) return sendWebResponse(res, failureResponse(parsed));
    const saved = await scheduler.saveJob({
      name,
      schedule: parsed.data.schedule ?? current.data.schedule,
      command: parsed.data.command ?? current.data.command,
      appId: parsed.data.appId === undefined ? current.data.appId : parsed.data.appId,
    });
    if (!saved.ok) return sendWebResponse(res, jobFailureResponse(saved));
    return sendWebResponse(res, jsonResponse({ name: saved.data.name, session: null }, 200));
  }

  async function deleteJob(res: http.ServerResponse, name: JobName): Promise<void> {
    const deleted = await scheduler.deleteJob(name);
    if (!deleted.ok) return sendWebResponse(res, jobFailureResponse(deleted));
    return sendWebResponse(res, jsonResponse({ name: deleted.data.name, session: null }, 200));
  }

  async function listRuns(res: http.ServerResponse, name: JobName): Promise<void> {
    const listed = scheduler.listRuns(name);
    if (!listed.ok) return sendWebResponse(res, jobFailureResponse(listed));
    return sendWebResponse(res, jsonResponse(listed.data, 200));
  }

  async function runJob(res: http.ServerResponse, name: JobName): Promise<void> {
    const run = await scheduler.runJob(name);
    if (!run.ok) return sendWebResponse(res, jobFailureResponse(run));
    return sendWebResponse(
      res,
      jsonResponse({ name: run.data.name, session: run.data.session }, 200),
    );
  }

  async function killRun(res: http.ServerResponse, name: JobName, firedAt: number): Promise<void> {
    const killed = await scheduler.killRun(name, firedAt);
    if (!killed.ok) return sendWebResponse(res, jobFailureResponse(killed));
    return sendWebResponse(
      res,
      jsonResponse({ name: killed.data.name, firedAt: killed.data.firedAt }, 200),
    );
  }

  /** text/plain on success; errors are Result JSON. */
  async function runLog(res: http.ServerResponse, name: JobName, firedAt: number): Promise<void> {
    const read = scheduler.readRunLog(name, firedAt);
    if (!read.ok) return sendWebResponse(res, jobFailureResponse(read));
    return sendWebResponse(res, runLogResponse(read.data));
  }

  return handle;
}
