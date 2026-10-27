// app-icons.ts: the registry (every pickable name has a vendored glyph) and
// the name → icon suggestion rule (word-prefix matches, first rule wins,
// default fallback).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  APP_ICONS,
  APP_ICON_NAMES,
  DEFAULT_APP_ICON,
  isAppIcon,
  suggestAppIcon,
} from '../../dist-server/src/lib/apps/app-icons.js';

test('the registry: no duplicates, the default is pickable, the canonical list joins it', () => {
  assert.equal(new Set(APP_ICONS).size, APP_ICONS.length);
  assert.ok(APP_ICONS.includes(DEFAULT_APP_ICON));
  assert.equal(APP_ICON_NAMES, APP_ICONS.join(', '));
  for (const name of APP_ICONS) assert.match(name, /^[a-z0-9-]+$/);
});

test('every pickable icon has a vendored svg — a name without one renders nothing', () => {
  const solid = path.resolve('public', 'icons', 'wa', 'solid');
  const vendored = new Set(fs.readdirSync(solid).map(f => f.replace(/\.svg$/, '')));
  for (const name of APP_ICONS)
    assert.ok(vendored.has(name), `${name} is not vendored in public/icons/wa/solid`);
});

test('isAppIcon: membership only', () => {
  assert.equal(isAppIcon('cubes'), true);
  assert.equal(isAppIcon('robot'), true);
  assert.equal(isAppIcon('robot '), false);
  assert.equal(isAppIcon('Robot'), false);
  assert.equal(isAppIcon('nope'), false);
  assert.equal(isAppIcon(''), false);
});

test('suggestAppIcon: the keyword table', () => {
  assert.equal(suggestAppIcon('Notes'), 'file-lines');
  assert.equal(suggestAppIcon('Notes Standup'), 'file-lines');
  assert.equal(suggestAppIcon('code stuff'), 'code');
  assert.equal(suggestAppIcon('My Dev Playground'), 'code');
  assert.equal(suggestAppIcon('Agent Console'), 'robot'); // first rule wins
  assert.equal(suggestAppIcon('chat bot'), 'robot');
  assert.equal(suggestAppIcon('terminal probe'), 'terminal');
  assert.equal(suggestAppIcon('Job Runner'), 'clock');
  assert.equal(suggestAppIcon('Search Box'), 'magnifying-glass');
  assert.equal(suggestAppIcon('Status Check'), 'circle-check');
});

test('suggestAppIcon: word prefixes only — "chair" never suggests via "ai"', () => {
  assert.equal(suggestAppIcon('chairman notes'), 'file-lines'); // not robot
  assert.equal(suggestAppIcon('the daily log'), DEFAULT_APP_ICON);
  assert.equal(suggestAppIcon('counter'), DEFAULT_APP_ICON); // "count" is not "code"
});

test('suggestAppIcon: unmatched names fall back to the default', () => {
  assert.equal(suggestAppIcon(''), DEFAULT_APP_ICON);
  assert.equal(suggestAppIcon('   '), DEFAULT_APP_ICON);
  assert.equal(suggestAppIcon('zzz qqq'), DEFAULT_APP_ICON);
  assert.equal(suggestAppIcon('Университет'), DEFAULT_APP_ICON);
});

test('suggestAppIcon always answers a registry name (the rule cannot drift)', () => {
  for (const name of [
    'a',
    'Notes',
    'AI Notes',
    'dev-tool',
    'code_review',
    'x'.repeat(200),
    '123',
    'ümlaut',
  ]) {
    assert.ok(isAppIcon(suggestAppIcon(name)), name);
  }
});
