// debounceTrailing: a burst of calls becomes one, with the last arguments.
import test from 'node:test';
import assert from 'node:assert/strict';

const { debounceTrailing } = await import('../../dist-server/src/lib/platform/debounce.js');

const tick = ms => new Promise(resolve => setTimeout(resolve, ms));

test('a burst coalesces into one trailing call with the last arguments', async () => {
  const calls = [];
  const debounced = debounceTrailing((...args) => calls.push(args), 25);
  debounced('a');
  debounced('b');
  debounced('c', 'd');
  assert.deepEqual(calls, [], 'nothing fires inside the window');
  await tick(60);
  assert.deepEqual(calls, [['c', 'd']], 'one call, the last arguments');
});

test('calls separated by more than the window each fire', async () => {
  const calls = [];
  const debounced = debounceTrailing(x => calls.push(x), 20);
  debounced(1);
  await tick(45);
  debounced(2);
  await tick(45);
  assert.deepEqual(calls, [1, 2]);
});

test('cancel drops a pending invocation', async () => {
  const calls = [];
  const debounced = debounceTrailing(x => calls.push(x), 20);
  debounced(1);
  debounced.cancel();
  await tick(50);
  assert.deepEqual(calls, []);
  // still usable after a cancel
  debounced(2);
  await tick(50);
  assert.deepEqual(calls, [2]);
});

test('independent instances keep independent timers', async () => {
  const calls = [];
  const a = debounceTrailing(() => calls.push('a'), 15);
  const b = debounceTrailing(() => calls.push('b'), 15);
  a();
  b();
  await tick(40);
  assert.deepEqual(calls.sort(), ['a', 'b']);
});
