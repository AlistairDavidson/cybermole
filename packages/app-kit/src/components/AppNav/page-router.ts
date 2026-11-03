/// <reference types="astro/client" />
// PageRouter's client half, in place of <ClientRouter />'s script: a plain
// same-tab click on a same-origin link navigates through Astro's router
// (fetch, view transition, swap; transition:persist and the astro:* events
// apply). The console and each app are separate Astro builds on the one
// origin, and a swap can only stay within a build (another build's page
// brings its own copies of modules this document already ran, the same
// custom elements defined twice), so a link into another build loads whole.
import { navigate, transitionEnabledOnThisPage } from 'astro:transitions/client';

/** 'console', or the slug of the app the path is under; null off the base. */
function buildOf(path: string, base: string): string | null {
  if (path !== base && !path.startsWith(`${base}/`)) return null;
  return /^\/apps\/([^/]+)/.exec(path.slice(base.length))?.[1] ?? 'console';
}

function sameBuild(target: URL): boolean {
  const base = document.querySelector<HTMLElement>('side-nav')?.dataset.base ?? '';
  const here = buildOf(location.pathname, base);
  return here !== null && buildOf(target.pathname, base) === here;
}

document.addEventListener('click', e => {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey)
    return;
  if (!transitionEnabledOnThisPage()) return;
  // composedPath reaches the anchor inside a wa-button's shadow root.
  const origin = e.composedPath()[0];
  const link = origin instanceof Element ? origin.closest('a') : null;
  if (!link?.href || link.hasAttribute('download') || link.dataset.astroReload !== undefined)
    return;
  if (link.target && link.target !== '_self') return;
  const target = new URL(link.href);
  if (target.origin !== location.origin || !sameBuild(target)) return;
  e.preventDefault();
  void navigate(target.href, { sourceElement: link });
});
