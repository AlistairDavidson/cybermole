// route-table-emit.ts — the build half of the route-table binder: write
// dist/route-table.json (the serialized table — name, method, path, input
// schema, description) for the describe/call tools and the app's MCP shim
// (docs/plans/apps-plan.md §5/§6). An app's build script imports the table and
// calls this with its dist/ path; the core faces stay node-free in
// route-table.ts so islands can import the client.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { serializeRouteTable, type RouteTable } from './route-table';

/** Serialize `table` to `out` (pretty JSON, trailing newline; the dir is
 *  created). The app's build runs this after astro build. */
export function writeRouteTable(table: RouteTable, out: string): void {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(serializeRouteTable(table), null, 2)}\n`);
}
