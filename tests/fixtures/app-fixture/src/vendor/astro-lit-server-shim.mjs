// Vendored copy of @awesome.me/astro-lit's server-shim.js, except the
// define-patch at the bottom. 'lit-element' is aliased at build so it inlines.
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

// The one divergence from upstream: the app host re-imports a rebuilt app,
// re-running its customElements.define calls against the one registry, and a
// duplicate name would throw. Patch once, and make re-defining a registered
// name a no-op.
const PATCHED = Symbol.for('@awesome.me/astro-lit/server-shim:define-patched');
if (customElements.define[PATCHED] !== true) {
  const litCeDefine = customElements.define;
  const patched = function (tagName, Ctr) {
    // Upstream's reason for patching: there's no other way to get a CE
    // class's tagName when rendering it to a DSD string.
    Ctr[Symbol.for('tagName')] = tagName;
    if (customElements.get(tagName) !== undefined) return;
    return litCeDefine.call(this, tagName, Ctr);
  };
  Object.defineProperty(patched, PATCHED, { value: true });
  customElements.define = patched;
}
