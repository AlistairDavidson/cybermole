#!/usr/bin/env node
// Generates public/icons/ from public/cybermole.svg — the app icon and the
// source of truth. Edit that file, then re-run: node tools/make-icons.mjs
// (rasterizes through the e2e Playwright chromium; no other dependencies).
//
// The mole art is strictly black-on-transparent with white accents, so each
// variant pairs it with the background it needs to stay readable:
//   icon-dark.svg                inverted (white) mole, transparent — dark-scheme favicon
//   icon-{192,512}.png           black mole on a white rounded tile, transparent corners ("any")
//   icon-maskable-{192,512}.png  inverted mole on the dark surface, full bleed ("maskable";
//                                also the apple-touch-icon, which must be opaque)
// Light contexts get the black art, dark contexts its inversion — the palette
// is only ever #000/#fff, so both read at any size.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT_DIR = path.join(ROOT, 'public', 'icons');
const SIZE = 512;
// Web Awesome's default dark --wa-color-surface-default (neutral-05); keep in
// sync with THEME_COLOR_DARK in src/layouts/Base.astro.
const DARK = '#101219';

const src = readFileSync(path.join(ROOT, 'public', 'cybermole.svg'), 'utf8');
const art = /<g\b[\s\S]*<\/g>/.exec(src)?.[0];
if (!art) throw new Error(`no art group <g>…</g> in public/cybermole.svg`);

// The icon's palette is exactly black and white; inversion is the swap.
const inverted = art.replaceAll(/#000000|#ffffff/g, c => (c === '#000000' ? '#ffffff' : '#000000'));

const svg = body =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}">${body}</svg>`;

// "any": the tile guarantees contrast on any launcher; corners stay transparent.
const anySvg = svg(`<rect x="8" y="8" width="496" height="496" rx="104" fill="#ffffff"/>${art}`);
// maskable: full bleed (the launcher masks the edges; the paws grazing the
// bottom edge are the design) — dark surface, so the white art carries it.
const maskableSvg = svg(`<rect width="512" height="512" fill="${DARK}"/>${inverted}`);

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(path.join(OUT_DIR, 'icon-dark.svg'), svg(inverted));

// Rasterize: an exact n×n element screenshot, transparent outside the art.
const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    viewport: { width: SIZE, height: SIZE },
    deviceScaleFactor: 1,
  });
  async function raster(source, n, file) {
    await page.setContent(
      `<body style="margin:0">${source.replace('<svg ', `<svg width="${n}" height="${n}" `)}`,
    );
    await page.locator('svg').screenshot({
      path: path.join(OUT_DIR, file),
      omitBackground: true,
    });
  }
  for (const n of [192, 512]) {
    await raster(anySvg, n, `icon-${n}.png`);
    await raster(maskableSvg, n, `icon-maskable-${n}.png`);
  }
} finally {
  await browser.close();
}
console.log('wrote icon-dark.svg + PNGs (192/512, any + maskable) to public/icons/');
