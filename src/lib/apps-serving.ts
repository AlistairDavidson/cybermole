// apps-serving.ts — GET /api/state's per-app `serving` flag
// (task/app-web, apps-plan §4): a cheap GET /_admin/status against the
// app host's socket, once per state-poll window, so a dead host is
// visible in the console rather than mysterious (the sidebar's open
// link dims; a proxied request answers 502 with the same story).
//
// Bounded by construction: the ping carries a SHORT timeout (a hung
// socket must never stall the 15 s state poll), is single-flight
// (every open tab's poll shares one attempt), and its outcome — success
// OR failure — is cached until the window passes (the failure
// NEGATIVELY cached: the next window's poll is what retries, not a
// retry storm of dead sockets).
//
// The join itself (joinServing) is pure: rows + one snapshot → the
// augmented apps array /api/state serves (an ADDITIVE field — the
// console's other consumers ignore it).
import { requestInternalApi } from './internal-api-client';
import type { AppState, AppServingState } from './types';

/** The app host's /_admin/status, reduced to what the join needs. */
export interface AppHostStatusView {
  /** false while the host's boot retry loop is still waiting for the
   *  internal API (the compose boot race) — the socket answers, but
   *  with no mounts yet. */
  booted: boolean;
  mounted: Set<string>;
  /** slug → the reported reason a complete mount did not happen. */
  skipped: Map<string, string>;
}

/** One snapshot: reachable (the host answered a well-formed status) or
 *  not, with a one-line reason the sidebar shows as the tooltip. */
export interface AppsServingInfo {
  reachable: boolean;
  status: AppHostStatusView | null;
  failureReason: string | null;
}

const SURFACE_OFF_REASON = 'apps surface off (CYBERMOLE_APPS_SOCK is empty)';

/** Fetch + parse the host's /_admin/status over its socket. Transport
 *  failures, non-200 answers and malformed bodies all degrade to a
 *  failure result — the state poll serves apps with serving:false
 *  rather than erroring over the badge data. */
export async function fetchAppHostStatus(
  socketPath: string,
  timeoutMs: number,
): Promise<{ ok: true; status: AppHostStatusView } | { ok: false; reason: string }> {
  let answer: Awaited<ReturnType<typeof requestInternalApi>>;
  try {
    answer = await requestInternalApi(
      socketPath,
      { method: 'GET', path: '/_admin/status' },
      { timeoutMs },
    );
  } catch (err) {
    return { ok: false, reason: `app host unreachable (${(err as Error).message})` };
  }
  if (answer.status !== 200) {
    return { ok: false, reason: `app host answered ${answer.status} on /_admin/status` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(answer.body);
  } catch {
    return { ok: false, reason: 'app host answered a non-JSON /_admin/status' };
  }
  const raw = parsed as { booted?: unknown; mounted?: unknown; skipped?: unknown };
  const slugs = (arr: unknown): string[] | null =>
    Array.isArray(arr) &&
    arr.every(
      e =>
        typeof e === 'object' && e !== null && typeof (e as { slug?: unknown }).slug === 'string',
    )
      ? (arr as Array<{ slug: string }>).map(e => e.slug)
      : null;
  const mounted = slugs(raw.mounted);
  if (mounted === null) return { ok: false, reason: 'app host answered no mounted array' };
  const skippedRaw = Array.isArray(raw.skipped)
    ? (raw.skipped as Array<{ slug?: unknown; reason?: unknown }>)
    : null;
  if (
    skippedRaw === null ||
    !skippedRaw.every(e => typeof e.slug === 'string' && typeof e.reason === 'string')
  )
    return { ok: false, reason: 'app host answered no skipped array' };
  return {
    ok: true,
    status: {
      booted: raw.booted === true,
      mounted: new Set(mounted),
      skipped: new Map(skippedRaw.map(e => [e.slug as string, e.reason as string])),
    },
  };
}

export interface AppsServingDeps {
  /** The resolved apps socket (env.ts readAppsSocket); null = the
   *  surface is off — every app reports serving:false with the
   *  empty-env reason, and no request is ever made. */
  socketPath: string | null;
  /** Ping timeout. Default 500 ms — the status route is a registry
   *  read; anything slower is a wedging host. */
  timeoutMs?: number;
  /** Cache window — success and failure alike — default 10 s (under
   *  the 15 s state poll, so each poll's join sees a fresh-enough
   *  snapshot while concurrent tabs share one attempt). */
  ttlMs?: number;
  /** Clock injectable for units. */
  now?: () => number;
  /** Transport injectable for units. */
  fetchStatus?: typeof fetchAppHostStatus;
}

export class AppsServing {
  private readonly deps: AppsServingDeps;
  private cached: AppsServingInfo | null = null;
  private cachedAt = -Infinity;
  private inFlight: Promise<AppsServingInfo> | null = null;

  constructor(deps: AppsServingDeps) {
    this.deps = deps;
  }

  /** One snapshot, cached for the window: the first caller of a window
   *  does the attempt (single-flight — every open tab's poll awaits the
   *  SAME promise, so a hung socket costs its timeout once); callers
   *  inside the window get the cached answer, failure included. */
  info(): Promise<AppsServingInfo> {
    if (this.deps.socketPath === null && this.cached) return Promise.resolve(this.cached);
    const now = this.deps.now ?? Date.now;
    const ttl = this.deps.ttlMs ?? 10_000;
    if (this.cached !== null && now() - this.cachedAt < ttl) return Promise.resolve(this.cached);
    if (this.inFlight) return this.inFlight;
    const attempt = (async (): Promise<AppsServingInfo> => {
      if (this.deps.socketPath === null) {
        return { reachable: false, status: null, failureReason: SURFACE_OFF_REASON };
      }
      const fetchStatus = this.deps.fetchStatus ?? fetchAppHostStatus;
      const got = await fetchStatus(this.deps.socketPath, this.deps.timeoutMs ?? 500);
      return got.ok
        ? { reachable: true, status: got.status, failureReason: null }
        : { reachable: false, status: null, failureReason: got.reason };
    })();
    this.inFlight = attempt;
    attempt
      .then(info => {
        this.cached = info;
        this.cachedAt = (this.deps.now ?? Date.now)();
      })
      .catch(() => undefined) // fetchStatus is total; the belt keeps a throw from wedging inFlight
      .finally(() => {
        this.inFlight = null;
      });
    return attempt;
  }
}

/** The pure join: app rows + one snapshot → the augmented array
 *  /api/state serves. serving means the host answered AND has this slug
 *  mounted; the reason names the honest story otherwise (the host's own
 *  skip reason when it reported one). */
export function joinServing(apps: AppState[], info: AppsServingInfo): AppServingState[] {
  return apps.map(app => {
    if (info.reachable && info.status !== null && info.status.mounted.has(app.slug)) {
      return { ...app, serving: true, servingReason: null };
    }
    let reason: string;
    if (!info.reachable) reason = info.failureReason ?? 'app host unreachable';
    else {
      const skipped = info.status?.skipped.get(app.slug);
      if (skipped !== undefined) reason = skipped;
      else reason = 'not mounted — no build served for this app (build it, then reload the host)';
    }
    return { ...app, serving: false, servingReason: reason };
  });
}
