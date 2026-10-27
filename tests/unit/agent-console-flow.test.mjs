// The agent-console drawer's pure flow: operator-workspace resolution,
// first-terminal pick, and the builder deep link — from a ConsoleState
// shape (the console's ConsoleState is structurally the same).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appBySlug,
  builderLink,
  firstTerminal,
  operatorWorkspace,
} from '../../dist-server/packages/app-kit/src/agent-console-flow.js';

const APP_ID = 'b0b0b0b0-1111-4111-8111-111111111111';
const OTHER_APP = 'b0b0b0b0-2222-4222-8222-222222222222';
const CONSOLE_WS = '11111111-3333-4333-8333-333333333333';
const OPERATOR_A = '11111111-4444-4444-8444-444444444444';
const OPERATOR_B = '11111111-5555-4555-8555-555555555555';
const BUILD_A = '11111111-6666-4666-8666-666666666666';
const BUILD_B = '11111111-7777-4777-8777-777777777777';
const TERM = n => `11111111-8888-4888-8888-${String(n).padStart(12, '0')}`;

// The rows' array order deliberately disagrees with `order` (the console
// sorts by order, not array position).
const state = () => ({
  apps: [
    { id: APP_ID, slug: 'notes' },
    { id: OTHER_APP, slug: 'ledger' },
  ],
  workspaces: [
    {
      id: BUILD_A,
      appId: APP_ID,
      kind: 'build',
      order: 10,
      terminals: [{ id: TERM(1), order: 10 }],
    },
    { id: CONSOLE_WS, appId: null, kind: null, order: 10, terminals: [] },
    {
      id: OPERATOR_B,
      appId: APP_ID,
      kind: null,
      order: 30,
      terminals: [{ id: TERM(3), order: 10 }],
    },
    {
      id: OPERATOR_A,
      appId: APP_ID,
      kind: null,
      order: 20,
      terminals: [
        { id: TERM(2), order: 30 },
        { id: TERM(4), order: 10 },
      ],
    },
    {
      id: BUILD_B,
      appId: OTHER_APP,
      kind: 'build',
      order: 20,
      terminals: [{ id: TERM(5), order: 10 }],
    },
  ],
});

test('appBySlug: the row for this slug, or null', () => {
  assert.equal(appBySlug(state(), 'notes')?.id, APP_ID);
  assert.equal(appBySlug(state(), 'ledger')?.id, OTHER_APP);
  assert.equal(appBySlug(state(), 'nope'), null);
});

test('operatorWorkspace: first kind-NULL workspace of this app, by order', () => {
  // OPERATOR_A sorts before OPERATOR_B despite the row order in the array
  assert.equal(operatorWorkspace(state(), APP_ID), OPERATOR_A);
  // another app's rows never win
  const mine = {
    ...state(),
    workspaces: state().workspaces.filter(w => w.appId !== OTHER_APP),
  };
  assert.equal(operatorWorkspace(mine, OTHER_APP), null);
  // no kind-NULL workspace for the app → null (the drawer creates one)
  const buildsOnly = {
    ...state(),
    workspaces: state().workspaces.filter(w => w.kind === 'build'),
  };
  assert.equal(operatorWorkspace(buildsOnly, APP_ID), null);
});

test('firstTerminal: the workspace agent tab, by order; null when tabless', () => {
  assert.equal(firstTerminal(state(), OPERATOR_A), TERM(4));
  assert.equal(firstTerminal(state(), CONSOLE_WS), null);
  assert.equal(firstTerminal(state(), '00000000-0000-4000-8000-000000000000'), null);
});

test('builderLink: this app\u2019s first build workspace\u2019s first terminal, else plain', () => {
  assert.equal(builderLink(state(), APP_ID, ''), `/builder?t=${TERM(1)}`);
  assert.equal(builderLink(state(), OTHER_APP, ''), `/builder?t=${TERM(5)}`);
  // a based install keeps the prefix
  assert.equal(builderLink(state(), APP_ID, '/cm'), `/cm/builder?t=${TERM(1)}`);
  // no build workspace for this app → the plain portfolio page
  const noBuilds = {
    ...state(),
    workspaces: state().workspaces.filter(w => w.kind !== 'build'),
  };
  assert.equal(builderLink(noBuilds, APP_ID, ''), '/builder');
  // a build workspace whose tabs were all closed still lands on the
  // portfolio, not on a dead uuid
  const tabless = {
    ...state(),
    workspaces: state().workspaces.map(w => (w.id === BUILD_A ? { ...w, terminals: [] } : w)),
  };
  assert.equal(builderLink(tabless, APP_ID, ''), '/builder');
});
