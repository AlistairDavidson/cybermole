// responses.service.ts — Results → HTTP Responses (the relevant half of
// soothing-booking's responses service, plus web-pi's domain mappers).
// The ONLY place an error code becomes a status (docs/CODE_STYLE.md §3):
// every mapper is an exhaustive switch, so a new code is a type error
// here until it gets a status. Failure bodies are
// `{ error: <human message>, code, … }` — `error` stays the text the
// browser shows (console toasts, /jobs, /settings read it).
// Type-only imports from the domain modules: safe for the Astro bundle.
import type { DatabaseUpdateFailure } from '../db';
import type { DeleteJobFailure, ListJobsFailure, RunJobFailure, SaveJobFailure } from '../jobs';
import type { ActivateFailure, EnforcementFailure, ListCommitsFailure, ManagementStateFailure, RequestBuildFailure } from '../releases';
import type { ConsoleStateFailure, SettingsStateFailure } from '../services';
import type { PiUpdateFailure, PiUpdateResult } from '../settings';
import type { StoreUploadFailure } from '../storage';
import type { TmuxSessionFailure } from '../tmux';
import type { UpdateResult } from '../types';
import type { FileUploadFailure, ParseFailure, ValidationFailure } from './parsing.service';

export function jsonResponse(body: unknown, status: number, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    // no-store: these bodies are per-user state (and the service worker
    // never caches /api either).
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
}

export function successResponse<DataType extends object>(data: DataType): Response {
  return jsonResponse({ success: true, data }, 200);
}

/** Request parse / validation / upload failures. */
export function failureResponse<DataType extends object>(
  result: ParseFailure<DataType> | FileUploadFailure | ValidationFailure<DataType>,
): Response {
  switch (result.errorCode) {
    case 'invalid_form_data':
      return jsonResponse({ error: 'Invalid form data', code: result.errorCode }, 400);
    case 'invalid_json':
      return jsonResponse({ error: 'Invalid JSON', code: result.errorCode }, 400);
    case 'unsupported_content_type':
      return jsonResponse({ error: 'Unsupported content type', code: result.errorCode }, 415);
    case 'no_file_provided':
      return jsonResponse({ error: result.errorMessage ?? 'No file provided', code: result.errorCode }, 400);
    case 'file_too_large':
      return jsonResponse({ error: result.errorMessage ?? 'File too large', code: result.errorCode }, 400);
    case 'unsupported_file_type':
      return jsonResponse({ error: result.errorMessage ?? 'Unsupported file type', code: result.errorCode }, 400);
    case 'validation_failure':
      return validationFailureResponse(result);
    default:
      return result satisfies never;
  }
}

/** The first issue as one line — 'field: message', or the bare message
 *  for a root-level issue (e.g. a failed union). */
export function firstIssueText(issues: Record<string, string>): string {
  const first = Object.entries(issues)[0];
  if (!first) return 'bad request';
  const [field, message] = first;
  return field ? `${field}: ${message}` : message;
}

export function validationFailureResponse<DataType extends object>(result: ValidationFailure<DataType>): Response {
  return jsonResponse({ error: firstIssueText(result.issues), code: result.errorCode, issues: result.issues }, 400);
}

// ---------- domain mappers ----------

export type JobFailure = SaveJobFailure | DeleteJobFailure | RunJobFailure | ListJobsFailure;

/** Jobs failures → status + the { error, detail } body /jobs reads. */
export function jobFailureResponse(f: JobFailure): Response {
  const body = (error: string, detail: string | null = null) => ({ error, detail, code: f.errorCode });
  switch (f.errorCode) {
    case 'invalid_schedule':
      return jsonResponse(body(f.errorMessage ?? f.errorCode), 400);
    case 'job_not_found':
      return jsonResponse(body(f.errorMessage ?? 'no such job'), 404);
    case 'run_active':
      return jsonResponse(body(f.errorMessage ?? 'previous run is still active', f.data?.session ?? null), 409);
    case 'tmux_error':
      return jsonResponse(body('could not open run session', f.errorMessage ?? null), 500);
    case 'database_error':
      return jsonResponse(body(f.errorMessage ?? 'database error'), 500);
    default:
      return f satisfies never;
  }
}

/** A job name from the path that is not a valid JobName. */
export function invalidJobNameResponse(): Response {
  return jsonResponse({ error: 'invalid job name', detail: null, code: 'invalid_job_name' }, 400);
}

/** POST /api/new failures: the never-fork guard's refusal is a distinct,
 *  user-facing error (503 — retryable once the workspace side is back),
 *  unlike tmux's own failure, almost always a taken name (409). */
export function tmuxSessionFailureResponse(f: TmuxSessionFailure): Response {
  switch (f.errorCode) {
    case 'server_not_running':
      return jsonResponse({ error: f.errorMessage ?? 'workspace tmux server not running', code: f.errorCode }, 503);
    case 'tmux_error':
      return jsonResponse({ error: 'could not create session (name taken?)', code: f.errorCode }, 409);
    default:
      return f satisfies never;
  }
}

/** POST /api/files failures: no storage configured is the operator's to
 *  fix (503); a failed write is the storage server's (502 — it's the
 *  upstream that failed, not this request). */
export function storeUploadFailureResponse(f: StoreUploadFailure): Response {
  switch (f.errorCode) {
    case 'storage_not_configured':
      return jsonResponse({ error: f.errorMessage ?? 'object storage is not configured', code: f.errorCode }, 503);
    case 'storage_error':
      return jsonResponse({ error: 'could not store the file', detail: f.errorMessage ?? null, code: f.errorCode }, 502);
    default:
      return f satisfies never;
  }
}

export function piUpdateStatus(f: PiUpdateFailure): number {
  switch (f.errorCode) {
    case 'busy':
      return 409;
    case 'npm_missing':
    case 'npm_check_failed':
    case 'npm_failed':
      return 500;
    default:
      return f satisfies never;
  }
}

/** The wire shape POST /api/update-pi answers with (and /settings reads). */
export function updateResultBody(r: PiUpdateResult): UpdateResult {
  const data = r.data ?? { dryRun: false, command: '', before: null, after: null, output: '' };
  return r.ok ? { ok: true, ...data } : { ok: false, ...data, error: r.errorMessage ?? 'update failed' };
}

export function piUpdateResponse(r: PiUpdateResult): Response {
  return jsonResponse(updateResultBody(r), r.ok ? 200 : piUpdateStatus(r));
}

/** GET /api/state failures (the console's poll ignores any non-OK answer
 *  and retries on its next tick). */
export function consoleStateFailureResponse(f: ConsoleStateFailure): Response {
  // One-member union, like databaseUpdateFailureResponse below: a second
  // code fails to compile here.
  const code: 'database_error' = f.errorCode;
  return jsonResponse({ error: f.errorMessage ?? 'database error', code }, 500);
}

/** GET /api/settings failures (/settings shows "could not load settings"). */
export function settingsStateFailureResponse(f: SettingsStateFailure): Response {
  const code: 'database_error' = f.errorCode; // one-member union, as above
  return jsonResponse({ error: f.errorMessage ?? 'database error', code }, 500);
}

/** A failed state-db write: 500 with the caller's user-facing message. */
export function databaseUpdateFailureResponse(f: DatabaseUpdateFailure, error: string): Response {
  // The family's only code today; a second one fails to compile here
  // (a one-member union can't narrow to never in a switch).
  const code: 'database_error' = f.errorCode;
  return jsonResponse({ error, code }, 500);
}

// task/mgmt-page: the management families' failures → status + the
// { error, code } body the /management element reads (statuses:
// docs/management-page.md §5).
export type ManagementFailure =
  | ManagementStateFailure | ListCommitsFailure | EnforcementFailure | RequestBuildFailure | ActivateFailure;

export function managementFailureResponse(f: ManagementFailure): Response {
  const body = (status: number, extra: Record<string, unknown> = {}): Response =>
    jsonResponse({ error: f.errorMessage ?? f.errorCode, ...extra, code: f.errorCode }, status);
  switch (f.errorCode) {
    case 'invalid_credentials': // the password re-confirmation failed
      return body(401);
    case 'checkout_missing':    // no checkout configured/present
      return body(404);
    case 'base_unknown':        // no trustworthy diff base — operator must rebuild the image
    case 'base_not_in_checkout':
      return body(409);
    case 'target_not_found':    // the picked sha does not resolve
      return body(404);
    case 'git_error':           // git failed (incl. an unparseable diff — fail closed)
    case 'marker_error':        // could not write the builder request
    case 'database_error':
      return body(500);
    case 'enforcement_rejected': // the protected set changed — THE refusal
      return body(422);
    case 'releases_not_configured': // no WEB_PI_RELEASES_DIR volume
      return body(503);
    case 'build_active':        // another build is in flight
    case 'release_invalid':     // manifest mismatch / bad layout
      return body(409);
    case 'release_not_built':   // nothing built for that sha
      return body(404);
    default:
      return f satisfies never;
  }
}
