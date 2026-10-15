// jobs.test.mjs — pure scheduling math for the in-process scheduler
// (src/lib/jobs.ts): next-fire, due-ness, missed-window/catch-up, and
// cron validation. Everything here takes an injected "now" — no wall
// clock, no db, no tmux. Run against the compiled output:
// `npm run test:unit` (node --test).
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkCron, isDue, nextFireMs } from '../../dist-server/src/lib/jobs.js';

/** Local-time epoch ms (cron fields are interpreted in local time). */
const L = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi, 0, 0).getTime();
const MIN = 60_000;

/** nextFireMs's fire time, asserting success. */
const at = (schedule, afterMs) => {
  const r = nextFireMs(schedule, afterMs);
  assert.equal(r.ok, true, r.errorMessage);
  return r.data.at;
};

test('nextFireMs returns the next match strictly after the reference', () => {
  const t = L(2026, 10, 9, 10, 0); // exactly on a */5 boundary
  assert.equal(at('*/5 * * * *', t), L(2026, 10, 9, 10, 5));
  assert.equal(at('*/5 * * * *', t + 1), L(2026, 10, 9, 10, 5));
  assert.equal(at('*/5 * * * *', L(2026, 10, 9, 10, 2)), L(2026, 10, 9, 10, 5));
  // day-of-week: Mon..Fri at 09:30
  const mon = L(2026, 10, 5, 9, 30); // a Monday
  assert.equal(at('30 9 * * 1-5', mon), L(2026, 10, 6, 9, 30));
  const fri = L(2026, 10, 9, 9, 30); // a Friday
  assert.equal(at('30 9 * * 1-5', fri), L(2026, 10, 12, 9, 30)); // skips the weekend
  // month/day boundaries roll over
  assert.equal(at('0 8 1 * *', L(2026, 10, 31, 23, 59)), L(2026, 11, 1, 8, 0));
});

test('nextFireMs: invalid_schedule on invalid schedules, with an actionable message', () => {
  for (const bad of ['daily 08:00', '99 * * * *', '* * *', '']) {
    const r = nextFireMs(bad, L(2026, 10, 9, 10, 0));
    assert.equal(r.errorCode, 'invalid_schedule', bad);
    assert.ok(r.errorMessage && !r.errorMessage.includes('\n'), bad);
  }
  assert.match(nextFireMs('* * *', 0).errorMessage, /^schedule must be 5 cron fields/);
});

test('isDue: an invalid schedule is never due', () => {
  assert.equal(isDue('99 * * * *', 0, L(2030, 1, 1, 0, 0)), false);
});

test('isDue: not due before the next fire, due at/after it', () => {
  const ref = L(2026, 10, 9, 10, 0);
  assert.equal(isDue('* * * * *', ref, ref + 59_000), false);
  assert.equal(isDue('* * * * *', ref, ref + MIN), true);
  assert.equal(isDue('* * * * *', ref, ref + 5 * MIN), true);
  // a fire exactly at the reference is spent — never double-counted
  assert.equal(isDue('* * * * *', ref, ref), false);
});

test('isDue: a missed window while the server was down is due (catch-up)', () => {
  // daily at 10:00, last fired yesterday 10:00, now today 11:30 → missed
  const lastFire = L(2026, 10, 8, 10, 0);
  assert.equal(isDue('0 10 * * *', lastFire, L(2026, 10, 9, 9, 59)), false);
  assert.equal(isDue('0 10 * * *', lastFire, L(2026, 10, 9, 10, 0)), true);
  assert.equal(isDue('0 10 * * *', lastFire, L(2026, 10, 12, 18, 0)), true); // many missed → still one boolean
  // fired today already → next due is tomorrow
  const todayFire = L(2026, 10, 9, 10, 0);
  assert.equal(isDue('0 10 * * *', todayFire, L(2026, 10, 9, 23, 59)), false);
});

test('isDue: a never-fired job is referenced by its creation time', () => {
  // created 10:00:00 with an every-minute schedule → due at 10:01
  const created = L(2026, 10, 9, 10, 0);
  assert.equal(isDue('* * * * *', created, created + 30_000), false);
  assert.equal(isDue('* * * * *', created, created + MIN), true);
});

test('checkCron: 5-field cron accepted, other syntax rejected with an error', () => {
  const now = L(2026, 10, 9, 10, 2);
  const good = checkCron('*/5 * * * *', now);
  assert.equal(good.valid, true);
  assert.equal(good.validatedBy, 'cron-parser');
  assert.equal(good.next, '2026-10-09 10:05');
  assert.equal(good.error, null);

  for (const bad of ['daily 08:00', '99 * * * *', '*/5 * * *', '0 8 * * * *', '']) {
    const c = checkCron(bad, now);
    assert.equal(c.valid, false, bad);
    assert.equal(typeof c.error, 'string');
    assert.ok(c.error.length > 0, bad);
    assert.equal(c.next, null);
  }
});

// ---------- task/ws-jobs (plan §9): the run wrapper + file paths, pure ----------

const { runCommandArgv, runLogPaths } = await import('../../dist-server/src/lib/jobs.js');

test('runCommandArgv: the exact wrapper argv — command as $1, never string-embedded', () => {
  // The plan's pinned argv: an outer /bin/sh -c whose script tees the
  // inner command's output to $2 and captures its exit INSIDE the
  // pipeline (before tee) into $3. 'sh' is $0; the user command, log
  // path and exit path are $1/$2/$3 — argv elements, so any quoting, #,
  // braces or quotes in the command can't break the wrapper.
  const tricky = 'echo "hi there" # not a comment-start for the wrapper; } | pipe &';
  assert.deepEqual(runCommandArgv(tricky, '/logs/j/1.log', '/logs/j/1.exit'), [
    '/bin/sh',
    '-c',
    'mkdir -p "$(dirname "$2")"; { /bin/sh -c "$1" 2>&1; echo $? > "$3"; } | tee "$2"',
    'sh',
    tricky,
    '/logs/j/1.log',
    '/logs/j/1.exit',
  ]);
  // The user command rides as its OWN argv element — it is not inside
  // the script string, and the script mentions $1/$2/$3 only.
  const [sh, flag, script, argv0, command, log, exitFile] = runCommandArgv('true', 'L', 'E');
  assert.equal(sh, '/bin/sh');
  assert.equal(flag, '-c');
  assert.equal(argv0, 'sh');
  assert.equal(command, 'true');
  assert.equal(log, 'L');
  assert.equal(exitFile, 'E');
  assert.ok(!script.includes('true'));
  // Pure POSIX: no pipefail (dash rejects it), no shell-specific bits.
  assert.ok(!/pipefail/.test(script));
  // The exit code is captured before tee: $? is written inside the { }.
  assert.ok(script.includes('echo $? > "$3"'));
});

test('runLogPaths: <logDir>/<job>/<firedAt>.{log,exit} — the pair every side derives', () => {
  assert.deepEqual(runLogPaths('/workspace/.webpi/job-logs', 'nightly', 1730000000000), {
    log: '/workspace/.webpi/job-logs/nightly/1730000000000.log',
    exit: '/workspace/.webpi/job-logs/nightly/1730000000000.exit',
  });
});
