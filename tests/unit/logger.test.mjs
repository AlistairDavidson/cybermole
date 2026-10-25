// logger.test.mjs — the winston logging module (src/lib/logger.ts):
// transport selection with and without CYBERMOLE_LOKI_URL, the loki
// transport's labels/levels, console visibility of the levels, and — in a
// child process against a dead URL — the hard requirement that a down
// loki never takes the server down (no unhandled rejections, no retry
// spam, exactly one throttled warn). Run against the compiled output:
// `npm run test:unit`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// No CYBERMOLE_LOKI_* in this process: the module-level `logger` is the
// console-only shape (the fresh-process env reads below cover the
// configured shape through createLogger).
delete process.env.CYBERMOLE_LOKI_URL;
delete process.env.CYBERMOLE_LOKI_JOB;

const { createLogger, logger, CONSOLE_LEVEL, LOKI_LEVEL, closeLogger } =
  await import('../../dist-server/src/lib/logger.js');

const transportOf = (log, i) => log.transports[i];
const names = log => log.transports.map(t => t.constructor?.name);

test('without loki env: exactly one transport, the console', () => {
  const log = createLogger(null);
  assert.deepEqual(names(log), ['Console']);
  assert.equal(transportOf(log, 0).level, CONSOLE_LEVEL);
  closeLogger(log);
});

test('with loki env: console + winston-loki, batched JSON push, static job label', () => {
  const log = createLogger({ url: 'http://loki:3100', job: 'cybermole-test' });
  const [consoleT, lokiT] = log.transports;
  assert.equal(consoleT.constructor.name, 'Console');
  assert.equal(lokiT.constructor.name, 'LokiTransport');
  assert.equal(lokiT.level, LOKI_LEVEL, 'loki sees everything the root logger passes it');
  assert.deepEqual(
    lokiT.labels,
    { job: 'cybermole-test' },
    'only the static label; level/component join per line',
  );
  assert.equal(
    lokiT.batcher.options.batching,
    true,
    'batched: a dead loki is one failed request per interval',
  );
  assert.equal(
    lokiT.batcher.options.clearOnError,
    true,
    'a failed batch is dropped — bounded memory',
  );
  assert.equal(lokiT.batcher.options.gracefulShutdown, false, 'the server owns the SIGTERM path');
  assert.equal(lokiT.batcher.url.toString(), 'http://loki:3100/loki/api/v1/push');
  closeLogger(log);
});

test('the module-level logger is the console-only shape on a plain host', () => {
  assert.deepEqual(names(logger), ['Console']);
});

// Console VISIBILITY is asserted in a child process: capturing this
// process's stdout would mean patching process.stdout.write, which breaks
// node:test's own child protocol (tests completing before the patch
// silently vanish from the run — verified with a minimal repro). The
// child's own captured output is the honest place to look.
const VISIBILITY_CHILD = `
const { createLogger, closeLogger } = require(process.cwd() + '/dist-server/src/lib/logger.js');
const log = createLogger(null);
const http = log.child({ labels: { component: 'http' } });
http.http('GET /api/jobs 200 in 12ms', { ms: 12 });
http.debug('GET /api/state 200 in 8ms');
log.error('boom', { error: new Error('kaboom') });
closeLogger().then(() => process.exit(0));
`;

test(
  'console output: http access lines show, debug polls stay silent, errors carry their stack',
  { timeout: 15_000 },
  async () => {
    const { stdout, stderr } = await new Promise((resolve, reject) => {
      const script = path.join(
        fs.mkdtempSync(path.join(os.tmpdir(), 'cybermole-logger-')),
        'vis.js',
      );
      fs.writeFileSync(script, VISIBILITY_CHILD);
      execFile(process.execPath, [script], { env: { ...process.env } }, (err, stdout, stderr) =>
        err ? reject(err) : resolve({ stdout, stderr }),
      );
    });
    const out = `${stdout}${stderr}`;
    assert.match(
      out,
      /http +\[http\] GET \/api\/jobs 200 in 12ms \{"ms":12\}/,
      'access lines show with component + meta',
    );
    assert.ok(!out.includes('/api/state'), 'the debug poll line does not reach the console');
    assert.match(
      out,
      /error +\[server\] boom \{"error":"Error: kaboom/,
      'error meta is the stack, not {}',
    );
  },
);

// ---------- a configured-but-down loki (child process) ----------
//
// The requirement is behavioural, not just structural: with
// CYBERMOLE_LOKI_URL pointing at a closed port the process must stay alive
// and quiet. The child logs, waits past the first failed push (the 5s
// batch interval), logs again, and exits 0 — any unhandledRejection or
// uncaughtException fails it. Port 1 on loopback: connection refused
// instantly, nothing listens there.

const DOWN_CHILD = `
const { componentLogger } = require(process.cwd() + '/dist-server/src/lib/logger.js');
process.on('unhandledRejection', (e) => { console.error('CHILD-FAIL-UNHANDLED', e); process.exit(2); });
process.on('uncaughtException', (e) => { console.error('CHILD-FAIL-UNCAUGHT', e); process.exit(3); });
const log = componentLogger('boot');
log.info('line 1');                       // in the batch of the first failed push
setTimeout(() => {
  log.warn('line 2');                     // after the failure — dropped by clearOnError, not thrown on
  setTimeout(() => process.exit(0), 1500);
}, 6200);                                 // past the 5s interval: one push has failed by now
`;

test(
  'a configured-but-down loki degrades silently: alive, no crash, one throttled warn',
  { timeout: 20_000 },
  async () => {
    const script = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'cybermole-logger-')),
      'down.js',
    );
    fs.writeFileSync(script, DOWN_CHILD);
    const { stdout, stderr } = await new Promise((resolve, reject) => {
      execFile(
        process.execPath,
        [script],
        { env: { ...process.env, CYBERMOLE_LOKI_URL: 'http://127.0.0.1:1' } },
        (err, stdout, stderr) =>
          err ? reject({ err, stdout, stderr }) : resolve({ stdout, stderr }),
      );
    });
    const out = `${stdout}${stderr}`;
    assert.ok(!out.includes('CHILD-FAIL'), `child was taken down by loki being down: ${out}`);
    assert.match(out, /line 1/, 'console logging keeps working while loki is down');
    assert.match(out, /loki: push failed/, 'the outage is reported (once, throttled)');
    const warns = out.split('\n').filter(l => l.includes('loki: push failed'));
    assert.equal(warns.length, 1, `exactly one warn while down (got ${warns.length})`);
  },
);

// ---------- the configured loki transport actually pushes (child) ----------
//
// A tiny HTTP server stands in for loki's /loki/api/v1/push and captures
// the POST body: proves the label scheme (job static, level, component)
// and structured JSON lines arrive end-to-end, and that closeLogger()
// flushes the last batch.

const PUSH_CHILD = `
const { componentLogger, closeLogger } = require(process.cwd() + '/dist-server/src/lib/logger.js');
const http = componentLogger('http');
http.info('hello from cybermole', { status: 200, ms: 7 });
const boot = componentLogger('boot');
boot.debug('quiet on the console');
closeLogger();  // flush: the batch leaves without waiting out the interval
`;

test(
  'the loki transport pushes structured JSON with the label scheme',
  { timeout: 15_000 },
  async () => {
    const pushes = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => {
        body += c;
      });
      req.on('end', () => {
        pushes.push({ url: req.url, body });
        res.writeHead(204).end();
      });
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    try {
      const script = path.join(
        fs.mkdtempSync(path.join(os.tmpdir(), 'cybermole-logger-')),
        'push.js',
      );
      fs.writeFileSync(script, PUSH_CHILD);
      const { stdout, stderr } = await new Promise((resolve, reject) => {
        execFile(
          process.execPath,
          [script],
          {
            env: {
              ...process.env,
              CYBERMOLE_LOKI_URL: `http://127.0.0.1:${port}`,
              CYBERMOLE_LOKI_JOB: 'cybermole-test',
            },
          },
          (err, stdout, stderr) => (err ? reject(err) : resolve({ stdout, stderr })),
        );
      });
      assert.equal(pushes.length, 1, `one batched push (got ${pushes.length})`);
      const { url, body } = pushes[0];
      assert.equal(url, '/loki/api/v1/push');
      const batch = JSON.parse(body);
      const byLabel = component => batch.streams.find(s => s.stream.component === component);
      const httpStream = byLabel('http');
      assert.ok(httpStream, `an http stream exists: ${body}`);
      assert.equal(httpStream.stream.job, 'cybermole-test');
      assert.equal(httpStream.stream.level, 'info');
      const [ts, line] = httpStream.values[0];
      assert.ok(Number(ts) > 0, 'entry carries a timestamp');
      const parsed = JSON.parse(line.slice(line.indexOf('{')));
      assert.equal(parsed.status, 200);
      assert.equal(parsed.ms, 7);
      assert.match(line, /hello from cybermole/);
      const bootStream = byLabel('boot');
      assert.ok(bootStream, 'one stream per label set — component is a stream label');
      assert.equal(bootStream.stream.level, 'debug', 'debug lines reach loki');
      assert.match(bootStream.values[0][1], /quiet on the console/);
      assert.ok(!`${stdout}${stderr}`.includes('quiet on the console'), '...but not the console');
    } finally {
      server.close();
    }
  },
);
