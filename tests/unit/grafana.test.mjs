// CYBERMOLE_GRAFANA_URL (readGrafanaUrl, in a fresh process since RAW_ENV is
// read at load), the Explore deep link, and the compose wiring. The URL shape
// is Explore's v1: ?schemaVersion=1&panes=<JSON> with the Loki uid.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { parse } from 'yaml';

const root = path.join(import.meta.dirname, '..', '..');
const compose = parse(readFileSync(path.join(root, 'compose.yaml'), 'utf8'));

/** In a fresh process: the value or its error. */
function bootRead(env) {
  const clean = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => k !== 'CYBERMOLE_GRAFANA_URL'),
  );
  try {
    const out = execFileSync(
      process.execPath,
      [
        '-e',
        "process.stdout.write(JSON.stringify(require('./dist-server/src/lib/platform/env.js').readGrafanaUrl()))",
      ],
      { env: { ...clean, ...env }, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return { url: JSON.parse(out.toString()) };
  } catch (err) {
    return { error: err.stderr.toString() };
  }
}

test('the CYBERMOLE_GRAFANA_URL env contract is declared in the shared schema', async () => {
  const { envSchema } = await import('../../dist-server/src/lib/platform/env-schema.js');
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
    await import('../../dist-server/src/lib/platform/grafana.js');
  const url = new URL(grafanaExploreUrl('http://127.0.0.1:3300'));
  assert.equal(url.pathname, '/explore');
  assert.equal(url.searchParams.get('schemaVersion'), '1');
  // schemaVersion first, as Grafana orders it
  assert.match(url.search.slice(1), /^schemaVersion=1&/);
  const panes = JSON.parse(url.searchParams.get('panes'));
  const [paneId, pane] = Object.entries(panes)[0];
  // Pane ids must be 3 chars with a letter, or Explore regenerates one.
  assert.match(paneId, /^[A-Za-z0-9_-]{3}$/);
  assert.ok(/[a-z]/i.test(paneId), 'pane id carries a letter');
  assert.equal(pane.datasource, LOKI_DATASOURCE_UID);
  assert.equal(LOKI_DATASOURCE_UID, 'cybermole-loki'); // deploy/grafana provisioning uid
  // No queries: Explore seeds a default for the pane's datasource.
  assert.deepEqual(pane.queries, []);
  assert.deepEqual(pane.range, { from: 'now-1h', to: 'now' });
});

test('grafanaExploreUrl: a subpath base keeps its prefix (appended, not resolved)', async () => {
  const { grafanaExploreUrl } = await import('../../dist-server/src/lib/platform/grafana.js');
  const url = new URL(grafanaExploreUrl('https://host/grafana'));
  assert.equal(url.pathname, '/grafana/explore');
  // A root base must not double-slash.
  assert.equal(new URL(grafanaExploreUrl('http://h:1/')).pathname, '/explore');
});

test('compose: the logs link is default-off; grafana allows the frame', () => {
  // Default empty: grafana only runs under the opt-in profile, so a default
  // URL would iframe a dead port.
  assert.equal(
    compose.services.cybermole.environment.CYBERMOLE_GRAFANA_URL,
    '${CYBERMOLE_GRAFANA_URL:-}',
  );
  // Without this grafana answers X-Frame-Options: deny and the iframe stays blank.
  assert.equal(compose.services.grafana.environment.GF_SECURITY_ALLOW_EMBEDDING, 'true');
});

// ---------- the provisioned job-run alert ----------

const alerting = parse(
  readFileSync(
    path.join(root, 'deploy', 'grafana', 'provisioning', 'alerting', 'jobs.yaml'),
    'utf8',
  ),
);
const group = alerting.groups[0];
const rule = group.rules[0];
const query = rule.data.find(d => d.refId === 'A');
const threshold = rule.data.find(d => d.refId === 'B');

/** The repo-wide job label the logger pushes (env-overridable; the rule's
 *  annotation says to adjust the selector when it is). */
const DEFAULT_LOKI_JOB = 'cybermole';

test('alert provisioning: one group, one rule, in its own folder, in the alerting tree', () => {
  assert.equal(alerting.apiVersion, 1);
  assert.equal(group.orgId, 1);
  assert.match(group.name, /jobs/);
  assert.equal(group.folder, 'cybermole');
  assert.equal(group.interval, '1m');
  assert.equal(group.rules.length, 1);
  assert.match(rule.uid, /^[a-zA-Z0-9_-]{1,40}$/, 'uid: Grafana caps at 40 of [A-Za-z0-9_-]');
  assert.ok(rule.title.length > 0);
});

test('alert provisioning: fires on any non-zero finish, states its reasoning', () => {
  assert.equal(rule.condition, threshold.refId, 'the threshold node is the condition');
  assert.equal(rule.for, '0s', 'a single failed run alerts on its first evaluation');
  // No finish lines in the window is the healthy case, not NoData.
  assert.equal(rule.noDataState, 'OK');
  assert.equal(rule.execErrState, 'Error');
  assert.ok(rule.annotations.summary);
  assert.match(rule.annotations.description, /10 minutes/);
  assert.match(rule.annotations.description, /unknown/, 'the unknown-exit exclusion is stated');
  assert.equal(rule.labels.topic, 'jobs');
});

test("alert provisioning: the query rides the finish line's fields, not new labels", () => {
  assert.equal(query.datasourceUid, 'cybermole-loki', 'the provisioned datasource uid');
  assert.equal(query.model.queryType, 'instant');
  assert.ok(
    query.model.expr.includes(`{job="${DEFAULT_LOKI_JOB}", component="scheduler"}`),
    'selects the scheduler component of the default job label',
  );
  assert.ok(query.model.expr.includes('|= "run finished"'), 'line filter on the finish line');
  assert.ok(query.model.expr.includes('| json'), 'fields parsed at query time');
  // The filters read winston-loki's structured-metadata copy (the
  // line-parsed one is renamed _extracted on collision): not success, not
  // unknown (null stringifies to "null"), present.
  assert.ok(query.model.expr.includes('exitCode != `0`'));
  assert.ok(query.model.expr.includes('exitCode != `null`'));
  assert.ok(query.model.expr.includes('exitCode != ``'));
  assert.ok(
    query.model.expr.includes('count_over_time(') && query.model.expr.includes('[10m]'),
    'a windowed count',
  );
  assert.ok(query.model.expr.includes('sum by (jobName)'), 'one alert instance per job');
  assert.ok(
    threshold.model.type === 'threshold' &&
      threshold.model.expression === query.refId &&
      threshold.model.conditions[0].evaluator.type === 'gt' &&
      threshold.model.conditions[0].evaluator.params[0] === 0,
    'threshold: any count above zero',
  );
  assert.equal(threshold.datasourceUid, '__expr__');
});

test('compose: the job webhook env default is interpolatable and default-off', () => {
  assert.equal(
    compose.services.cybermole.environment.CYBERMOLE_JOB_WEBHOOK_URL,
    '${CYBERMOLE_JOB_WEBHOOK_URL:-}',
  );
});
