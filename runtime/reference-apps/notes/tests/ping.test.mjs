// One test per error code, not just the happy path. Plain node:test over
// type-stripped sources (see src/lib/ping.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import { pingResult } from '../src/lib/ping.ts';

test('ping: a name answers hello', () => {
  const r = pingResult('world');
  assert.equal(r.ok, true);
  if (!r.ok) return; // narrow for the type checker's sake
  assert.equal(r.data.hello, 'world');
  assert.equal(typeof r.data.at, 'number');
});

test('ping: an empty name answers invalid_name', () => {
  const r = pingResult('   ');
  assert.deepEqual(r, {
    ok: false,
    resultType: 'ping',
    errorCode: 'invalid_name',
    errorMessage: 'name is required',
  });
});

test('ping: a too-long name answers invalid_name', () => {
  const r = pingResult('x'.repeat(65));
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.errorCode, 'invalid_name');
  assert.match(r.errorMessage, /too long/);
});
