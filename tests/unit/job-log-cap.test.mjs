// The job log cap, with real child processes: the appender spawned as the
// wrapper spawns it (passthrough, the cap with one marker while stdin keeps
// draining, the exact boundary, fail-soft paths); the full wrapper argv
// through /bin/sh (a chatty capped run keeps its real exit code); and the
// env knob's default and boot validation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cybermole-log-cap-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

const APPENDER = fileURLToPath(
  new URL('../../dist-server/src/lib/jobs/job-log-appender.js', import.meta.url),
);
const { runCommandArgv } = await import('../../dist-server/src/lib/jobs/jobs.js');

/** Buffers the whole write, so small inputs only. stdout is returned: the
 *  passthrough is the pane's live view and must never be blanked. */
async function append(logPath, maxBytes, input) {
  const child = spawn(process.execPath, [APPENDER, logPath, String(maxBytes)], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stderr = [];
  const stdout = [];
  child.stderr.on('data', c => stderr.push(c));
  child.stdout.on('data', c => stdout.push(c));
  child.stdin.end(input);
  const [code] = await once(child, 'exit');
  return { code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString() };
}

// ---------- appender ----------

test('appender: under the cap, stdin lands in the file byte-for-byte (create, then append)', async () => {
  const log = path.join(dir, 'under.log');
  const first = await append(log, 1024, 'first\n');
  assert.equal(first.code, 0);
  assert.equal(first.stderr, '');
  // A second run appends; run log paths are unique, so 'a' only matters on reuse.
  const second = await append(log, 1024, 'second\n');
  assert.equal(second.code, 0);
  assert.equal(second.stdout.toString(), 'second\n', 'tee passthrough on every run');
  assert.equal(fs.readFileSync(log, 'utf8'), 'first\nsecond\n');
});

test(
  'appender: past the cap it stops writing (one marker) but keeps draining stdin',
  { timeout: 30_000 },
  async () => {
    const log = path.join(dir, 'cap.log');
    const cap = 4096;
    // 1 MiB with backpressure: a reader that stopped would surface as EPIPE
    // long before the end (the pipe holds ~64 KiB).
    const payload = Buffer.alloc(1024 * 1024, 0x61);
    const child = spawn(process.execPath, [APPENDER, log, String(cap)], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const errors = [];
    child.stdin.on('error', err => errors.push(err));
    const stderr = [];
    child.stderr.on('data', c => stderr.push(c));
    const stdout = [];
    child.stdout.on('data', c => stdout.push(c));
    let off = 0;
    while (off < payload.length) {
      const chunk = payload.subarray(off, off + 16 * 1024);
      off += chunk.length;
      if (!child.stdin.write(chunk)) await once(child.stdin, 'drain');
    }
    child.stdin.end();
    const [code] = await once(child, 'exit');

    assert.equal(code, 0, `stderr: ${Buffer.concat(stderr).toString()}`);
    assert.deepEqual(errors, [], 'the writer side never gets EPIPE — the job must run on');
    const marker = `[truncated at ${cap} bytes]\n`;
    const file = fs.readFileSync(log);
    assert.equal(file.length, cap + marker.length, 'exactly the cap, plus one marker line');
    assert.equal(file.subarray(0, cap).toString(), payload.subarray(0, cap).toString());
    assert.equal(file.subarray(cap).toString(), marker);
    assert.equal(file.toString().split('[truncated').length - 1, 1, 'the marker appears once');
    assert.equal(
      Buffer.concat(stdout).length,
      payload.length,
      'tee passthrough: stdout sees EVERYTHING even past the cap — the pane is never blanked',
    );
  },
);

test('appender: the boundary is exact — cap bytes fit whole (no marker), cap+1 truncates', async () => {
  const cap = 1000;
  const exact = path.join(dir, 'exact.log');
  await append(exact, cap, Buffer.alloc(cap, 0x62));
  assert.equal(fs.readFileSync(exact).length, cap, 'nothing was dropped, so no marker');

  const over = path.join(dir, 'over.log');
  await append(over, cap, Buffer.alloc(cap + 1, 0x63));
  const marker = `[truncated at ${cap} bytes]\n`;
  assert.equal(
    fs.readFileSync(over).toString(),
    Buffer.alloc(cap, 0x63).toString() + marker,
    'one dropped byte still marks the truncation point',
  );
});

test(
  'appender: bad arguments and an unopenable log fail loudly — without ever closing the pipe',
  { timeout: 30_000 },
  async () => {
    const badArg = await append(path.join(dir, 'unused.log'), 'nope', 'x');
    assert.equal(badArg.code, 2);
    assert.match(badArg.stderr, /usage: node job-log-appender/);

    // The log path is a directory: output is lost, but stdin still drains
    // to the end or the job would die of SIGPIPE.
    const notAFile = path.join(dir, 'is-a-dir');
    fs.mkdirSync(notAFile);
    const child = spawn(process.execPath, [APPENDER, notAFile, '1024'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const errors = [];
    child.stdin.on('error', err => errors.push(err));
    const stderr = [];
    child.stderr.on('data', c => stderr.push(c));
    // stdout must be consumed even with the log dead, or writeSync blocks
    // on the full pipe and this deadlocks.
    const stdout = [];
    child.stdout.on('data', c => stdout.push(c));
    let off = 0;
    const total = 256 * 1024;
    while (off < total) {
      const chunk = Buffer.alloc(16 * 1024, 0x64);
      off += chunk.length;
      if (!child.stdin.write(chunk)) await once(child.stdin, 'drain');
    }
    child.stdin.end();
    const [code] = await once(child, 'exit');
    assert.equal(code, 1);
    assert.match(Buffer.concat(stderr).toString(), /could not open/);
    assert.equal(
      Buffer.concat(stdout).length,
      total,
      'passthrough continues even with the log dead — the pane is never blanked',
    );
    assert.deepEqual(errors, [], 'even a failed open keeps draining — never EPIPE');
  },
);

// ---------- wrapper argv end to end ----------

test(
  'wrapper: a capped chatty run still records its REAL exit code — the appender never SIGPIPEs the job',
  { timeout: 30_000 },
  async () => {
    const log = path.join(dir, 'run-chatty.log');
    const exitFile = path.join(dir, 'run-chatty.exit');
    const cap = 8192;
    const argv = runCommandArgv('seq 1 100000', log, exitFile, cap);
    const child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'inherit', 'inherit'] });
    const [code] = await once(child, 'exit');

    // An early close would kill seq with SIGPIPE (141); 0 proves the drain.
    assert.equal(fs.readFileSync(exitFile, 'utf8'), '0\n');
    assert.equal(code, 0, "the wrapper's own exit (the appender's) is 0 too");
    const file = fs.readFileSync(log);
    assert.equal(file.length, cap + `[truncated at ${cap} bytes]\n`.length);
    assert.ok(file.toString().startsWith('1\n2\n3\n'));
    assert.ok(file.toString().endsWith(`[truncated at ${cap} bytes]\n`));
  },
);

test('wrapper: a short failing run passes through whole and records its exit code', async () => {
  const log = path.join(dir, 'run-short.log');
  const exitFile = path.join(dir, 'run-short.exit');
  const argv = runCommandArgv('echo out; echo err >&2; exit 42', log, exitFile, 20 * 1024 * 1024);
  const child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'inherit', 'inherit'] });
  await once(child, 'exit');

  assert.equal(fs.readFileSync(exitFile, 'utf8'), '42\n');
  // 2>&1 is inside the pipeline: stderr lands in the log.
  assert.equal(fs.readFileSync(log, 'utf8'), 'out\nerr\n');
});

// ---------- env knob ----------

const { envSchema } = await import('../../dist-server/src/lib/platform/env-schema.js');

/** In a fresh process (RAW_ENV is read at load): the ENV value or the boot error. */
function bootEnv(value) {
  const clean = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => k !== 'CYBERMOLE_JOB_LOG_MAX'),
  );
  try {
    const out = execFileSync(
      process.execPath,
      [
        '-e',
        "process.stdout.write(String(require('./dist-server/src/lib/platform/env.js').ENV.CYBERMOLE_JOB_LOG_MAX))",
      ],
      { env: value === undefined ? clean : { ...clean, CYBERMOLE_JOB_LOG_MAX: value } },
    );
    return { value: out.toString() };
  } catch (err) {
    return { error: err.stderr.toString() };
  }
}

test('CYBERMOLE_JOB_LOG_MAX: declared in the shared env schema with the 20 MiB default', () => {
  assert.deepEqual(envSchema.CYBERMOLE_JOB_LOG_MAX, {
    type: 'number',
    context: 'server',
    access: 'secret',
    default: 20971520,
  });
});

test('CYBERMOLE_JOB_LOG_MAX: default / integer override resolve; malformed stops the boot', () => {
  assert.equal(bootEnv(undefined).value, '20971520');
  assert.equal(bootEnv('1048576').value, '1048576');
  assert.equal(bootEnv('0').value, '0', 'zero is a valid (spartan) cap');
  assert.match(bootEnv('abc').error, /CYBERMOLE_JOB_LOG_MAX="abc" is not an integer/);
  assert.match(bootEnv('1.5').error, /is not an integer/);
  assert.match(bootEnv('-1').error, /must not be negative/);
});
