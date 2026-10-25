// Static checks of the compose observability stack (no docker here): parses
// compose.yaml, the loki config and the grafana provisioning, and asserts
// what the logger and README rely on.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { parse } from 'yaml';

const root = path.join(import.meta.dirname, '..', '..');
const compose = parse(readFileSync(path.join(root, 'compose.yaml'), 'utf8'));
const loki = parse(readFileSync(path.join(root, 'deploy', 'loki', 'config.yaml'), 'utf8'));
const dsFile = readFileSync(
  path.join(root, 'deploy', 'grafana', 'provisioning', 'datasources', 'loki.yaml'),
  'utf8',
);
const datasource = parse(dsFile);

const hours = spec => {
  const m = /^(\d+)h$/.exec(String(spec));
  assert.ok(m, `${spec} is not an <n>h duration`);
  return Number(m[1]);
};

test('loki, loki-init and grafana are opt-in behind the observability profile', () => {
  for (const name of ['loki', 'loki-init', 'grafana']) {
    const svc = compose.services[name];
    assert.ok(svc, `${name} service exists`);
    assert.deepEqual(svc.profiles, ['observability'], `${name} is profile-gated`);
  }
  // profile-gated services don't start on a plain up
  for (const name of ['cybermole', 'workspace', 'seaweedfs']) {
    assert.equal(compose.services[name].profiles, undefined, `${name} starts on plain up`);
  }
  assert.deepEqual(compose.services.dev.profiles, ['dev']);
});

test('loki publishes no port and is reached over the compose network', () => {
  assert.equal(compose.services.loki.ports, undefined);
  // an empty default push URL means console-only logging on a plain up
  assert.equal(
    compose.services.cybermole.environment.CYBERMOLE_LOKI_URL,
    '${CYBERMOLE_LOKI_URL:-}',
  );
});

test('loki image is a pinned 3.x and the config is mounted read-only', () => {
  assert.match(compose.services.loki.image, /^grafana\/loki:3\.\d+\.\d+$/);
  const mounts = compose.services.loki.volumes;
  assert.ok(mounts.some(v => v === './deploy/loki/config.yaml:/etc/loki/config.yaml:ro'));
  assert.ok(mounts.some(v => v.startsWith('cybermole-loki:')));
});

test('the loki volume follows the explicit-naming pattern; loki-init owns it', () => {
  assert.equal(compose.volumes['cybermole-loki'].name, 'cybermole-loki');
  const init = compose.services['loki-init'];
  assert.equal(init.user, '0:0');
  assert.match(init.entrypoint.join(' '), /chown -R 10001:10001 \/loki/);
  assert.deepEqual(init.volumes, ['cybermole-loki:/loki']);
  assert.equal(
    compose.services.loki.depends_on['loki-init'].condition,
    'service_completed_successfully',
  );
});

test("grafana is loopback-published on a port that is not cybermole or dev's", () => {
  const ports = compose.services.grafana.ports;
  assert.deepEqual(ports, ['127.0.0.1:3300:3000']);
  const host = Number(ports[0].split(':')[1]);
  assert.ok(![3000, 3001, 4321].includes(host), `${host} collides with cybermole/dev`);
});

test('grafana datasource provisioning points at the stack loki', () => {
  const ds = datasource.datasources[0];
  assert.equal(ds.type, 'loki');
  assert.equal(ds.url, 'http://loki:3100');
  assert.equal(ds.isDefault, true);
});

test('loki config: single binary, filesystem storage, tsdb v13 schema', () => {
  assert.equal(loki.auth_enabled, false);
  assert.equal(loki.common.replication_factor, 1);
  assert.equal(loki.common.ring.kvstore.store, 'inmemory');
  const schema = loki.schema_config.configs.at(-1);
  assert.equal(schema.store, 'tsdb');
  assert.equal(schema.object_store, 'filesystem');
  assert.equal(schema.schema, 'v13');
  const fs = loki.common.storage.filesystem;
  assert.ok(fs.chunks_directory.startsWith('/loki/'));
  assert.ok(fs.rules_directory.startsWith('/loki/'));
});

test('loki config: retention is compactor-driven and a multiple of 24h', () => {
  const { compactor, limits_config } = loki;
  assert.equal(compactor.retention_enabled, true);
  assert.equal(compactor.delete_request_store, 'filesystem');
  assert.ok(compactor.working_directory.startsWith('/loki/'));
  assert.equal(hours(limits_config.retention_period) % 24, 0);
});

test('loki config: oversized/old entries and labels are rejected, not stored', () => {
  const l = loki.limits_config;
  assert.equal(l.reject_old_samples, true);
  assert.ok(hours(l.reject_old_samples_max_age) > 0);
  assert.ok(l.max_line_size > 0 && l.max_line_size <= 256 * 1024);
  assert.ok(l.max_label_name_length > 0);
  assert.ok(l.max_label_value_length > 0);
  assert.ok(l.max_label_names_per_series > 0);
  assert.ok(l.ingestion_rate_mb > 0);
});

test('loki config: upstream telemetry is off', () => {
  assert.equal(loki.analytics.reporting_enabled, false);
});

test('resource limits are set and modest on the observability services', () => {
  for (const name of ['loki', 'grafana']) {
    const limits = compose.services[name].deploy.resources.limits;
    assert.match(limits.memory, /^(\d+)m$/);
    assert.ok(Number(limits.memory.slice(0, -1)) <= 768, `${name} memory is modest`);
    assert.ok(Number(limits.cpus) <= 1);
  }
});

// The env contract the compose wiring meets.
const { envSchema } = await import('../../dist-server/src/lib/platform/env-schema.js');

/** In a fresh process (RAW_ENV is read at load): the config or its error. */
function bootConfig(env) {
  const clean = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith('CYBERMOLE_LOKI_')),
  );
  try {
    const out = execFileSync(
      process.execPath,
      [
        '-e',
        "process.stdout.write(JSON.stringify(require('./dist-server/src/lib/platform/env.js').readLokiConfig()))",
      ],
      { env: { ...clean, ...env }, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return { config: JSON.parse(out.toString()) };
  } catch (err) {
    return { error: err.stderr.toString() };
  }
}

test('the CYBERMOLE_LOKI_* env contract is declared in the shared schema', () => {
  assert.deepEqual(envSchema.CYBERMOLE_LOKI_URL, {
    type: 'string',
    context: 'server',
    access: 'secret',
    optional: true,
  });
  assert.deepEqual(envSchema.CYBERMOLE_LOKI_JOB, {
    type: 'string',
    context: 'server',
    access: 'secret',
    optional: true,
  });
});

test('readLokiConfig: unset/empty is null; url+job configure the transport', () => {
  assert.deepEqual(bootConfig({}), { config: null });
  assert.deepEqual(
    bootConfig({ CYBERMOLE_LOKI_URL: '' }),
    { config: null },
    'empty counts as unset (compose VAR: "")',
  );
  assert.deepEqual(bootConfig({ CYBERMOLE_LOKI_URL: 'http://loki:3100' }), {
    config: { url: 'http://loki:3100', job: 'cybermole' },
  });
  assert.deepEqual(
    bootConfig({ CYBERMOLE_LOKI_URL: 'http://loki:3100/', CYBERMOLE_LOKI_JOB: 'cybermole-box' }),
    { config: { url: 'http://loki:3100', job: 'cybermole-box' } },
    'trailing slash normalised, job label override',
  );
});

test('readLokiConfig: malformed values stop the boot', () => {
  assert.match(bootConfig({ CYBERMOLE_LOKI_JOB: 'cybermole' }).error, /without CYBERMOLE_LOKI_URL/);
  assert.match(bootConfig({ CYBERMOLE_LOKI_URL: 'ftp://x' }).error, /is not an http\(s\) URL/);
  assert.match(bootConfig({ CYBERMOLE_LOKI_URL: 'not a url' }).error, /is not an http\(s\) URL/);
  assert.match(
    bootConfig({ CYBERMOLE_LOKI_URL: 'http://loki:3100', CYBERMOLE_LOKI_JOB: 'my box' }).error,
    /is not a valid job label/,
  );
});
