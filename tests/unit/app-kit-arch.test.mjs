// @cybermole/app-kit live.ts (backoffDelay) and scripts/arch-check.mjs
// (scanSource): the WS doorbell's reconnect math and the architecture
// lint's source scans. createAppSocket needs a browser WebSocket — its
// discipline is exercised by the apps-ws e2e face.
import test from 'node:test';
import assert from 'node:assert/strict';
import { backoffDelay } from '../../dist-server/packages/app-kit/src/live.js';
import { scanComponentDir, scanSource } from '../../packages/app-kit/scripts/arch-check.mjs';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

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

test('arch-check: HTML-string writes in every idiom are violations; reads are not', () => {
  const out = scanSource(
    'src/dom.ts',
    `this.attachShadow({ mode: 'open' });
el.innerHTML = '<p>hi</p>';
el.innerHTML += more;
el.outerHTML =
  built();
el.insertAdjacentHTML('beforeend', row);
el.setHTMLUnsafe(payload);
document.write(page);
if (el.innerHTML === '<p>hi</p>') return;
const t = el.outerHTML;
`,
  );
  assert.equal(out.length, 7);
  assert.match(out[0] ?? '', /light DOM only/);
  for (const v of out.slice(1)) assert.match(v, /HTML-string write/);
  assert.match(out[2] ?? '', /src\/dom\.ts:3/);
  assert.match(out[3] ?? '', /src\/dom\.ts:4/); // multi-line write reported at its start line
});

test('arch-check: renderer integrations, renderers and html-template libs are banned imports', () => {
  const out = scanSource(
    'src/render.ts',
    `import react from '@astrojs/react';
import { el } from 'htm';
import { html } from 'uhtml';
import React from 'react';
import App from './App.vue';
`,
  );
  assert.equal(out.length, 4);
  assert.match(out[0] ?? '', /@astrojs\/react/);
  assert.match(out[1] ?? '', /'htm'/);
});

test('arch-check: client:* directives are violations in .astro files only', () => {
  const astro = scanSource('src/pages/index.astro', '<Counter client:load />\n');
  assert.equal(astro.length, 1);
  assert.match(astro[0] ?? '', /hydration is banned/);
  // the same words in a .ts comment are not a directive
  assert.deepEqual(scanSource('src/t.ts', '// client:load is banned\n'), []);
});

test('arch-check: the agent console is the sanctioned exception (by file name)', () => {
  assert.deepEqual(scanSource('src/agent-console.ts', 'el.innerHTML = buildMarkup();\n'), []);
  assert.deepEqual(scanSource('src/agent-console-flow.ts', 'el.innerHTML = buildMarkup();\n'), []);
  // a substring lookalike does not escape the rules
  const impostor = scanSource('src/my-agent-console-thing.ts', 'el.innerHTML = x;\n');
  assert.equal(impostor.length, 1);
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

// ---------- the component-directory rule (structural) ----------

test('arch-check: components/ must be directories with their .astro half', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-components-'));
  // A conforming pair.
  fs.mkdirSync(path.join(root, 'Good', ''), { recursive: true });
  fs.writeFileSync(path.join(root, 'Good', 'Good.astro'), '');
  fs.writeFileSync(path.join(root, 'Good', 'good.ts'), '');
  assert.deepEqual(scanComponentDir(root), []);

  // A flat enhancer file.
  fs.writeFileSync(path.join(root, 'flat.ts'), 'export {};\n');
  // A directory missing its SSR half.
  fs.mkdirSync(path.join(root, 'Orphan'));
  fs.writeFileSync(path.join(root, 'Orphan', 'orphan.ts'), '');
  const out = scanComponentDir(root);
  assert.equal(out.length, 2);
  const flat = out.find(v => v.includes('flat.ts'));
  const orphan = out.find(v => v.includes('Orphan'));
  assert.match(flat ?? '', /a flat file in components/);
  assert.match(orphan ?? '', /Orphan: a component directory without Orphan\.astro/);
});

test('arch-check: document.createElement is not the pattern in app code', () => {
  const out = scanSource(
    'src/components/Thing/thing.ts',
    'const p = document.createElement("p");\n',
  );
  assert.equal(out.length, 1);
  assert.match(out[0], /templated in the \.astro/);
});

test('arch-check: inline style attributes are banned in .astro markup', () => {
  const out = scanSource(
    'src/pages/index.astro',
    '<wa-card style="margin: 1rem;">x</wa-card>\n<p style={{ color: c }}>y</p>\n<p>plain</p>\n',
  );
  assert.equal(out.length, 2);
  for (const v of out) assert.match(v, /Web Awesome layout components/);
});
