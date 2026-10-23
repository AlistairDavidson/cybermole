// grafana.test.mjs — task/logs-page: the CYBERMOLE_GRAFANA_URL env
// contract (readGrafanaUrl, src/lib/env.ts) and the Explore deep link it
// feeds (grafanaExploreUrl, src/lib/grafana.ts), plus the compose wiring
// that delivers the var. readGrafanaUrl runs in a FRESH process (RAW_ENV
// is read at module load — same pattern as the CYBERMOLE_LOKI_* boot
// checks in observability.test.mjs); grafanaExploreUrl is pure, imported
// directly. The Explore URL shape is pinned against grafana/grafana
// 13.2.3 (the image compose.yaml pins): ?panes=<JSON>&schemaVersion=1
// with the pane's datasource = the provisioned Loki uid.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { parse } from 'yaml';

const root = path.join(import.meta.dirname, '..', '..');
const compose = parse(readFileSync(path.join(root, 'compose.yaml'), 'utf8'));

/** readGrafanaUrl() in a fresh process (RAW_ENV is read at module load),
 *  or its error. */
function bootRead(env) {
  const clean = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => k !== 'CYBERMOLE_GRAFANA_URL'),
  );
  try {
    const out = execFileSync(
      process.execPath,
      [
        '-e',
        "process.stdout.write(JSON.stringify(require('./dist-server/src/lib/env.js').readGrafanaUrl()))",
      ],
      { env: { ...clean, ...env }, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return { url: JSON.parse(out.toString()) };
  } catch (err) {
    return { error: err.stderr.toString() };
  }
}

test('the CYBERMOLE_GRAFANA_URL env contract is declared in the shared schema', async () => {
  const { envSchema } = await import('../../dist-server/src/lib/env-schema.js');
  assert.deepEqual(envSchema.CYBERMOLE_GRAFANA_URL, {
    type: 'string',
    context: 'server',
    access: 'secret',
    optional: true,
  });
});

test('readGrafanaUrl: unset/empty is null (feature off); trailing slashes normalise; a subpath survives', () => {
  assert.deepEqual(bootRead({}), { url: null });
  assert.deepEqual(
    bootRead({ CYBERMOLE_GRAFANA_URL: '' }),
    {
      url: null,
    },
    'empty counts as unset (compose VAR: "")',
  );
  assert.deepEqual(bootRead({ CYBERMOLE_GRAFANA_URL: 'http://127.0.0.1:3300' }), {
    url: 'http://127.0.0.1:3300',
  });
  assert.deepEqual(
    bootRead({ CYBERMOLE_GRAFANA_URL: 'http://127.0.0.1:3300/' }),
    { url: 'http://127.0.0.1:3300' },
    'trailing slash dropped (the page appends /explore)',
  );
  assert.deepEqual(
    bootRead({ CYBERMOLE_GRAFANA_URL: 'https://host/grafana///' }),
    {
      url: 'https://host/grafana',
    },
    'a reverse-proxied subpath is kept — the browser loads the URL, unlike the editor proxy',
  );
});

test('readGrafanaUrl: malformed values stop the boot', () => {
  assert.match(bootRead({ CYBERMOLE_GRAFANA_URL: 'ftp://x' }).error, /is not an http\(s\) URL/);
  assert.match(bootRead({ CYBERMOLE_GRAFANA_URL: 'not a url' }).error, /is not an http\(s\) URL/);
  assert.match(
    bootRead({ CYBERMOLE_GRAFANA_URL: 'http://127.0.0.1:3300/?x=1' }).error,
    /must not carry a query or fragment/,
  );
  assert.match(
    bootRead({ CYBERMOLE_GRAFANA_URL: 'http://127.0.0.1:3300/#f' }).error,
    /must not carry a query or fragment/,
  );
});

test('grafanaExploreUrl: v1 panes payload preselecting the provisioned Loki datasource', async () => {
  const { grafanaExploreUrl, LOKI_DATASOURCE_UID } =
    await import('../../dist-server/src/lib/grafana.js');
  const url = new URL(grafanaExploreUrl('http://127.0.0.1:3300'));
  assert.equal(url.pathname, '/explore');
  assert.equal(url.searchParams.get('schemaVersion'), '1');
  // schemaVersion first (Grafana's own truncation ordering — init.ts).
  assert.match(url.search.slice(1), /^schemaVersion=1&/);
  const panes = JSON.parse(url.searchParams.get('panes'));
  const [paneId, pane] = Object.entries(panes)[0];
  // Pane ids must be 3 chars with a letter, or Explore regenerates one.
  assert.match(paneId, /^[A-Za-z0-9_-]{3}$/);
  assert.ok(/[a-z]/i.test(paneId), 'pane id carries a letter');
  assert.equal(pane.datasource, LOKI_DATASOURCE_UID);
  assert.equal(LOKI_DATASOURCE_UID, 'cybermole-loki'); // deploy/grafana provisioning uid
  // No queries: Explore seeds a default query for the pane datasource
  // (synchronizer/init.ts in 13.2.3) — the "Loki preselected" state.
  assert.deepEqual(pane.queries, []);
  assert.deepEqual(pane.range, { from: 'now-1h', to: 'now' });
});

test('grafanaExploreUrl: a subpath base keeps its prefix (appended, not resolved)', async () => {
  const { grafanaExploreUrl } = await import('../../dist-server/src/lib/grafana.js');
  const url = new URL(grafanaExploreUrl('https://host/grafana'));
  assert.equal(url.pathname, '/grafana/explore');
  // A root base must not double-slash.
  assert.equal(new URL(grafanaExploreUrl('http://h:1/')).pathname, '/explore');
});

test('compose: the logs link is default-off; grafana allows the frame', () => {
  // Default-off: the interpolation default is EMPTY — grafana runs only
  // under the opt-in observability profile, so a default-on URL would
  // iframe a dead port for every plain-stack user.
  assert.equal(
    compose.services.cybermole.environment.CYBERMOLE_GRAFANA_URL,
    '${CYBERMOLE_GRAFANA_URL:-}',
  );
  // Without this grafana 13 answers X-Frame-Options: deny and the /logs
  // iframe stays blank.
  assert.equal(compose.services.grafana.environment.GF_SECURITY_ALLOW_EMBEDDING, 'true');
});
