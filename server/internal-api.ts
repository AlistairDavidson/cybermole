// internal-api.ts — the internal jobs API (task/jobs-socket,
// docs/jobs-agent-plan.md §3–§4): a second HTTP listener on a unix
// domain socket, served by the same Node process as the console, serving
// the WORKSPACE side (agents) the jobs surface. JSON only; nginx / the
// TLS proxy never see this listener (it is not a TCP port).
//
// The socket IS the gate (plan §2): no cookie middleware, no CSRF, no
// rate limit — full jobs control is the workspace side's own shell
// privilege, so there is nothing to escalate to. The file's mode after
// listen (0660, the shared setgid group in the compose split) is the
// only auth.
//
// Routes are THIN: every verb calls the same src/lib/jobs service
// functions the cookie-gated /api/jobs routes use, and answers with the
// SAME Result JSON — the mappers in src/lib/web/responses.service.ts
// are reused verbatim, so a body produced here is byte-identical to the
// browser API's. Mutations never take a parallel path (plan §4): that
// single source of truth is what keeps every surface consistent.
//
// Importable without server/main.ts — unit tests boot this module alone
// on a tmp-dir socket. CYBERMOLE_SOCK's resolution rules live in
// src/lib/env.ts (readInternalApiSocket); this module takes a resolved
// absolute path.
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { componentLogger } from '../src/lib/logger';
import { checkCron, type ListJobsFailure, type Scheduler } from '../src/lib/jobs';
import type { Apps } from '../src/lib/apps';
import {
  appFailureResponse,
  appFilterNotFoundResponse,
  failureResponse,
  invalidAppSlugResponse,
  invalidFiredAtResponse,
  invalidJobNameResponse,
  jobFailureResponse,
  jsonResponse,
  runLogResponse,
} from '../src/lib/web/responses.service';
import { parseAndValidateAPIRequest } from '../src/lib/web/parsing.service';
import { AppSlugSchema, JobNameSchema } from '../src/schemas/ids';
import {
  FiredAtSchema,
  JobPatchSchema,
  JobSaveSchema,
  JobValidateSchema,
} from '../src/schemas/jobs';
import type { AppId, JobName } from '../src/types/branded';

const log = componentLogger('internal-api');

// Same body policy as the public JSON API (server/main.ts): 10 KiB
// covers every jobs body (MAX_COMMAND is 4000 chars), a declared length
// over it answers 413 before a byte is read, and a length-less chunked
// body is refused with 411 — the CLI (plan §5) sends Content-Length.
const BODY_MAX_BYTES = 10 * 1024;

export interface InternalApiDeps {
  /** absolute socket path (env.ts readInternalApiSocket — never null here) */
  socketPath: string;
  /** THE scheduler instance the browser routes share (plan §4: one
   *  source of truth — this must be the same object main.ts hands to the
   *  Astro handler in locals, never a second Scheduler). */
  scheduler: Scheduler;
  /** the app domain — GET /jobs' ?app=<slug> filter resolves the slug to
   *  the app row's id (jobs store app_id, not slug). */
  apps: Pick<Apps, 'listApps'>;
}

export interface InternalApiHandle {
  readonly socketPath: string;
  /** Stop listening, let in-flight requests drain, unlink the socket
   *  file (best-effort — a crash leaves it behind and the next boot's
   *  stale-socket check removes it). */
  close(): Promise<void>;
}

/** The socket file exists AND answers — another cybermole server owns it.
 *  main.ts treats this one specially (plan §3, amended in integration):
 *  the web app SERVES ON, with this listener disabled and a loud boot
 *  line — crashing the whole web server over an auxiliary IPC listener
 *  would let a second instance on the same state dir (dev box, tests)
 *  take the primary down. Anything else that fails here still fails the
 *  boot. */
export class InternalSocketOwnedError extends Error {
  constructor(readonly socketPath: string) {
    super(
      `another cybermole server owns the socket (${socketPath}) — ` +
        'this instance serves without the internal API; stop the other server, or point CYBERMOLE_SOCK elsewhere',
    );
    this.name = 'InternalSocketOwnedError';
  }
}

// ---------- socket lifecycle (plan §3) ----------

/** Liveness probe of an existing socket file: can anything answer on it?
 *  'stale' = nothing does (ECONNREFUSED/ENOENT — a dead server's
 *  leftover file: unlink and rebind, exactly the workspace entrypoint's
 *  stale-tmux-socket handling); 'live' = a server accepted (or the probe
 *  otherwise failed — timeout, EACCES: fail closed, never steal a
 *  socket that might be owned). */
export function probeSocketFile(socketPath: string, timeoutMs = 500): Promise<'live' | 'stale'> {
  return new Promise(resolve => {
    const socket = net.connect({ path: socketPath });
    const finish = (state: 'live' | 'stale'): void => {
      clearTimeout(timer);
      socket.destroy();
      resolve(state);
    };
    const timer = setTimeout(() => finish('live'), timeoutMs); // unreadable → assume owned
    socket.on('connect', () => finish('live'));
    socket.on('error', err => {
      const code = (err as NodeJS.ErrnoException).code;
      finish(code === 'ECONNREFUSED' || code === 'ENOENT' ? 'stale' : 'live');
    });
  });
}

/** Boot the internal API: claim the socket (stale file → unlink, live
 *  listener → InternalSocketOwnedError), listen, then chmod the file
 *  0660 — group access is the gate in the compose split (the setgid
 *  /run/cybermole dir gives the file the shared group; on a plain host the
 *  process's own group), mirroring the workspace entrypoint's tmux-socket
 *  chmod. Resolves once the listener is up. */
export async function startInternalApi(deps: InternalApiDeps): Promise<InternalApiHandle> {
  // The socket's parent dir is created if missing: the state-dir default
  // (~/.local/state/cybermole) is only otherwise materialized by the db / agent
  // dir (main.ts mkdirs the agent dir), so a server booted with those pointed
  // elsewhere — the e2e specs' spawned second servers, a dev's first run —
  // would otherwise die on listen EACCES/ENOENT. The /run/cybermole shape is
  // only ever chosen when that dir already exists (env.ts probes), so the
  // recursive mkdir is a no-op there and never tries to conjure a root path.
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
    // Crash guard, same stance as main.ts's: a throwing route costs one
    // 500, never the process (and every terminal with it).
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
      // Post-boot socket-level errors (a vanishing socket dir): logged,
      // never an unhandled 'error' event.
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

/** One access line per request (main.ts's logAccess, minus the quiet
 *  paths — no assets are served here). */
function logAccess(req: http.IncomingMessage, res: http.ServerResponse): void {
  const start = Date.now();
  res.on('finish', () => {
    log.http(
      `${req.method} ${(req.url ?? '').split('?')[0]} ${res.statusCode} in ${Date.now() - start}ms`,
    );
  });
}

/** 413 (declared length over the cap), 411 (chunked, no length — the
 *  public API's stance) or null (within the cap). */
function bodyCapStatus(req: http.IncomingMessage): 411 | 413 | null {
  if (req.method === 'GET' || req.method === 'HEAD') return null;
  const declared = req.headers['content-length'];
  if (declared === undefined) {
    return req.headers['transfer-encoding'] !== undefined ? 411 : null;
  }
  return Number(declared) <= BODY_MAX_BYTES ? null : 413;
}

/** The request body as raw bytes (possibly empty). Null when over the
 *  cap — the stream is destroyed and the caller answers 413. */
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

/** A fetch-API Request for parseAndValidateAPIRequest — the exact parser
 *  the browser routes use (content-type gate, JSON parse, zod, the same
 *  failure codes). Only content-type rides over: it is the one header
 *  the parser reads. */
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

/** Read the (cap-checked) body and wrap it in the fetch Request the
 *  shared parser takes. A body over the streaming cap answers a 413 the
 *  caller sends as-is (bodyCapStatus already caught the declared-length
 *  case; this is the lying-client case). */
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

/** Write a responses.service Response onto the node server response —
 *  status, headers and body verbatim, so bodies are byte-identical to
 *  the browser API's. */
async function sendWebResponse(res: http.ServerResponse, r: Response): Promise<void> {
  const headers: Record<string, string> = {};
  r.headers.forEach((value, name) => {
    headers[name] = value;
  });
  res.writeHead(r.status, headers);
  res.end(await r.text());
}

/** Unknown path (or a known path without a matching verb — like Astro,
 *  whose route table matches path+method): 404 with a Result body, never
 *  an HTML error page. */
function notFoundResponse(): Response {
  return jsonResponse({ error: 'not found', detail: null, code: 'not_found' }, 404);
}

// ---------- routes (plan §4 — thin; every call is the same service
// function the browser route uses) ----------

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
    // Astro decodes path params; do the same per segment. A bad %-escape
    // is a client error (main.ts answers 400 for it on the public side).
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
      // GET only: the picker is a READ (plan §6 — the MCP's apps_list tool,
      // the same rows the browser dialog renders). Creating and managing
      // apps stays on the console surface — §2 granted the workspace side
      // jobs control, not app management.
      if (req.method === 'GET') return listApps(res);
      return sendWebResponse(res, notFoundResponse());
    }

    if (segments.length === 1 && segments[0] === 'jobs') {
      if (req.method === 'GET') return listJobs(res, url.searchParams.get('app'));
      if (req.method === 'POST') return saveJob(req, res);
      return sendWebResponse(res, notFoundResponse());
    }
    if (segments.length === 2 && segments[0] === 'jobs') {
      // The static route wins over the :name param, exactly like Astro's
      // route table (a job literally named "validate" is not addressable
      // — JOB_NAME_RE allows it; the browser surface has the same shadow).
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

  /** GET /apps — the app rows the jobs tools' tag picker needs (plan
   *  §6: the MCP's apps_list; the browser's save dialog renders the same
   *  rows from /api/state's apps half). */
  async function listApps(res: http.ServerResponse): Promise<void> {
    const listed = apps.listApps();
    if (!listed.ok) return sendWebResponse(res, appFailureResponse(listed));
    return sendWebResponse(res, jsonResponse(listed.data, 200));
  }

  /** GET /jobs (?app=<slug> — filter to one app's tagged jobs; an
   *  unknown slug is a 404, not an empty list, so an agent cannot
   *  mistake "no such app" for "no jobs"). */
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

  /** POST /jobs — create/update (the browser's POST /api/jobs verb). */
  async function saveJob(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await readRequest(req);
    if (!body.ok) return sendWebResponse(res, body.response);
    const parsed = await parseAndValidateAPIRequest(body.request, JobSaveSchema);
    if (!parsed.ok) return sendWebResponse(res, failureResponse(parsed));
    const saved = await scheduler.saveJob(parsed.data);
    if (!saved.ok) return sendWebResponse(res, jobFailureResponse(saved));
    return sendWebResponse(res, jsonResponse({ name: saved.data.name, session: null }, 200));
  }

  /** POST /jobs/validate — cron + command validation (plan §4; the
   *  browser verb is schedule-only). An invalid value is an ANSWER (200
   *  with valid:false + error), not a failed request — the browser
   *  verb's stance. Response: each present field's check, absent fields
   *  null. */
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
            // The same rule JobSaveSchema applies (schemas/jobs.ts).
            const checked = JobPatchSchema.shape.command.safeParse(parsed.data.command);
            return checked.success
              ? { valid: true, error: null }
              : { valid: false, error: checked.error.issues[0]?.message ?? 'invalid command' };
          })();
    return sendWebResponse(res, jsonResponse({ schedule, command }, 200));
  }

  /** PATCH /jobs/:name — set schedule/command/app: absent keeps, null
   *  clears the app tag (read-merge-write; the save goes through the
   *  SAME saveJob the browser's create verb uses). */
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

  /** DELETE /jobs/:name. */
  async function deleteJob(res: http.ServerResponse, name: JobName): Promise<void> {
    const deleted = await scheduler.deleteJob(name);
    if (!deleted.ok) return sendWebResponse(res, jobFailureResponse(deleted));
    return sendWebResponse(res, jsonResponse({ name: deleted.data.name, session: null }, 200));
  }

  /** GET /jobs/:name/runs. */
  async function listRuns(res: http.ServerResponse, name: JobName): Promise<void> {
    const listed = scheduler.listRuns(name);
    if (!listed.ok) return sendWebResponse(res, jobFailureResponse(listed));
    return sendWebResponse(res, jsonResponse(listed.data, 200));
  }

  /** POST /jobs/:name/run — run now (409 while the previous run lives). */
  async function runJob(res: http.ServerResponse, name: JobName): Promise<void> {
    const run = await scheduler.runJob(name);
    if (!run.ok) return sendWebResponse(res, jobFailureResponse(run));
    return sendWebResponse(
      res,
      jsonResponse({ name: run.data.name, session: run.data.session }, 200),
    );
  }

  /** POST /jobs/:name/runs/:firedAt/kill — kill the live run (plan §4;
   *  409 run_not_active when the named run is not the live one). */
  async function killRun(res: http.ServerResponse, name: JobName, firedAt: number): Promise<void> {
    const killed = await scheduler.killRun(name, firedAt);
    if (!killed.ok) return sendWebResponse(res, jobFailureResponse(killed));
    return sendWebResponse(
      res,
      jsonResponse({ name: killed.data.name, firedAt: killed.data.firedAt }, 200),
    );
  }

  /** GET /jobs/:name/runs/:firedAt/log — the run's log tail (≤ 1 MiB,
   *  text/plain like the browser verb — the one non-JSON success body on
   *  this surface; errors are Result JSON like everywhere else). */
  async function runLog(res: http.ServerResponse, name: JobName, firedAt: number): Promise<void> {
    const read = scheduler.readRunLog(name, firedAt);
    if (!read.ok) return sendWebResponse(res, jobFailureResponse(read));
    return sendWebResponse(res, runLogResponse(read.data));
  }

  return handle;
}
