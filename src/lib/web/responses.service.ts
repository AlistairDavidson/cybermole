// Results → HTTP Responses: the only place an error code becomes a status.
// Every mapper is an exhaustive switch, so a new code is a type error here.
// Failure bodies are `{ error, code, … }`, where `error` is the text the UI
// shows. Type-only domain imports keep this safe for the Astro bundle.
import {
  jsonResponse,
  validationFailureResponse,
  type DatabaseUpdateFailure,
} from '@cybermole/app-kit';
import type {
  DeleteAppFailure,
  ListAppsFailure,
  ReorderAppsFailure,
  SaveAppFailure,
} from '../apps/apps';
import type {
  DeleteJobFailure,
  GetJobFailure,
  KillRunFailure,
  ListJobsFailure,
  ListRunsFailure,
  RunJobFailure,
  RunLogData,
  RunLogFailure,
  SaveJobFailure,
} from '../jobs/jobs';
import type {
  CloseTerminalFailure,
  DeleteWorkspaceFailure,
  NewTerminalFailure,
  RenameTerminalFailure,
  ReorderTerminalsFailure,
  ReorderWorkspacesFailure,
  SaveWorkspaceFailure,
} from '../terminals/workspaces';
import type {
  AppsStatusFailure,
  ConsoleStateFailure,
  SettingsStateFailure,
} from '../platform/services';
import type { PiUpdateFailure, PiUpdateResult } from '../platform/settings';
import type {
  SaveTerminalDefaultsFailure,
  TerminalDefaultsFailure,
} from '../terminals/terminal-defaults';
import type {
  FetchedObject,
  FetchObjectFailure,
  ObjectInfo,
  StatObjectFailure,
  StoreUploadFailure,
} from '../platform/storage';
import type { UpdateResult } from '../platform/types';
import { UPLOAD_ALLOWED_MIME_TYPES } from '../../schemas/uploads';
import type { FileUploadFailure, ParseFailure, ValidationFailure } from './parsing.service';

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
      return jsonResponse(
        { error: result.errorMessage ?? 'No file provided', code: result.errorCode },
        400,
      );
    case 'file_too_large':
      return jsonResponse(
        { error: result.errorMessage ?? 'File too large', code: result.errorCode },
        413,
      );
    case 'unsupported_file_type':
      return jsonResponse(
        { error: result.errorMessage ?? 'Unsupported file type', code: result.errorCode },
        400,
      );
    case 'validation_failure':
      return validationFailureResponse(result);
    default:
      return result satisfies never;
  }
}

// ---------- domain mappers ----------

export type JobFailure =
  | SaveJobFailure
  | DeleteJobFailure
  | RunJobFailure
  | ListJobsFailure
  | ListRunsFailure
  | RunLogFailure
  | GetJobFailure
  | KillRunFailure;

export function jobFailureResponse(f: JobFailure): Response {
  const body = (error: string, detail: string | null = null) => ({
    error,
    detail,
    code: f.errorCode,
  });
  switch (f.errorCode) {
    case 'invalid_schedule':
      return jsonResponse(body(f.errorMessage ?? f.errorCode), 400);
    case 'app_not_found':
    case 'job_not_found':
      return jsonResponse(body(f.errorMessage ?? 'no such job'), 404);
    case 'run_not_found':
      return jsonResponse(body(f.errorMessage ?? 'no such run'), 404);
    case 'log_missing':
      return jsonResponse(body(f.errorMessage ?? 'the run left no log'), 404);
    case 'run_active':
      return jsonResponse(
        body(f.errorMessage ?? 'previous run is still active', f.data?.session ?? null),
        409,
      );
    // Retryable by re-reading the runs list, like run_active.
    case 'run_not_active':
      return jsonResponse(body(f.errorMessage ?? 'the run is not running'), 409);
    case 'tmux_error':
      return jsonResponse(
        body(
          f.resultType === 'kill_run'
            ? 'could not kill the run session'
            : 'could not open run session',
          f.errorMessage ?? null,
        ),
        500,
      );
    case 'read_error':
      return jsonResponse(body(f.errorMessage ?? 'could not read the run log'), 500);
    case 'database_error':
      return jsonResponse(body(f.errorMessage ?? 'database error'), 500);
    default:
      return f satisfies never;
  }
}

/** The ?app=<slug> filter names no app. */
export function appFilterNotFoundResponse(): Response {
  return jsonResponse({ error: 'no such app', detail: null, code: 'app_not_found' }, 404);
}

export function invalidJobNameResponse(): Response {
  return jsonResponse({ error: 'invalid job name', detail: null, code: 'invalid_job_name' }, 400);
}

export function invalidFiredAtResponse(): Response {
  return jsonResponse(
    { error: 'invalid fired_at (integer epoch ms)', detail: null, code: 'invalid_fired_at' },
    400,
  );
}

/** text/plain; truncation is flagged in a header so the body is just the log. */
export function runLogResponse(data: RunLogData): Response {
  return new Response(data.text, {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      ...(data.truncated ? { 'X-Run-Log-Truncated': '1' } : {}),
    },
  });
}

export type AppFailure = SaveAppFailure | DeleteAppFailure | ListAppsFailure | ReorderAppsFailure;

export function appFailureResponse(f: AppFailure): Response {
  switch (f.errorCode) {
    case 'invalid_name':
      return jsonResponse({ error: f.errorMessage ?? 'invalid name', code: f.errorCode }, 400);
    case 'invalid_cwd':
      return jsonResponse({ error: f.errorMessage ?? 'invalid cwd', code: f.errorCode }, 400);
    case 'duplicate_slug':
      return jsonResponse(
        { error: f.errorMessage ?? 'an app with that slug already exists', code: f.errorCode },
        409,
      );
    case 'app_not_found':
      return jsonResponse({ error: f.errorMessage ?? 'no such app', code: f.errorCode }, 404);
    case 'invalid_order':
      // The client's list doesn't match the rows: stale state, so a re-read
      // (not a tweak) is the fix.
      return jsonResponse({ error: f.errorMessage ?? 'invalid order', code: f.errorCode }, 409);
    case 'database_error':
      return jsonResponse({ error: f.errorMessage ?? 'database error', code: f.errorCode }, 500);
    default:
      return f satisfies never;
  }
}

export function invalidAppSlugResponse(): Response {
  return jsonResponse({ error: 'invalid app slug', code: 'invalid_app_slug' }, 400);
}

export type WorkspaceFailure =
  SaveWorkspaceFailure | DeleteWorkspaceFailure | ReorderWorkspacesFailure;

export function workspaceFailureResponse(f: WorkspaceFailure): Response {
  switch (f.errorCode) {
    case 'invalid_name':
      return jsonResponse({ error: f.errorMessage ?? 'invalid name', code: f.errorCode }, 400);
    case 'invalid_cwd':
      return jsonResponse({ error: f.errorMessage ?? 'invalid cwd', code: f.errorCode }, 400);
    case 'invalid_kind':
      return jsonResponse({ error: f.errorMessage ?? 'invalid kind', code: f.errorCode }, 400);
    case 'app_not_found':
    case 'workspace_not_found':
      return jsonResponse({ error: f.errorMessage ?? 'no such workspace', code: f.errorCode }, 404);
    case 'invalid_order':
      // The client's list doesn't match the group: stale state, so a
      // re-read (not a tweak) is the fix.
      return jsonResponse({ error: f.errorMessage ?? 'invalid order', code: f.errorCode }, 409);
    case 'database_error':
      return jsonResponse({ error: f.errorMessage ?? 'database error', code: f.errorCode }, 500);
    default:
      return f satisfies never;
  }
}

export function invalidWorkspaceIdResponse(): Response {
  return jsonResponse({ error: 'invalid workspace id', code: 'invalid_workspace_id' }, 400);
}

export type TerminalFailure =
  NewTerminalFailure | CloseTerminalFailure | RenameTerminalFailure | ReorderTerminalsFailure;

/** server_not_running is retryable once the workspace side is back. A
 *  spawn-failed create still carries its row, so the UI can show the tab. */
export function terminalFailureResponse(f: TerminalFailure): Response {
  // Only new_terminal failures carry data.
  const terminal = f.resultType === 'new_terminal' && f.data ? { terminal: f.data } : {};
  switch (f.errorCode) {
    case 'workspace_not_found':
    case 'terminal_not_found':
      return jsonResponse({ error: f.errorMessage ?? 'no such terminal', code: f.errorCode }, 404);
    case 'invalid_order':
      // The client's list doesn't match the workspace: stale state, so a
      // re-read (not a tweak) is the fix.
      return jsonResponse({ error: f.errorMessage ?? 'invalid order', code: f.errorCode }, 409);
    case 'server_not_running':
      return jsonResponse(
        {
          error: f.errorMessage ?? 'workspace tmux server not running',
          code: f.errorCode,
          ...terminal,
        },
        503,
      );
    case 'tmux_error':
      return jsonResponse(
        { error: f.errorMessage ?? 'tmux error', code: f.errorCode, ...terminal },
        500,
      );
    case 'database_error':
      return jsonResponse({ error: f.errorMessage ?? 'database error', code: f.errorCode }, 500);
    default:
      return f satisfies never;
  }
}

export function invalidTerminalIdResponse(): Response {
  return jsonResponse({ error: 'invalid terminal id', code: 'invalid_terminal_id' }, 400);
}

/** Unconfigured storage is 503; a storage-server failure is 502 (upstream). */
export function objectStoreFailureResponse(
  f: StoreUploadFailure | FetchObjectFailure | StatObjectFailure,
): Response {
  switch (f.errorCode) {
    case 'storage_not_configured':
      return jsonResponse(
        { error: f.errorMessage ?? 'object storage is not configured', code: f.errorCode },
        503,
      );
    case 'object_not_found':
      return jsonResponse({ error: 'no such file', code: f.errorCode }, 404);
    case 'range_not_satisfiable': {
      // RFC 9110 §15.5.17: report the size so a client can recover.
      const size = f.data?.objectSize ?? null;
      return jsonResponse({ error: 'range not satisfiable', code: f.errorCode }, 416, {
        'Accept-Ranges': 'bytes',
        ...(size === null ? {} : { 'Content-Range': `bytes */${size}` }),
      });
    }
    case 'storage_error': {
      const error =
        f.resultType === 'store_upload' ? 'could not store the file' : 'could not read the file';
      return jsonResponse({ error, detail: f.errorMessage ?? null, code: f.errorCode }, 502);
    }
    default:
      return f satisfies never;
  }
}

export function invalidObjectKeyResponse(): Response {
  return jsonResponse({ error: 'invalid file key', code: 'invalid_object_key' }, 400);
}

/** User content on our own origin is never rendered: always an attachment,
 *  octet-stream outside the upload allowlist, and a sandboxing CSP (which
 *  wins, since main.ts only fills absent headers). */
function downloadHeaders(info: ObjectInfo): Record<string, string> {
  const allowed: readonly string[] = UPLOAD_ALLOWED_MIME_TYPES;
  const headers: Record<string, string> = {
    'Content-Type':
      info.contentType !== null && allowed.includes(info.contentType)
        ? info.contentType
        : 'application/octet-stream',
    'Content-Disposition': info.contentDisposition?.startsWith('attachment')
      ? info.contentDisposition
      : 'attachment',
    'Content-Security-Policy': "sandbox; default-src 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, no-store',
    'Accept-Ranges': 'bytes',
  };
  if (info.contentLength !== null) headers['Content-Length'] = String(info.contentLength);
  if (info.etag !== null) headers['ETag'] = info.etag;
  if (info.lastModified !== null) headers['Last-Modified'] = info.lastModified.toUTCString();
  return headers;
}

/** 206 with Content-Range when a range was applied. */
export function fileDownloadResponse(object: FetchedObject): Response {
  const headers = downloadHeaders(object);
  if (object.contentRange !== null) headers['Content-Range'] = object.contentRange;
  return new Response(object.body, { status: object.contentRange === null ? 200 : 206, headers });
}

export function fileHeadResponse(info: ObjectInfo): Response {
  return new Response(null, { status: 200, headers: downloadHeaders(info) });
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

export function updateResultBody(r: PiUpdateResult): UpdateResult {
  const data = r.data ?? { dryRun: false, command: '', before: null, after: null, output: '' };
  return r.ok
    ? { ok: true, ...data }
    : { ok: false, ...data, error: r.errorMessage ?? 'update failed' };
}

export function piUpdateResponse(r: PiUpdateResult): Response {
  return jsonResponse(updateResultBody(r), r.ok ? 200 : piUpdateStatus(r));
}

export function consoleStateFailureResponse(f: ConsoleStateFailure): Response {
  // One-member union (here and below): a second code fails to compile.
  const code: 'database_error' = f.errorCode;
  return jsonResponse({ error: f.errorMessage ?? 'database error', code }, 500);
}

export function appsStatusFailureResponse(f: AppsStatusFailure): Response {
  const code: 'database_error' = f.errorCode;
  return jsonResponse({ error: f.errorMessage ?? 'database error', code }, 500);
}

export function settingsStateFailureResponse(f: SettingsStateFailure): Response {
  const code: 'database_error' = f.errorCode;
  return jsonResponse({ error: f.errorMessage ?? 'database error', code }, 500);
}

export function terminalDefaultsFailureResponse(
  f: TerminalDefaultsFailure | SaveTerminalDefaultsFailure,
): Response {
  const code: 'database_error' = f.errorCode;
  return jsonResponse({ error: f.errorMessage ?? 'database error', code }, 500);
}

export function databaseUpdateFailureResponse(f: DatabaseUpdateFailure, error: string): Response {
  const code: 'database_error' = f.errorCode;
  return jsonResponse({ error, code }, 500);
}
