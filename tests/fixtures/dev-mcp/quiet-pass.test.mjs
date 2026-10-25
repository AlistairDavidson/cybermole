// quiet-pass.test.mjs — a quiet-reporter smoke fixture (tests/unit/
// dev-mcp.test.mjs spawns the runner on it): a passing file, one skip.
// Lives under fixtures/ so the unit glob never picks it up.
import test from 'node:test';
import assert from 'node:assert/strict';

test('two and two', () => {
  assert.equal(2 + 2, 4);
});

test('strings join', () => {
  assert.equal(['a', 'b'].join('-'), 'a-b');
});

test('skipped on purpose', { skip: true }, () => {
  assert.fail('never runs');
});
