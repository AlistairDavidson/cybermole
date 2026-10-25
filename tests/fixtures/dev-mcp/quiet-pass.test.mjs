// A passing file with one skip. Under fixtures/ so the unit glob skips it.
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
