// @cybermole/app-kit app-menu.ts: the header Apps menu's read of the
// console state, its order and links, and an app page's console base.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appMenuEntries,
  consoleBaseOf,
  parseMenuState,
} from '../../dist-server/packages/app-kit/src/app-menu.js';

const app = (slug, order, serving = true) => ({
  id: `id-${slug}`,
  name: slug.toUpperCase(),
  slug,
  cwd: null,
  icon: 'cubes',
  order,
  serving,
  servingReason: serving ? null : 'not mounted',
});

test('parseMenuState: reads logs + apps off a state answer, null for anything else', () => {
  const state = parseMenuState({ me: 'ok', logs: true, apps: [app('a', 0)], workspaces: [] });
  assert.equal(state?.logs, true);
  assert.equal(state?.apps.length, 1);
  assert.equal(parseMenuState({ error: 'nope' }), null);
  assert.equal(parseMenuState(null), null);
  assert.equal(parseMenuState({ logs: true, apps: [{ slug: 'a' }] }), null);
});

test('appMenuEntries: console order, app links under the console base, serving carried', () => {
  const entries = appMenuEntries([app('b', 2), app('a', 1, false)], '/cm');
  assert.deepEqual(
    entries.map(e => [e.slug, e.href, e.serving]),
    [
      ['a', '/cm/apps/a/', false],
      ['b', '/cm/apps/b/', true],
    ],
  );
  assert.equal(appMenuEntries([app('a', 0)], '')[0].href, '/apps/a/');
});

test('consoleBaseOf: what precedes /apps/<slug> in an app base', () => {
  assert.equal(consoleBaseOf('/apps/notes'), '');
  assert.equal(consoleBaseOf('/apps/notes/'), '');
  assert.equal(consoleBaseOf('/console/apps/notes'), '/console');
  assert.equal(consoleBaseOf('/a/apps/b/apps/notes'), '/a/apps/b');
});
