// quiet-fail.test.mjs — the failing quiet-reporter smoke fixture: one
// passing test, one failing with a distinctive assertion message, so the
// smoke test can assert the failure entry carries the REAL error text (the
// whole reason the reporter is a programmatic runner and not a --test-reporter
// module, whose IPC strips Error messages).
import test from 'node:test';
import assert from 'node:assert/strict';

test('fine', () => {
  assert.ok(true);
});

test('the broken one', () => {
  assert.equal('actual', 'expected', 'the quiet reporter must carry this message');
});
