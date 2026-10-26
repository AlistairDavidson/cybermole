// order-plan.ts: the generic full-list reorder plan shared by terminal
// tabs, sidebar workspace rows and app groups — steps of 10, unchanged
// positions skipped, duplicate/unknown/missing rejected.
import test from 'node:test';
import assert from 'node:assert/strict';
import { moveItem, orderPlan, sameSequence } from '../../dist-server/src/lib/order-plan.js';

const W = n => `00000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;

// ---------- moveItem / sameSequence ----------

test('moveItem: moves within bounds and never mutates the input', () => {
  assert.deepEqual(moveItem(['a', 'b', 'c', 'd'], 0, 2), ['b', 'c', 'a', 'd']);
  assert.deepEqual(moveItem(['a', 'b', 'c', 'd'], 3, 0), ['d', 'a', 'b', 'c']);
  const src = ['a', 'b'];
  assert.deepEqual(moveItem(src, 0, 1), ['b', 'a']);
  assert.deepEqual(src, ['a', 'b']);
  for (const [from, to] of [
    [-1, 0],
    [0, -1],
    [2, 0],
    [0, 3],
    [0, 0],
  ]) {
    assert.deepEqual(moveItem(['a', 'b'], from, to), ['a', 'b'], `${from}->${to}`);
  }
});

test('sameSequence: same items in the same order, and only then', () => {
  assert.equal(sameSequence([], []), true);
  assert.equal(sameSequence(['a', 'b'], ['a', 'b']), true);
  assert.equal(sameSequence(['a', 'b'], ['b', 'a']), false);
  assert.equal(sameSequence(['a'], ['a', 'a']), false);
  assert.equal(sameSequence(['a', 'b'], ['a']), false);
});

// ---------- orderPlan ----------

/** The append pattern: rows created in order carry 10, 20, 30… */
const current = n => Array.from({ length: n }, (_, i) => ({ id: W(i), sortOrder: (i + 1) * 10 }));

test('orderPlan: positions become steps of 10, unchanged positions skipped', () => {
  const plan = orderPlan(current(3), [W(1), W(0), W(2)], 'workspace', 'in this group');
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.updates, [
    { id: W(1), sortOrder: 10 },
    { id: W(0), sortOrder: 20 },
  ]);
  assert.deepEqual(orderPlan(current(3), [W(0), W(1), W(2)], 'app', 'in this list').updates, []);
});

test('orderPlan: stored values that drift (a mid-list delete) renumber', () => {
  const drifted = [
    { id: W(1), sortOrder: 20 },
    { id: W(2), sortOrder: 30 },
    { id: W(3), sortOrder: 40 },
  ];
  assert.deepEqual(orderPlan(drifted, [W(1), W(2), W(3)], 'workspace', 'in this group').updates, [
    { id: W(1), sortOrder: 10 },
    { id: W(2), sortOrder: 20 },
    { id: W(3), sortOrder: 30 },
  ]);
});

test('orderPlan: a duplicate, an unknown id and a missing id are rejected with noun+context text', () => {
  const dup = orderPlan(current(3), [W(0), W(0), W(2)], 'workspace', 'in this group');
  assert.equal(dup.ok, false);
  assert.equal(dup.error, 'duplicate');
  assert.equal(dup.message, 'the order lists a workspace twice');
  const anApp = orderPlan(current(2), [W(0), W(0)], 'app', 'in this list');
  assert.equal(anApp.message, 'the order lists an app twice');

  const unknown = orderPlan(
    current(3),
    [W(0), W(1), '99999999-9999-4999-8999-999999999999'],
    'workspace',
    'in this group',
  );
  assert.equal(unknown.error, 'unknown');
  assert.equal(
    unknown.message,
    'workspace 99999999-9999-4999-8999-999999999999 is not in this group',
  );

  const missing = orderPlan(current(3), [W(0), W(1)], 'app', 'in this list');
  assert.equal(missing.error, 'missing');
  assert.equal(missing.message, 'the order must list every app in this list');

  // an empty list IS a permutation of an empty set: a no-op plan
  assert.deepEqual(orderPlan([], [], 'workspace', 'in this group'), { ok: true, updates: [] });
});
