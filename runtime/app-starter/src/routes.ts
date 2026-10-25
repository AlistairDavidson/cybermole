// The route table: each action is one entry, and the kit binds it to the
// HTTP route, the islands' typed client, the MCP shim and
// dist/route-table.json. Add an action by adding an entry (plus its logic
// under src/lib, its UI and its test); `npm run check` is the gate.
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
