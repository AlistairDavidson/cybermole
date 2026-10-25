// The /logs page's Grafana Explore deep link. Grafana ships with only the
// Loki datasource provisioned, so Explore with it preselected is the log UI.
// Uses Explore's v1 URL format (`schemaVersion=1&panes=<JSON>`; the legacy
// ?left= form is deprecated). A pane with no queries gets the datasource's
// default query. schemaVersion goes first, as Grafana does, so a truncated
// URL still carries it.
import { readGrafanaUrl } from './env';

/** The provisioned datasource uid, pinned rather than relying on Grafana's default. */
export const LOKI_DATASOURCE_UID = 'cybermole-loki';

/** One pane on Loki, last hour (Grafana's default is 6h). */
const PANES = JSON.stringify({
  lok: {
    datasource: LOKI_DATASOURCE_UID,
    queries: [],
    range: { from: 'now-1h', to: 'now' },
  },
});

/** The path is appended, not resolved, so a subpath-mounted Grafana keeps its prefix. */
export function grafanaExploreUrl(baseUrl: string): string {
  const u = new URL(`${baseUrl.replace(/\/+$/, '')}/explore`);
  u.searchParams.set('schemaVersion', '1');
  u.searchParams.set('panes', PANES);
  return u.href;
}

/** null when CYBERMOLE_GRAFANA_URL is unset. */
export function grafanaExploreUrlFromEnv(): string | null {
  const base = readGrafanaUrl();
  return base === null ? null : grafanaExploreUrl(base);
}
