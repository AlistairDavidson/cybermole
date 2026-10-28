// @cybermole/app-kit live.ts (backoffDelay) and scripts/arch-check.mjs
// (scanSource): the WS doorbell's reconnect math and the architecture
// lint's source scans. createAppSocket needs a browser WebSocket — its
// discipline is exercised by the apps-ws e2e face.
import test from 'node:test';
import assert from 'node:assert/strict';
import { backoffDelay } from '../../dist-server/packages/app-kit/src/live.js';
import { scanSource } from '../../packages/app-kit/scripts/arch-check.mjs';

// ---------- backoffDelay ----------

test('backoffDelay: exponential from the base, capped', () => {
  assert.equal(backoffDelay(1), 1000);
  assert.equal(backoffDelay(2), 2000);
  assert.equal(backoffDelay(3), 4000);
  assert.equal(backoffDelay(5), 15000); // 16000 capped
  assert.equal(backoffDelay(50), 15000);
  assert.equal(backoffDelay(0, 500, 4000), 500); // attempt 0 clamps to the base
  assert.equal(backoffDelay(4, 500, 4000), 4000);
});

// ---------- arch-check scanSource ----------

test('arch-check: banned imports are named with the rule that bans them', () => {
  const out = scanSource(
    'src/bad.ts',
    `import { signal } from '@preact/signals-core'; // sanctioned
import { h } from 'preact';
import { useEffect } from 'preact/hooks';
import { signal as p } from '@preact/signals';
import { html } from 'lit';
import { LitElement } from 'lit-element';
import htmx from 'htmx.org';
const lazy = () => import('lit-html');
export { x } from 'preact/compat';
`,
  );
  assert.equal(out.length, 8);
  assert.match(out[0] ?? '', /src\/bad\.ts:2: import 'preact'/);
  assert.match(out[1] ?? '', /preact\/hooks/);
  assert.match(out[2] ?? '', /@preact\/signals'/); // not signals-core
  assert.match(out[3] ?? '', /'lit'/);
  assert.match(out[6] ?? '', /lit-html/);
  assert.match(out[7] ?? '', /preact\/compat/);
  for (const line of out) assert.match(line, /CODE_STYLE|signals-core|webawesome|surgically/);
});

test('arch-check: the sanctioned surface scans clean', () => {
  const clean = `import { signal } from '@preact/signals-core';
import { effect } from '@preact/signals-core';
import { defineElement, waValue } from '@cybermole/app-kit/element';
import '@awesome.me/webawesome/dist/components/button/button.js';
import { z } from 'zod';
`;
  assert.deepEqual(scanSource('src/good.ts', clean), []);
});

test('arch-check: attachShadow and innerHTML writes are violations; reads are not', () => {
  const out = scanSource(
    'src/dom.ts',
    `this.attachShadow({ mode: 'open' });
el.innerHTML = '<p>hi</p>';
if (el.innerHTML === '<p>hi</p>') return;
const t = el.outerHTML;
`,
  );
  assert.equal(out.length, 2);
  assert.match(out[0] ?? '', /light DOM only/);
  assert.match(out[1] ?? '', /surgically/);
});

test('arch-check: the agent console is the sanctioned exception', () => {
  const out = scanSource('src/agent-console.ts', 'el.innerHTML = buildMarkup();\n');
  assert.deepEqual(out, []);
});

test('arch-check: customElements.define needs its guard (defineElement has one)', () => {
  const bare = `customElements.define('x-bad', class extends HTMLElement {});
`;
  const out = scanSource('src/define.ts', bare);
  assert.equal(out.length, 1);
  assert.match(out[0] ?? '', /defineElement/);

  const guarded = `if (!customElements.get('x-good')) customElements.define('x-good', X);
`;
  assert.deepEqual(scanSource('src/define.ts', guarded), []);
});
