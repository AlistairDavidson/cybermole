// popout-view.ts: /view's target resolution — ?t=<uuid> finds the terminal
// (the tab bar's label rule), ?w=<uuid> the workspace's editor, and every
// other input degrades to a message state.
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolvePopoutView } from '../../dist-server/src/lib/web/popout-view.js';

const T = n => `00000000-0000-4000-8000-00000000000${n}`;
const W = n => `10000000-0000-4000-8000-00000000000${n}`;

const workspaces = [
  {
    id: W(1),
    appId: null,
    name: 'alpha',
    cwd: '/srv/alpha',
    kind: null,
    order: 0,
    terminals: [
      { id: T(1), title: null, order: 0, live: true },
      { id: T(2), title: 'build', order: 1, live: false },
    ],
  },
  { id: W(2), appId: null, name: 'beta', cwd: '/srv/beta', kind: null, order: 1, terminals: [] },
];

test('resolvePopoutView: ?t finds the terminal, labelled by the tab rule', () => {
  assert.deepEqual(
    resolvePopoutView(workspaces, {
      terminalId: T(2),
      workspaceId: null,
      editorEnabled: true,
    }),
    { kind: 'terminal', id: T(2), label: 'build' },
  );
  // An untitled tab labels by its 1-based position.
  assert.deepEqual(
    resolvePopoutView(workspaces, {
      terminalId: T(1),
      workspaceId: null,
      editorEnabled: true,
    }),
    { kind: 'terminal', id: T(1), label: 'term 1' },
  );
});

test('resolvePopoutView: ?t wins over a present ?w', () => {
  const view = resolvePopoutView(workspaces, {
    terminalId: T(1),
    workspaceId: W(1),
    editorEnabled: true,
  });
  assert.equal(view.kind, 'terminal');
});

test('resolvePopoutView: ?w finds the workspace editor with its folder', () => {
  assert.deepEqual(
    resolvePopoutView(workspaces, {
      terminalId: null,
      workspaceId: W(1),
      editorEnabled: true,
    }),
    { kind: 'editor', id: W(1), label: 'alpha — editor', cwd: '/srv/alpha' },
  );
  // Empty workspaces still have an editor.
  assert.deepEqual(
    resolvePopoutView(workspaces, {
      terminalId: null,
      workspaceId: W(2),
      editorEnabled: true,
    }),
    { kind: 'editor', id: W(2), label: 'beta — editor', cwd: '/srv/beta' },
  );
});

test('resolvePopoutView: the editor view needs the editor configured', () => {
  const view = resolvePopoutView(workspaces, {
    terminalId: null,
    workspaceId: W(1),
    editorEnabled: false,
  });
  assert.equal(view.kind, 'missing');
  assert.match(view.message, /editor is not configured/);
});

test('resolvePopoutView: unknown or malformed ids degrade to messages', () => {
  for (const [terminalId, workspaceId, match] of [
    [T(9), null, /no such terminal/],
    ['not-a-uuid', null, /malformed terminal id/],
    [null, W(9), /no such workspace/],
    [null, 'not-a-uuid', /malformed workspace id/],
    [null, null, /nothing to show/],
  ]) {
    const view = resolvePopoutView(workspaces, {
      terminalId: terminalId ?? null,
      workspaceId: workspaceId ?? null,
      editorEnabled: true,
    });
    assert.equal(view.kind, 'missing', `${terminalId}/${workspaceId}`);
    assert.match(view.message, match);
  }
});
