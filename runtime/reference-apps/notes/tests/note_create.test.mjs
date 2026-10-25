// One test per error code, against the in-memory store.
import test from 'node:test';
import assert from 'node:assert/strict';
import { noteCreateResult } from '../src/lib/note_create.ts';
import { fakeStore, throwingStore } from './fake-store.mjs';

test('note_create: a note is captured, normalized and answered shaped', () => {
  const store = fakeStore();
  const r = noteCreateResult(store, {
    title: '  Standup — monday  ',
    body: ' shipped the notes app ',
    tags: [' Standup ', 'team', 'TEAM'],
  });
  assert.equal(r.ok, true);
  if (!r.ok) return; // narrow for the type checker's sake
  assert.equal(r.resultType, 'note_create');
  assert.deepEqual(r.data.note, {
    id: 1,
    title: 'Standup — monday',
    body: 'shipped the notes app',
    tags: ['standup', 'team'],
    archived: false,
    createdAt: r.data.note.createdAt,
    updatedAt: r.data.note.updatedAt,
  });
  assert.equal(typeof r.data.note.createdAt, 'number');
  // tags joined in the storage format
  const [call, inserted] = store.captured[0];
  assert.equal(call, 'insert');
  assert.equal(inserted.tags, 'standup,team');
  assert.equal(inserted.archived, 0);
});

test('note_create: body and tags are optional', () => {
  const r = noteCreateResult(fakeStore(), { title: 'a scratch note' });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.data.note.tags, []);
  assert.equal(r.data.note.body, '');
});

test('note_create: an empty title answers invalid_title', () => {
  const r = noteCreateResult(fakeStore(), { title: '   ', body: 'x' });
  assert.deepEqual(r, {
    ok: false,
    resultType: 'note_create',
    errorCode: 'invalid_title',
    errorMessage: 'title is required',
  });
});

test('note_create: a too-long title answers invalid_title', () => {
  const r = noteCreateResult(fakeStore(), { title: 'x'.repeat(201) });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.errorCode, 'invalid_title');
  assert.match(r.errorMessage, /too long/);
});

test('note_create: a too-long body answers invalid_body', () => {
  const r = noteCreateResult(fakeStore(), { title: 'ok', body: 'x'.repeat(20_001) });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.errorCode, 'invalid_body');
  assert.match(r.errorMessage, /too long/);
});

test('note_create: bad tags answer invalid_tags (empty, comma, long, many)', () => {
  const store = fakeStore();
  const cases = [
    { tags: [''], why: 'a tag empty after trimming' },
    { tags: ['a,b'], why: 'a tag with a comma' },
    { tags: ['x'.repeat(41)], why: 'a too-long tag' },
    { tags: Array.from({ length: 11 }, (_, i) => `t${i}`), why: 'too many tags' },
  ];
  for (const { tags, why } of cases) {
    const r = noteCreateResult(store, { title: 'ok', tags });
    assert.equal(r.ok, false, why);
    if (r.ok) continue;
    assert.equal(r.errorCode, 'invalid_tags', why);
  }
  assert.equal(store.captured.length, 0); // nothing written
});

test('note_create: a store failure answers database_error', () => {
  const r = noteCreateResult(throwingStore('disk full'), { title: 'ok' });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.errorCode, 'database_error');
  assert.match(r.errorMessage, /could not save the note: .*disk full/);
});
