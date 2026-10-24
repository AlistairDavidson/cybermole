// island.ts — the preact-signals island convention (docs/apps-plan.md §0/
// §5: pages render server-side; preact islands with @preact/signals carry
// the interactive regions; the console adopts whatever proves out — the
// epic TODO's preact item lands here, in the kit, not in the console yet).
//
// The convention an app follows:
// - The page (SSR) renders the island's host element with its initial
//   content as plain HTML — the island ENHANCES markup, never replaces a
//   placeholder (docs/CODE_STYLE.md §7's rule, carried into apps).
// - The island component is a plain preact component; client state is
//   signals (@preact/signals — signal()/computed() at module or component
//   scope) so prop-drilling and effect-chains stay out of small UIs.
// - A client script (the page's <script>) imports '@cybermole/app-kit/
//   wa-client' FIRST when the island renders wa-* components, then calls
//   mountIsland() to hydrate the host.
//
// mountIsland is intentionally the whole helper: find the host, render
// once, never twice (a script re-running after a partial swap is the
// classic double-mount). No framework, no router, no state library —
// signals live in the app's own modules.
import { createElement, render, type ComponentType } from 'preact';

/** Mount `<Component {...props} />` into the first element matching
 *  `selector`. Idempotent per element: a host marked mounted is left
 *  alone (re-running swaps are the caller's business — re-render into the
 *  same host by keying the selector, or clear it first). No-op (not an
 *  error) when the selector matches nothing: pages that conditionally
 *  render an island share one client script. */
export function mountIsland<P extends Record<string, unknown>>(
  selector: string,
  Component: ComponentType<P>,
  props: P,
): void {
  const host = document.querySelector<HTMLElement>(selector);
  if (!host || host.dataset.islandMounted === 'true') return;
  host.dataset.islandMounted = 'true';
  render(createElement(Component, props), host);
}
