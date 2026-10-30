// Vendor the Web Awesome classic icon set in-project: wa-icon's stock
// default library fetches every glyph from the Font Awesome CDN
// (ka-f.fontawesome.com/releases/v<FA_VERSION>/svgs/solid/<name>.svg) — a
// third-party dependency the strict CSP blocks, and a usage leak besides.
// The @fortawesome/fontawesome-free devDependency pins the same release,
// and this script mirrors its whole svgs/solid set (~2000 glyphs — every
// classic/solid name) into public/icons/wa/solid/, where the local
// resolver in src/icons.ts serves it from the app itself. Each file keeps
// FA's license comment (icons: CC BY 4.0).
//
// Re-run after bumping the dependency: npm install && node tools/vendor-wa-icons.mjs
// (the destination is rebuilt from scratch, so it always mirrors the
// package exactly — re-added and removed names both land).
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import * as path from 'node:path';

const SRC = path.resolve('node_modules/@fortawesome/fontawesome-free/svgs/solid');
const DEST = path.resolve('public/icons/wa/solid');

if (!existsSync(SRC)) {
  throw new Error(
    `no ${SRC} — run npm install first (@fortawesome/fontawesome-free is a devDependency)`,
  );
}

rmSync(DEST, { recursive: true, force: true });
mkdirSync(DEST, { recursive: true });
cpSync(SRC, DEST, { recursive: true });

const count = readdirSync(DEST).filter(f => f.endsWith('.svg')).length;
console.log(`vendored ${count} classic/solid glyphs to public/icons/wa/solid/`);
