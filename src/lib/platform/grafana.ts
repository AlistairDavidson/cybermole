// grafana.ts — the /logs page's Explore deep link (task/logs-page). The
// compose `observability` profile runs Grafana with ONLY a datasource
// provisioned (deploy/grafana/provisioning/datasources/loki.yaml — uid
// cybermole-loki, isDefault) and no dashboards, so the log UI the page
// embeds is Explore, Grafana's query surface, with that datasource
// preselected: a working log-query page without provisioning a dashboard.
// Pure URL construction (no state, no Node imports) — pinned against the
// grafana/grafana 13.2.3 the compose file pins, from its sources:
//   - Explore parses `?panes=<urlencoded JSON>&schemaVersion=1`
//     (public/app/features/explore/hooks/useStateSync/parseURL.ts +
//     migrators/v1.ts). schemaVersion 1 is the latest; a URL without it
//     is treated as the LEGACY ?left={"datasource":…} v0 format and run
//     through a migrator — still honored in 13.2.3, but deprecated
//     shapes get removed without notice, so the page speaks v1 natively.
//   - A pane is {datasource: <uid>, queries, range}; a pane with NO
//     queries gets a default query for the pane datasource on load
//     (synchronizer/init.ts) — exactly the "Loki preselected, empty
//     query editor" state wanted here.
//   - Pane ids must be 3 chars with a letter (else regenerated —
//     harmless, but "lok" is valid as-is).
//   - Grafana itself puts schemaVersion FIRST in the query string so a
//     truncated URL still carries it (init.ts) — mirrored below.
import { readGrafanaUrl } from './env';

/** The provisioned Loki datasource (deploy/grafana/provisioning/
 *  datasources/loki.yaml uid) — the one datasource this stack ships, so
 *  the page pins it instead of relying on Grafana's default-datasource
 *  fallback. */
export const LOKI_DATASOURCE_UID = 'cybermole-loki';

/** The `panes` payload: one Explore pane on the Loki datasource, no
 *  queries (Explore seeds the default Loki query), the range a log page
 *  wants (recent hour; Grafana's own default is 6h). */
const PANES = JSON.stringify({
  lok: {
    datasource: LOKI_DATASOURCE_UID,
    queries: [],
    range: { from: 'now-1h', to: 'now' },
  },
});

/** The Explore URL the /logs iframe loads: `${base}/explore` with the v1
 *  panes payload. `base` is CYBERMOLE_GRAFANA_URL as readGrafanaUrl
 *  normalized it (http(s), no trailing slash, optionally a subpath —
 *  appended, not resolved, so a Grafana mounted at /grafana keeps its
 *  prefix). searchParams encodes the JSON — the one encoding rule the
 *  format has. */
export function grafanaExploreUrl(baseUrl: string): string {
  const u = new URL(`${baseUrl.replace(/\/+$/, '')}/explore`);
  u.searchParams.set('schemaVersion', '1');
  u.searchParams.set('panes', PANES);
  return u.href;
}

/** The configured base + the built Explore URL, or null when
 *  CYBERMOLE_GRAFANA_URL is unset — the /logs page 404s and the header
 *  link hides (the editor-off pattern; readGrafanaUrl validates).
 *  server/main.ts folds this into cfg.grafanaExploreUrl so no
 *  Astro-bundled code needs this module (CODE_STYLE §6). */
export function grafanaExploreUrlFromEnv(): string | null {
  const base = readGrafanaUrl();
  return base === null ? null : grafanaExploreUrl(base);
}
