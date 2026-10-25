// Preact island convention: the page SSRs the host element with real content
// and the island enhances it; client state is @preact/signals. A client
// script imports '@cybermole/app-kit/wa-client' first when the island uses
// wa-*, then calls mountIsland().
import { createElement, render, type ComponentType } from 'preact';

/** Idempotent per host, so a re-running script never double-mounts. A
 *  selector matching nothing is a no-op, so pages can share one script. */
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
