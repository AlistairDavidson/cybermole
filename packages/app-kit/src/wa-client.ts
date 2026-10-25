// wa-client.ts — the wa-* client-import boilerplate, as a convention
// carrier: import this module FIRST in any client script that uses SSR'd
// Web Awesome components. The support modules must run before any wa-*
// component module defines — if the SSR'd elements define before lit
// hydration support installs, they render twice (everything appears
// doubled); and without the client-side re-import the elements never
// upgrade (form association, .value, toggles — all dead while they look
// fine). The worked example is the console's src/pages/login.astro: the
// SAME wa-* modules imported in frontmatter for SSR are re-imported by
// its client script — with this module first (see AGENTS.md,
// "SSR imports ≠ client imports", and docs/conventions/CODE_STYLE.md §7).
//
// Pure side effects (package.json's sideEffects list carves this module
// out so bundlers never drop it); import it as a statement:
//
//   import '@cybermole/app-kit/wa-client';
//   import '@awesome.me/webawesome/dist/components/button/button.js';
//
// This module is deliberately NOT re-exported from the kit's root entry —
// importing the root is for values; this is for the polyfill order.
import '@awesome.me/astro-lit/dsd-polyfill.js';
import '@awesome.me/astro-lit/hydration-support.js';
