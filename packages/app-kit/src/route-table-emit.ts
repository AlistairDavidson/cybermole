// Writes dist/route-table.json at build time. Kept apart so route-table.ts
// stays node-free for islands.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { serializeRouteTable, type RouteTable } from './route-table';

export function writeRouteTable(table: RouteTable, out: string): void {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(serializeRouteTable(table), null, 2)}\n`);
}
