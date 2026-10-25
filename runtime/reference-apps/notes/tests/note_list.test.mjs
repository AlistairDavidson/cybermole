// The compiled filter the store receives, the archived rule, and the shaped answer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { noteListResult } from '../src/lib/note_list.ts';
import { fakeStore, row, throwingStore } from './fake-store.mjs';

test('note_list: the default filter is live notes, no patterns', () => {
  const store = fakeStore([row({ id: 1 }), row({ id: 2, archived: 1 })]);
  const r = noteListResult(store, {});
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.resultType, 'note_list');
  assert.deepEqual(r.data.notes[0], {
    id: 1,
    title: 'standup',
    body: 'did the thing',
    tags: ['standup'],
    archived: false,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  });
  assert.deepEqual(r.data, { notes: r.data.notes, count: 1, limit: 200 });
  const [call, filter] = store.captured[0];
  assert.equal(call, 'list');
  assert.deepEqual(filter, { archived: false, searchLike: null, tagLike: null });
});

test('note_list: archived=true flips the filter and shapes the archived rows', () => {
  const store = fakeStore([row({ id: 2, archived: 1, tags: 'a,b' })]);
  const r = noteListResult(store, { archived: 'true' });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.data.notes[0].tags, ['a', 'b']);
  assert.equal(r.data.notes[0].archived, true);
  assert.deepEqual(store.captured[0][1], { archived: true, searchLike: null, tagLike: null });
});

test('note_list: search and tag are trimmed into escaped LIKE patterns', () => {
  const store = fakeStore();
  const r = noteListResult(store, { search: ' 100%_done ', tag: ' Standup ' });
  assert.equal(r.ok, true);
  assert.deepEqual(store.captured[0][1], {
    archived: false,
    searchLike: '%100\\%\\_done%',
    tagLike: '%,standup,%',
  });
});

test('note_list: an off-values archived flag answers invalid_archived', () => {
  const r = noteListResult(fakeStore(), { archived: 'maybe' });
  assert.deepEqual(r, {
    ok: false,
    resultType: 'note_list',
    errorCode: 'invalid_archived',
    errorMessage: 'archived must be "true" or "false" (got "maybe")',
  });
});

test('note_list: a store failure answers database_error', () => {
  const r = noteListResult(throwingStore('locked'), {});
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.errorCode, 'database_error');
  assert.match(r.errorMessage, /could not list notes/);
});
