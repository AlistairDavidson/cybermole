// One pass and one failure with a distinctive message, so the smoke test can
// check the failure entry carries the real error text.
import test from 'node:test';
import assert from 'node:assert/strict';

test('fine', () => {
  assert.ok(true);
});

test('the broken one', () => {
  assert.equal('actual', 'expected', 'the quiet reporter must carry this message');
});
