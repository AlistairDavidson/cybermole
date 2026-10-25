// VERBATIM copy of @awesome.me/astro-lit's server-shim.js except the
// define-patch at the bottom (see there), with the 'lit-element' import
// resolution-aliased at build (→ this tree's node_modules links, so it
// inlines). If a future @awesome.me/astro-lit ships a bundleable
// renderer, this copy can go.
import { customElements as litCE, HTMLElement as litShimHTMLElement } from '@lit-labs/ssr-dom-shim';

// Something at build time injects document.currentScript = undefined instead of
// document.currentScript = null. This causes Sass build to fail because it
// seems to be expecting `=== null`. This set to `undefined` doesn't seem to
// be caused by Lit and only happens at build / test time, but not in dev or
// preview time.
if (globalThis.document) {
  document.currentScript = null;
}

if (globalThis.HTMLElement) {
  // Seems Astro's Element shim does nothing when `.setAttribute` is called
  // and subsequently `.getAttribute` is called. Causes Lit to not SSR attrs
  globalThis.HTMLElement = litShimHTMLElement;
}

// Astro seems to have a DOM shim and the only real difference that we need out
// of the Lit DOM shim is that the Lit DOM shim reads
// `HTMLElement.observedAttributes` which is meant to trigger
// `ReactiveElement.finalize()`. So this is the only thing we will re-shim since
// Lit will try to respect other global DOM shims.
globalThis.customElements = litCE;

// Reload tolerance (THIS file's one divergence from upstream): the app
// host re-imports a rebuilt app under a cache-busted URL, and the new
// module instances re-run their module-level customElements.define calls
// against this process's ONE registry — a duplicate name would throw and
// make every rebuild+reload of a wa-* app fail. Patch once (a re-imported
// shim must not wrap the previous instance's wrapper) and make the patch
// idempotent: re-defining an already-registered name (the shared stack,
// rebuilt byte-identically) keeps the registered definition and is a
// no-op.
const PATCHED = Symbol.for('@awesome.me/astro-lit/server-shim:define-patched');
if (customElements.define[PATCHED] !== true) {
  const litCeDefine = customElements.define;
  const patched = function (tagName, Ctr) {
    // Keep track of the tagName on the class itself so that we can
    // transform JSX custom element class definition to a DSD string on
    // the server, because there is no way to get the tagName from a CE
    // class otherwise (upstream's reason for this patch).
    Ctr[Symbol.for('tagName')] = tagName;
    if (customElements.get(tagName) !== undefined) return;
    return litCeDefine.call(this, tagName, Ctr);
  };
  Object.defineProperty(patched, PATCHED, { value: true });
  customElements.define = patched;
}
