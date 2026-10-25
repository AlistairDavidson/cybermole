// The note_edit action's unit tests — grown from the add_action stub:
// the merge rules (provided fields only), the guards, the stamps.
import test from 'node:test';
import assert from 'node:assert/strict';
import { noteEditResult } from '../src/lib/note_edit.ts';
import { fakeStore, row, throwingStore } from './fake-store.mjs';

test('note_edit: provided fields merge, the rest stand, updatedAt stamps', () => {
  const store = fakeStore([row({ id: 3, title: 'old', tags: 'oldtag' })]);
  const r = noteEditResult(store, 3, { title: ' new title ' });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.resultType, 'note_edit');
  assert.equal(r.data.note.title, 'new title');
  assert.equal(r.data.note.body, 'did the thing'); // untouched
  assert.deepEqual(r.data.note.tags, ['oldtag']); // untouched
  assert.ok(r.data.note.updatedAt > 1_700_000_000_000); // stamped
  const [call, id, patch] = store.captured[1]; // [0] is the findById
  assert.equal(call, 'update');
  assert.equal(id, 3);
  assert.deepEqual(patch, { title: 'new title' });
});

test('note_edit: the full patch replaces title, body and tags', () => {
  const store = fakeStore([row({ id: 3 })]);
  const r = noteEditResult(store, 3, {
    title: 'retitled',
    body: 'rewritten',
    tags: ['One', 'two'],
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.data.note.tags, ['one', 'two']);
  assert.equal(r.data.note.body, 'rewritten');
});

test('note_edit: a missing note answers note_not_found', () => {
  const r = noteEditResult(fakeStore(), 42, { title: 'x' });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.errorCode, 'note_not_found');
  assert.match(r.errorMessage, /no note #42/);
});

test('note_edit: an empty patch answers invalid_patch', () => {
  const r = noteEditResult(fakeStore([row({ id: 1 })]), 1, {});
  assert.deepEqual(r, {
    ok: false,
    resultType: 'note_edit',
    errorCode: 'invalid_patch',
    errorMessage: 'nothing to edit — provide title, body or tags',
  });
});

test('note_edit: the same field rules as create (title, body, tags)', () => {
  const store = fakeStore([row({ id: 1 })]);
  const blankTitle = noteEditResult(store, 1, { title: '   ' });
  assert.equal(blankTitle.ok, false);
  if (!blankTitle.ok) assert.equal(blankTitle.errorCode, 'invalid_title');

  const longTitle = noteEditResult(store, 1, { title: 'x'.repeat(201) });
  assert.equal(longTitle.ok, false);
  if (!longTitle.ok) assert.equal(longTitle.errorCode, 'invalid_title');

  const longBody = noteEditResult(store, 1, { body: 'x'.repeat(20_001) });
  assert.equal(longBody.ok, false);
  if (!longBody.ok) assert.equal(longBody.errorCode, 'invalid_body');

  const badTags = noteEditResult(store, 1, { tags: ['a,b'] });
  assert.equal(badTags.ok, false);
  if (!badTags.ok) assert.equal(badTags.errorCode, 'invalid_tags');
  // only the finds happened — nothing was ever written
  assert.deepEqual(
    store.captured.map(c => c[0]),
    ['findById', 'findById', 'findById', 'findById'],
  );
});

test('note_edit: a store failure answers database_error', () => {
  const r = noteEditResult(throwingStore('busy'), 1, { title: 'x' });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.errorCode, 'database_error');
});
