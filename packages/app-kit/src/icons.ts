// Points Web Awesome's icon libraries at the console's vendored copies under
// `${base}/icons/`: the defaults fetch from the Font Awesome CDN (blocked by
// the CSP, and a usage leak) or from data: URLs (also blocked). Apps share
// the console's origin, so they resolve the same files with the console's
// base. registerIconLibrary() re-resolves icons already on the page, so load
// order doesn't matter.
import { registerIconLibrary } from '@awesome.me/webawesome/dist/components/icon/library.js';

/** As stock: glyphs inherit text colour (the component never sets fill). */
function currentColor(svg: SVGElement): void {
  if (!svg.hasAttribute('fill')) svg.setAttribute('fill', 'currentColor');
}

/** `base`: the console's base path, '' at the site root. */
export function registerCybermoleIcons(base: string): void {
  // Only classic/solid is used — the full ~2000-glyph free set, vendored by
  // tools/vendor-wa-icons.mjs (re-run it after bumping the package).
  registerIconLibrary('default', {
    resolver: (name: string) => `${base}/icons/wa/solid/${name}.svg`,
    mutator: currentColor,
  });
  // Unlike stock, there's no fallback chain for missing names; the vendored
  // set is complete, and the e2e glyph tests pin every live icon.
  registerIconLibrary('system', {
    resolver: (name: string, _family: string, variant = 'solid') =>
      `${base}/icons/wa/system/${variant}/${name}.svg`,
    mutator: currentColor,
  });
  // The product's own glyphs (public/icons/brand/), drawn in currentColor so
  // they take the text colour — the header's brand link highlights like its
  // sibling icons.
  registerIconLibrary('brand', {
    resolver: (name: string) => `${base}/icons/brand/${name}.svg`,
  });
}
