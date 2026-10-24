// The note_archive action's unit tests — grown from the add_action stub.
import test from 'node:test';
import assert from 'node:assert/strict';
import { noteArchiveResult } from '../src/lib/note_archive.ts';
import { fakeStore, row, throwingStore } from './fake-store.mjs';

test('note_archive: flips the flag and nothing else, and stamps updatedAt', () => {
  const before = 1_700_000_000_000;
  const store = fakeStore([row({ id: 5, created_at: before, updated_at: before })]);
  const r = noteArchiveResult(store, 5);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.resultType, 'note_archive');
  assert.equal(r.data.note.archived, true);
  assert.equal(r.data.note.title, 'standup'); // the row keeps everything
  assert.equal(r.data.note.createdAt, before);
  assert.ok(r.data.note.updatedAt > before);
  const [call, id, patch] = store.captured[1]; // [0] is the findById
  assert.equal(call, 'update');
  assert.equal(id, 5);
  assert.deepEqual(patch, { archived: 1 }); // the ONLY write
});

test('note_archive: idempotent — an archived note archives green again', () => {
  const store = fakeStore([row({ id: 5, archived: 1 })]);
  const r = noteArchiveResult(store, 5);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.data.note.archived, true);
});

test('note_archive: a missing note answers note_not_found', () => {
  const r = noteArchiveResult(fakeStore(), 9);
  assert.deepEqual(r, {
    ok: false,
    resultType: 'note_archive',
    errorCode: 'note_not_found',
    errorMessage: 'no note #9 — note_list shows what is there',
  });
});

test('note_archive: a store failure answers database_error', () => {
  const r = noteArchiveResult(throwingStore('io'), 1);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.errorCode, 'database_error');
});
