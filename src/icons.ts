// Points Web Awesome's icon libraries at our own public/icons/wa/ copies:
// the defaults fetch from the Font Awesome CDN (blocked by the CSP, and a
// usage leak) or from data: URLs (also blocked). registerIconLibrary()
// re-resolves icons already on the page, so load order doesn't matter.
import { registerIconLibrary } from '@awesome.me/webawesome/dist/components/icon/library.js';
import { BASE } from './base';

registerIconLibrary('default', {
  // Only classic/solid is used — the full ~2000-glyph free set, vendored
  // by tools/vendor-wa-icons.mjs (re-run it after bumping the package).
  resolver: (name: string) => `${BASE}/icons/wa/solid/${name}.svg`,
  mutator: (svg: SVGElement) => {
    // As stock: glyphs inherit text colour (the component never sets fill).
    if (!svg.hasAttribute('fill')) svg.setAttribute('fill', 'currentColor');
  },
});

registerIconLibrary('system', {
  // Unlike stock, there's no fallback chain for missing names; the vendored
  // set is complete, and the e2e glyph tests pin every live icon.
  resolver: (name: string, _family: string, variant = 'solid') =>
    `${BASE}/icons/wa/system/${variant}/${name}.svg`,
  mutator: (svg: SVGElement) => {
    if (!svg.hasAttribute('fill')) svg.setAttribute('fill', 'currentColor');
  },
});
