// ids.test.mjs — the ID rules (src/schemas/patterns.ts + ids.ts): what each
// validating schema accepts and rejects, that a pass yields the same string
// (the brand is type-only), and that every pattern still compiles as an
// HTML `pattern` attribute (the `v` flag — an unescaped `-` in a character
// class is a syntax error there, and browsers silently drop the pattern).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  JOB_NAME_RE,
  TMUX_SESSION_NAME_RE,
  APP_SLUG_RE,
  OBJECT_KEY_RE,
  UUID_RE,
  normalizeJobName,
} from '../../dist-server/src/schemas/patterns.js';
import { JobNameSchema, TmuxSessionNameSchema } from '../../dist-server/src/schemas/ids.js';

const ok = (schema, v) => schema.safeParse(v).success;

test('every ID pattern compiles under the v flag (HTML pattern attributes)', () => {
  for (const re of [JOB_NAME_RE, TMUX_SESSION_NAME_RE, APP_SLUG_RE, OBJECT_KEY_RE, UUID_RE]) {
    assert.doesNotThrow(() => new RegExp(re.source, 'v'), re.source);
  }
});

test('TmuxSessionNameSchema: tmux-safe charset, 1..64', () => {
  for (const good of [
    'dev',
    'r-019f4706-0000-7000-8000-000000000001',
    'webpi-' + 'x'.repeat(40),
    'A_b-9',
  ]) {
    assert.equal(ok(TmuxSessionNameSchema, good), true, good);
  }
  for (const bad of ['', 'x'.repeat(65), 'a:b', 'a.b', 'a b', 'ä']) {
    assert.equal(ok(TmuxSessionNameSchema, bad), false, bad);
  }
});

test('JobNameSchema: lowercase charset up to 40, never webpi-*', () => {
  for (const good of ['nightly', 'a', 'x'.repeat(40), 'a_b-c', '9lives']) {
    assert.equal(ok(JobNameSchema, good), true, good);
  }
  for (const bad of ['', 'x'.repeat(41), 'Upper', '-lead', '_lead', 'webpi-x', 'a b', 'a.b']) {
    assert.equal(ok(JobNameSchema, bad), false, bad);
  }
});

test('normalizeJobName: slugifies like the shared slug rules, capped at 40', () => {
  assert.equal(normalizeJobName('  Nightly Check!! '), 'nightly-check');
  assert.equal(normalizeJobName('--a--'), 'a');
  assert.equal(normalizeJobName('x'.repeat(50)), 'x'.repeat(40));
  assert.equal(normalizeJobName('!!!'), '');
});
