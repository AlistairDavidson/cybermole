// The pure core: shapes, tags and filter compilation.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compileListFilter,
  escapeLike,
  rowToNote,
  validateTags,
} from '../src/lib/notes-core.ts';

test('core: rowToNote is the storage→wire boundary', () => {
  assert.deepEqual(
    rowToNote({ id: 1, title: 't', body: 'b', tags: '', archived: 0, created_at: 1, updated_at: 2 }),
    { id: 1, title: 't', body: 'b', tags: [], archived: false, createdAt: 1, updatedAt: 2 },
  );
  assert.deepEqual(
    rowToNote({ id: 2, title: 't', body: '', tags: 'a,b', archived: 1, created_at: 1, updated_at: 2 }).tags,
    ['a', 'b'],
  );
});

test('core: validateTags trims, lowercases, dedupes and sorts', () => {
  const v = validateTags([' B ', 'a', 'A']);
  assert.deepEqual(v, { ok: true, tags: ['a', 'b'] });
});

test('core: escapeLike escapes every LIKE wildcard', () => {
  assert.equal(escapeLike('100%_\\done'), '100\\%\\_\\\\done');
});

test('core: compileListFilter — defaults, trimming, wildcards, tags', () => {
  assert.deepEqual(compileListFilter({}).filter, {
    archived: false,
    searchLike: null,
    tagLike: null,
  });
  const q = compileListFilter({ search: ' 50% ', tag: ' Standup ', archived: 'true' });
  assert.deepEqual(q.filter, {
    archived: true,
    searchLike: '%50\\%%',
    tagLike: '%,standup,%',
  });
});

test('core: compileListFilter refuses off-values archived', () => {
  const q = compileListFilter({ archived: '1' });
  assert.equal(q.ok, false);
  if (!q.ok) assert.match(q.why, /"true" or "false"/);
});
