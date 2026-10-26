// tab-order.ts: the pure half of tab reordering — the optimistic move the
// tab bar applies, and the persisted plan (full-list validation, steps of
// 10, unchanged positions skipped).
import test from 'node:test';
import assert from 'node:assert/strict';
import { moveItem, reorderUpdates } from '../../dist-server/src/lib/terminals/tab-order.js';

const T = n => `00000000-0000-4000-8000-00000000000${n}`;

// ---------- moveItem ----------

test('moveItem: moves within bounds and returns a new array', () => {
  assert.deepEqual(moveItem(['a', 'b', 'c', 'd'], 0, 2), ['b', 'c', 'a', 'd']);
  assert.deepEqual(moveItem(['a', 'b', 'c', 'd'], 3, 0), ['d', 'a', 'b', 'c']);
  assert.deepEqual(moveItem(['a', 'b', 'c'], 1, 1), ['a', 'b', 'c']);
  const src = ['a', 'b'];
  const out = moveItem(src, 0, 1);
  assert.deepEqual(out, ['b', 'a']);
  assert.notEqual(out, src); // the input is never mutated
  assert.deepEqual(src, ['a', 'b']);
});

test('moveItem: out-of-range or equal indices are a no-op copy', () => {
  for (const [from, to] of [
    [-1, 0],
    [0, -1],
    [2, 0],
    [0, 3],
    [0, 0],
  ]) {
    assert.deepEqual(moveItem(['a', 'b'], from, to), ['a', 'b'], `${from}->${to}`);
  }
  assert.deepEqual(moveItem([], 0, 0), []);
});

// ---------- reorderUpdates ----------

/** The append pattern: rows created in order carry 10, 20, 30… */
const current = n => Array.from({ length: n }, (_, i) => ({ id: T(i), sortOrder: (i + 1) * 10 }));

test('reorderUpdates: positions become steps of 10, unchanged positions skipped', () => {
  // [a b c] -> [b a c]: a and b swap, c keeps its 30 (updates follow the
  // ordered list's iteration, not the stored one)
  const plan = reorderUpdates(current(3), [T(1), T(0), T(2)]);
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.updates, [
    { id: T(1), sortOrder: 10 },
    { id: T(0), sortOrder: 20 },
  ]);
});

test('reorderUpdates: a same-order list writes nothing', () => {
  const plan = reorderUpdates(current(3), [T(0), T(1), T(2)]);
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.updates, []);
});

test('reorderUpdates: stored values that drift (a mid-list delete) renumber', () => {
  // After deleting the first of three, the rows keep 20, 30, 40; reordering
  // the remainder rewrites the head to 10 and renumbers the tail behind it.
  const drifted = [
    { id: T(1), sortOrder: 20 },
    { id: T(2), sortOrder: 30 },
    { id: T(3), sortOrder: 40 },
  ];
  const same = reorderUpdates(drifted, [T(1), T(2), T(3)]);
  assert.equal(same.ok, true);
  assert.deepEqual(same.updates, [
    { id: T(1), sortOrder: 10 },
    { id: T(2), sortOrder: 20 },
    { id: T(3), sortOrder: 30 },
  ]);

  const reversed = reorderUpdates(drifted, [T(3), T(2), T(1)]);
  assert.deepEqual(reversed.updates, [
    { id: T(3), sortOrder: 10 },
    { id: T(2), sortOrder: 20 },
    { id: T(1), sortOrder: 30 },
  ]);
});

test('reorderUpdates: a duplicate, an unknown id and a missing id are invalid', () => {
  const dup = reorderUpdates(current(3), [T(0), T(0), T(2)]);
  assert.equal(dup.ok, false);
  assert.equal(dup.error, 'duplicate');
  const unknown = reorderUpdates(current(3), [T(0), T(1), '99999999-9999-4999-8999-999999999999']);
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error, 'unknown_terminal');
  const short = reorderUpdates(current(3), [T(0), T(1)]);
  assert.equal(short.ok, false);
  assert.equal(short.error, 'missing_terminal');
  const empty = reorderUpdates(current(1), []);
  assert.equal(empty.ok, false);
  assert.equal(empty.error, 'missing_terminal');
  // an empty list IS a permutation of an empty workspace: a no-op plan
  const none = reorderUpdates([], []);
  assert.deepEqual(none, { ok: true, updates: [] });
});
