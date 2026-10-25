// One app's own MCP server (stdio), registered under the app's slug by its
// tree's .pi/mcp.json. Tools are 1:1 with dist/route-table.json, read at
// boot, so new actions need a session restart. Each call is the request the
// table entry names, sent to the app host; results are the app's JSON
// verbatim, and isError is reserved for transport failures.
//
// stdout is the protocol channel. A boot that can't succeed exits 1 so pi
// shows a failed server rather than an empty one.
import * as path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { readAppsRoot, readAppsSocket } from '../src/lib/platform/env';
import {
  requestInternalApi,
  type InternalApiAnswer,
  type InternalApiCall,
} from '../src/lib/platform/internal-api-client';
import {
  planActionRequest,
  readRouteTable,
  shapeFromJsonSchema,
  type SerializedAction,
} from '../src/lib/apps/apps-route-table';

const json = (body: unknown): CallToolResult => ({
  content: [
    { type: 'text', text: typeof body === 'string' ? body : JSON.stringify(body, null, 2) },
  ],
});

const transportError = (why: string): CallToolResult => ({
  content: [{ type: 'text', text: why }],
  isError: true,
});

function parseOrRaw(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

const APPS_OFF =
  'the apps surface is off (CYBERMOLE_APPS_SOCK is empty on this cybermole instance) ' +
  "— the app host is not listening, so this app's actions cannot run; the operator " +
  'must turn the socket on';

const unreachable = (sock: string, code: string | undefined, message: string): string =>
  `could not reach the app host at ${sock} ${code ? `(${code})` : `: ${message}`} ` +
  "— is the app host running (the console's serving badge), and is this app registered + built?";

export interface AppShimDeps {
  slug: string;
  table: SerializedAction[];
  /** null: apps surface off (calls answer an error; the server still boots). */
  appsSocketPath: string | null;
  request?: typeof requestInternalApi;
  /** per-call timeout. Default 30 s. */
  timeoutMs?: number;
}

/** The shim must never be stricter than the app it fronts. */
export function createAppShimServer(deps: AppShimDeps): McpServer {
  const server = new McpServer({ name: `cybermole-app-${deps.slug}`, version: '0.1.0' });
  for (const entry of deps.table) {
    server.registerTool(
      entry.name,
      {
        description: `${entry.description} — ${entry.method} /apps/${deps.slug}${entry.path} (this app's action; the answer is its Result JSON)`,
        inputSchema: shapeFromJsonSchema(entry.input),
      },
      async (params): Promise<CallToolResult> => {
        const planned = planActionRequest(deps.slug, entry, params);
        if (!planned.ok) {
          // Lenient local preflight; the app was never called.
          return json({
            ok: false,
            resultType: 'call_action',
            errorCode: 'invalid_params',
            errorMessage: planned.errorMessage,
            ...(planned.issues ? { issues: planned.issues } : {}),
          });
        }
        if (deps.appsSocketPath === null) return transportError(APPS_OFF);
        const call: InternalApiCall = {
          method: planned.request.method as InternalApiCall['method'],
          path: `${planned.request.pathname}${planned.request.search ? `?${planned.request.search}` : ''}`,
          ...(planned.request.body !== undefined ? { body: planned.request.body } : {}),
        };
        let answer: InternalApiAnswer;
        try {
          answer = await (deps.request ?? requestInternalApi)(deps.appsSocketPath, call, {
            timeoutMs: deps.timeoutMs ?? 30_000,
          });
        } catch (err) {
          const e = err as NodeJS.ErrnoException;
          return transportError(unreachable(deps.appsSocketPath!, e.code, e.message));
        }
        // Non-200 bodies are the app's own failure JSON: a normal result.
        return json(parseOrRaw(answer.body));
      },
    );
  }
  return server;
}

// ---------- entry ----------

/** argv: `<slug>`. */
export async function main(argv: string[]): Promise<void> {
  const slug = argv[0];
  if (slug === undefined || slug.trim() === '') {
    console.error(
      'cybermole app-mcp-shim: usage: app-mcp-shim.js <slug> — the app whose actions this serves',
    );
    process.exitCode = 1;
    return;
  }
  let appsRoot: string;
  let appsSocketPath: string | null;
  try {
    appsRoot = readAppsRoot();
    appsSocketPath = readAppsSocket();
  } catch (err) {
    console.error(`cybermole app-mcp-shim: ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }
  const read = readRouteTable(path.join(appsRoot, slug));
  if (!read.ok) {
    console.error(`cybermole app-mcp-shim (${slug}): ${read.errorMessage}`);
    process.exitCode = 1;
    return;
  }
  const server = createAppShimServer({ slug, table: read.table, appsSocketPath });
  await server.connect(new StdioServerTransport());
}

// The CJS build's self-exec guard: this file is both a module and an entry.
if (require.main === module) {
  main(process.argv.slice(2)).catch(err => {
    console.error(`cybermole app-mcp-shim: ${(err as Error).stack ?? err}`);
    process.exitCode = 1;
  });
}
