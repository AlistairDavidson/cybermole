// THE route table — this app's single source of truth (apps-plan §2/§5):
// every action is ONE entry here, and the kit's binder gives it every
// face at once — the HTTP route (src/pages/api/[...path].ts), the typed
// client the UI uses (src/islands), the MCP shim's tools and
// dist/route-table.json (describe/call) — same Result JSON everywhere.
// Add an action by adding an entry (and its logic under src/lib, its UI,
// its test); `npm run check` stays the gate.
import { z } from 'zod';
import { defineRoute, type RouteTable } from '@cybermole/app-kit/route-table';
import { pingResult } from './lib/ping';

export const routes: RouteTable = [
  defineRoute({
    name: 'ping',
    description: 'answers a hello — the scaffolded example action, wired end to end',
    method: 'GET',
    path: '/api/ping',
    params: z.object({}),
    query: z.object({
      name: z
        .string()
        .trim()
        .min(1, 'name is required')
        .max(64, 'name is too long (max 64 chars)'),
    }),
    errorStatus: { invalid_name: 400 },
    handler: ({ query }) => pingResult(query.name),
  }),
];
