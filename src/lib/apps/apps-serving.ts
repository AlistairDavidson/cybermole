// GET /api/state's per-app `serving` flag, from the app host's /_admin/status.
// Bounded: a short timeout and single-flight (all open tabs share one ping),
// so a hung socket never stalls the poll. Successes are cached briefly;
// failures aren't.
import { requestInternalApi } from '../platform/internal-api-client';
import type { AppState, AppServingState } from '../platform/types';

export interface AppHostStatusView {
  /** false while the host is still waiting for the internal API at boot. */
  booted: boolean;
  mounted: Set<string>;
  /** slug → why it wasn't mounted */
  skipped: Map<string, string>;
}

/** failureReason becomes the sidebar tooltip. */
export interface AppsServingInfo {
  reachable: boolean;
  status: AppHostStatusView | null;
  failureReason: string | null;
}

const SURFACE_OFF_REASON = 'apps surface off (CYBERMOLE_APPS_SOCK is empty)';

/** Any failure degrades to serving:false rather than failing the state poll. */
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
  /** null: apps off; every app reports serving:false and nothing is requested. */
  socketPath: string | null;
  /** Default 500 ms: the status route is a registry read. */
  timeoutMs?: number;
  /** Success cache window, default 10 s (under the 15 s poll). Failures
   *  aren't cached: a dead socket refuses in ~0.1 ms, and a stale negative
   *  would keep dimming an app that just mounted. A hung socket is bounded
   *  by the timeout and single-flight instead. */
  ttlMs?: number;
  now?: () => number;
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

  info(): Promise<AppsServingInfo> {
    if (this.deps.socketPath === null && this.cached) return Promise.resolve(this.cached);
    const now = this.deps.now ?? Date.now;
    const ttl = this.deps.ttlMs ?? 10_000;
    const fresh = this.cached !== null && now() - this.cachedAt < ttl;
    if (this.cached !== null && this.cached.reachable && fresh) return Promise.resolve(this.cached);
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
      .catch(() => undefined) // fetchStatus never rejects; this just keeps inFlight from wedging
      .finally(() => {
        this.inFlight = null;
      });
    return attempt;
  }
}

/** serving: the host answered and has the slug mounted; otherwise the reason says why. */
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
