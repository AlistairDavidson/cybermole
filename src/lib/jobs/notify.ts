// Job-run finish notifications: one outgoing webhook POST per observed run
// finish, plus the /settings override that aims it. Effective URL resolves
// db override → CYBERMOLE_JOB_WEBHOOK_URL → off, re-read per finish so a
// /settings save applies without a restart. Delivery never blocks (or
// breaks) the scheduler's tick: fire-and-forget, a short timeout, at most
// one warn line per 10 minutes, and a delivery promise that never rejects.
import { componentLogger } from '../platform/logger';
import { readJobWebhookUrl } from '../platform/env';
import { qb, type JobRunOrigin, type StateDb } from '../platform/db';
import {
  databaseRead,
  databaseUpdate,
  type DatabaseReadResult,
  type JobName,
  type ResultFailure,
  type ResultSuccess,
} from '@cybermole/app-kit';

const KEY = 'jobs.webhookUrl';

/** Delivery cap: even a client that ignores the abort signal can't hold
 *  the (unawaited) delivery promise longer than this. */
export const WEBHOOK_TIMEOUT_MS = 5_000;
/** At most one delivery warn per window while a receiver is down. */
const WARN_EVERY_MS = 10 * 60_000;

/** The POST body of every observed run finish, JSON, utf-8. It fires for
 *  successes too — receivers filter on exitCode to tell them apart.
 *  firedAt (the run's identity) and finishedAt are epoch ms; exitCode is
 *  null when the run ended without a readable exit file (unknown, never
 *  guessed). */
export interface RunFinishedWebhook {
  event: 'job_run_finished';
  job: JobName;
  origin: JobRunOrigin;
  firedAt: number;
  finishedAt: number;
  exitCode: number | null;
}

/** The http seam: the default wraps global fetch; tests inject a fake so
 *  no unit ever touches the network. */
export type WebhookClient = (
  url: string,
  init: { body: string; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number }>;

export const nodeWebhookClient: WebhookClient = (url, init) =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: init.body,
    signal: init.signal,
  }).then(r => ({ ok: r.ok, status: r.status }));

// ---------- effective config (/settings view + notifier share it) ----------

export interface JobWebhook {
  /** null: notifications off (no override, no env default). */
  url: string | null;
  /** A db override row is set (the /settings reset UI's affordance). */
  overridden: boolean;
}

/** A corrupt or empty row reads as unset; only a db failure fails the read. */
function readOverride(db: StateDb): string | null {
  const raw = db.getSetting(KEY);
  if (raw === null) return null;
  try {
    const v: unknown = JSON.parse(raw);
    return typeof v === 'string' && v !== '' ? v : null;
  } catch {
    return null;
  }
}

/** db override → env default → off, read per finish and per /settings view. */
export function jobWebhook(
  db: StateDb,
  envUrl: () => string | null = readJobWebhookUrl,
): DatabaseReadResult<JobWebhook> {
  return databaseRead('could not read the job webhook', () => {
    const override = readOverride(db);
    return { url: override ?? envUrl(), overridden: override !== null } satisfies JobWebhook;
  });
}

export type SaveJobWebhookData = JobWebhook;
export type SaveJobWebhookErrorCode = 'database_error';
export type SaveJobWebhookSuccess = ResultSuccess<'save_job_webhook', SaveJobWebhookData>;
export type SaveJobWebhookFailure = ResultFailure<
  'save_job_webhook',
  SaveJobWebhookData,
  SaveJobWebhookErrorCode
>;
export type SaveJobWebhookResult = SaveJobWebhookSuccess | SaveJobWebhookFailure;

/** The /settings wire field: a non-empty string sets the override, null
 *  deletes the row (back to the env default / off), absent keeps. Returns
 *  the effective state. */
export function saveJobWebhook(
  db: StateDb,
  input: { jobWebhookUrl?: string | null },
): SaveJobWebhookResult {
  if (input.jobWebhookUrl !== undefined) {
    const write =
      input.jobWebhookUrl === null || input.jobWebhookUrl === ''
        ? databaseUpdate(`could not clear ${KEY}`, () =>
            db.run(qb.deleteFrom('settings').where('key', '=', KEY)),
          )
        : databaseUpdate(`could not save ${KEY}`, () =>
            db.setSetting(KEY, JSON.stringify(input.jobWebhookUrl)),
          );
    if (!write.ok)
      return {
        ok: false,
        resultType: 'save_job_webhook',
        errorCode: 'database_error',
        errorMessage: write.errorMessage,
      } satisfies SaveJobWebhookFailure;
  }
  const after = jobWebhook(db);
  if (!after.ok)
    return {
      ok: false,
      resultType: 'save_job_webhook',
      errorCode: 'database_error',
      errorMessage: after.errorMessage ?? 'could not read the job webhook',
    } satisfies SaveJobWebhookFailure;
  return {
    ok: true,
    resultType: 'save_job_webhook',
    data: after.data.value,
  } satisfies SaveJobWebhookSuccess;
}

// ---------- the notifier ----------

const log = componentLogger('scheduler');

export interface RunFinishNotifierDeps {
  db: StateDb;
  /** Test seams; the defaults are the real client and the real env read. */
  client?: WebhookClient;
  envUrl?: () => string | null;
  warn?: (message: string) => void;
  timeoutMs?: number;
  warnEveryMs?: number;
}

/** Never throws; the delivery promise it starts never rejects. Await it in
 *  tests — the scheduler deliberately doesn't (the tick moves on). */
export function createRunFinishNotifier(
  deps: RunFinishNotifierDeps,
): (payload: RunFinishedWebhook) => Promise<void> {
  const client = deps.client ?? nodeWebhookClient;
  const envUrl = deps.envUrl ?? readJobWebhookUrl;
  const warnEveryMs = deps.warnEveryMs ?? WARN_EVERY_MS;
  const timeoutMs = deps.timeoutMs ?? WEBHOOK_TIMEOUT_MS;
  const warn = deps.warn ?? ((message: string) => log.warn(message));
  let lastWarn = 0;
  const warnRateSane = (reason: string): void => {
    const now = Date.now();
    if (now - lastWarn < warnEveryMs) return;
    lastWarn = now;
    warn(reason);
  };
  return async payload => {
    let url: string | null = null;
    try {
      const resolved = jobWebhook(deps.db, envUrl);
      if (resolved.ok) url = resolved.data.value.url;
      else warnRateSane(`job webhook: ${resolved.errorMessage}`);
    } catch (err) {
      // A malformed env default: the boot normally refuses it first.
      warnRateSane(`job webhook: ${(err as Error).message}`);
      return;
    }
    if (url === null) return;
    const controller = new AbortController();
    let expired: () => void = () => {};
    const cap = new Promise<null>(resolve => {
      expired = () => resolve(null);
    });
    // The signal is the timeout for clients that honor it; the race caps
    // the wait for one that doesn't. Either way the timer is cleared.
    const timer = setTimeout(() => {
      controller.abort();
      expired();
    }, timeoutMs);
    try {
      // The losing promise of the race is still listened to, so a late
      // client rejection can't surface as unhandled.
      const sent = await Promise.race([
        client(url, { body: JSON.stringify(payload), signal: controller.signal }),
        cap,
      ]);
      if (sent === null) warnRateSane(`job webhook: ${url} timed out after ${timeoutMs}ms`);
      else if (!sent.ok)
        warnRateSane(`job webhook: ${url} answered HTTP ${sent.status} — delivery not confirmed`);
    } catch (err) {
      warnRateSane(
        `job webhook: ${url} unreachable (${err instanceof Error ? err.message : String(err)})`,
      );
    } finally {
      clearTimeout(timer);
    }
  };
}
