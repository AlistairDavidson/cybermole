// Writes dist/route-table.json at build time. Kept apart so route-table.ts
// stays node-free for the browser.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { serializeRouteTable, type RouteTable } from './route-table';

/** `base` (the app's baked URL base) rides the table so the app host can
 *  verify the build matches the console it serves — a mismatch is a skip
 *  with a "rebuild" reason, not a mysterious 404. Without it the legacy
 *  bare-array shape is written, which readers still accept. */
export function writeRouteTable(table: RouteTable, out: string, base?: string): void {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const body =
    base === undefined ? serializeRouteTable(table) : { base, actions: serializeRouteTable(table) };
  fs.writeFileSync(out, `${JSON.stringify(body, null, 2)}\n`);
}

/** Copies <appRoot>/src/ws.mjs, when present, to <appRoot>/dist/server/ws.mjs
 *  — the app host's optional WS entry (the app-starter README's § WebSocket
 *  routes). A no-op without src/ws.mjs, so every app can wire the hook. */
export function writeWsEntry(appRoot: string): void {
  const src = path.join(appRoot, 'src', 'ws.mjs');
  if (!fs.existsSync(src)) return;
  const dest = path.join(appRoot, 'dist', 'server', 'ws.mjs');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}
