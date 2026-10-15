#!/usr/bin/env node
// tools/make-icons.mjs — generates public/icons/ (SVG source + PNG raster
// sizes) for the PWA manifest. Dependency-free: shapes are rasterized
// analytically (signed distance fields, 4×4 supersampling) and encoded as
// PNGs with node:zlib. Re-run after editing: node tools/make-icons.mjs
//
// Design: the web-pi prompt glyph — a ">_" chevron-and-underscore — on a
// rounded dark tile. Colors mirror the app's semantic tokens (the :root
// overrides in src/styles/console.css; accent is Web Awesome's default
// blue-60, the dark-theme --wa-color-focus).
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import path from 'node:path';

const OUT_DIR = path.join('public', 'icons');

// src/styles/console.css :root — keep in sync
const BG = '#11131a'; // --wa-color-surface-default
const BORDER = '#262a36'; // --wa-color-surface-border
// Web Awesome default palette blue-60 (#3e96ff) — dark-theme --wa-color-focus
const GLYPH = '#3e96ff';

const hex = h => [
  parseInt(h.slice(1, 3), 16),
  parseInt(h.slice(3, 5), 16),
  parseInt(h.slice(5, 7), 16),
];
const BG_RGB = hex(BG),
  BORDER_RGB = hex(BORDER),
  GLYPH_RGB = hex(GLYPH);

// Design space: 512×512. Tile is inset with a rounded-square mask (like an
// OS launcher); the glyph is a terminal prompt: chevron ">" + underscore.
const SIZE = 512;
const STROKE = 56; // glyph stroke width (round caps/joins)
const CHEVRON = [
  [168, 172],
  [252, 256],
  [168, 340],
];
const UNDERSCORE = [
  [292, 340],
  [376, 340],
];
const TILE = { inset: 16, radius: 112, border: 8 };

// ---- signed distance fields ----
const sdRoundRect = (x, y, hw, hh, r) => {
  const qx = Math.abs(x - SIZE / 2) - (hw - r);
  const qy = Math.abs(y - SIZE / 2) - (hh - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
};
const sdSegment = (x, y, [ax, ay], [bx, by]) => {
  const abx = bx - ax,
    aby = by - ay;
  const t = Math.max(0, Math.min(1, ((x - ax) * abx + (y - ay) * aby) / (abx * abx + aby * aby)));
  return Math.hypot(x - (ax + abx * t), y - (ay + aby * t));
};
const sdGlyph = (x, y) =>
  Math.min(
    sdSegment(x, y, CHEVRON[0], CHEVRON[1]),
    sdSegment(x, y, CHEVRON[1], CHEVRON[2]),
    sdSegment(x, y, UNDERSCORE[0], UNDERSCORE[1]),
  ) -
  STROKE / 2;

// ---- rasterizer: 4×4 supersampled coverage per pixel ----
function render(n, { maskable }) {
  const s = n / SIZE;
  const rgba = Buffer.alloc(n * n * 4);
  const SUB = [0.125, 0.375, 0.625, 0.875];
  for (let py = 0; py < n; py++) {
    for (let px = 0; px < n; px++) {
      let r = 0,
        g = 0,
        b = 0,
        a = 0;
      for (const dy of SUB) {
        for (const dx of SUB) {
          const x = (px + dx) / s,
            y = (py + dy) / s;
          // maskable: full-bleed square (launcher masks the edge itself,
          // glyph stays inside the 80% safe zone); any: rounded tile.
          const sdTile = maskable
            ? Math.max(x, y, SIZE - x, SIZE - y) * -1
            : sdRoundRect(x, y, SIZE / 2 - TILE.inset, SIZE / 2 - TILE.inset, TILE.radius);
          if (sdTile > 0) continue; // outside the tile: transparent
          a += 255 / 16;
          let c = BG_RGB;
          if (!maskable && sdTile > -TILE.border) c = BORDER_RGB;
          if (sdGlyph(x, y) <= 0) c = GLYPH_RGB;
          r += (c[0] * 255) / 16 / 255;
          g += (c[1] * 255) / 16 / 255;
          b += (c[2] * 255) / 16 / 255;
        }
      }
      const i = (py * n + px) * 4;
      rgba[i] = Math.round(r);
      rgba[i + 1] = Math.round(g);
      rgba[i + 2] = Math.round(b);
      rgba[i + 3] = Math.round(a);
    }
  }
  return rgba;
}

// ---- minimal PNG encoder (RGBA8, filter 0, zlib) ----
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = buf => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function pngChunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 8 + data.length);
  return out;
}
function encodePng(n, rgba) {
  const stride = n * 4;
  const raw = Buffer.alloc((stride + 1) * n);
  for (let y = 0; y < n; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(n, 0);
  ihdr.writeUInt32BE(n, 4);
  ihdr[8] = 8;
  ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- SVG source (the "any" tile design, same coordinates) ----
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}">
  <!-- web-pi: terminal prompt glyph. Colors mirror src/styles/console.css. -->
  <rect x="${TILE.inset}" y="${TILE.inset}" width="${SIZE - 2 * TILE.inset}" height="${SIZE - 2 * TILE.inset}"
    rx="${TILE.radius}" fill="${BG}" stroke="${BORDER}" stroke-width="${TILE.border}"/>
  <path d="M${CHEVRON.map(([x, y]) => `${x} ${y}`).join(' L')}" fill="none" stroke="${GLYPH}"
    stroke-width="${STROKE}" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M${UNDERSCORE.map(([x, y]) => `${x} ${y}`).join(' ')}" fill="none" stroke="${GLYPH}"
    stroke-width="${STROKE}" stroke-linecap="round"/>
</svg>
`;

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(path.join(OUT_DIR, 'icon.svg'), svg);
for (const n of [192, 512]) {
  writeFileSync(path.join(OUT_DIR, `icon-${n}.png`), encodePng(n, render(n, { maskable: false })));
  writeFileSync(
    path.join(OUT_DIR, `icon-maskable-${n}.png`),
    encodePng(n, render(n, { maskable: true })),
  );
}
console.log(`wrote icon.svg + PNGs (192/512, any + maskable) to ${OUT_DIR}/`);
