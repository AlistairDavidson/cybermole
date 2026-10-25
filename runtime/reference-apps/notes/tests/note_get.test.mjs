import test from 'node:test';
import assert from 'node:assert/strict';
import { noteGetResult } from '../src/lib/note_get.ts';
import { fakeStore, row, throwingStore } from './fake-store.mjs';

test('note_get: a note is answered shaped (tags split, archived boolean)', () => {
  const store = fakeStore([row({ id: 7, tags: 'standup,journal', archived: 1 })]);
  const r = noteGetResult(store, 7);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.resultType, 'note_get');
  assert.deepEqual(r.data.note, {
    id: 7,
    title: 'standup',
    body: 'did the thing',
    tags: ['standup', 'journal'],
    archived: true,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  });
});

test('note_get: a missing note answers note_not_found (archived ones still get)', () => {
  const store = fakeStore([row({ id: 1, archived: 1 })]);
  assert.equal(noteGetResult(store, 1).ok, true); // the archive hides from the list, not the get
  const r = noteGetResult(store, 99);
  assert.deepEqual(r, {
    ok: false,
    resultType: 'note_get',
    errorCode: 'note_not_found',
    errorMessage: 'no note #99 — note_list shows what is there',
  });
});

test('note_get: a store failure answers database_error', () => {
  const r = noteGetResult(throwingStore('gone'), 1);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.errorCode, 'database_error');
  assert.match(r.errorMessage, /could not read the note/);
});
