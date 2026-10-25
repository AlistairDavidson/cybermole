// Import first in any client script using SSR'd Web Awesome components. The
// astro-lit support modules must run before any wa-* defines, or SSR'd
// elements render twice. The SSR'd modules must also be re-imported
// client-side or they never upgrade (AGENTS.md). Side effects only (carved
// out of sideEffects: false), and deliberately not in the root entry:
//
//   import '@cybermole/app-kit/wa-client';
//   import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/astro-lit/dsd-polyfill.js';
import '@awesome.me/astro-lit/hydration-support.js';
