// app-mcp-shim.ts — the app's own MCP (task/app-actions,
// docs/plans/apps-plan.md §6): stdio to pi, HTTP to the host socket. One stdio
// server per app tree, registered under the app's slug by the tree's
// .pi/mcp.json (the scaffold bakes the entry: `node
// <install>/dist-server/server/app-mcp-shim.js <slug>` — this file is
// that binary). Tools are 1:1 with the app's route table, read from the
// tree's dist/route-table.json at boot (the build's emitted table — the
// same artifact describe/call read; a rebuilt app needs a session
// restart for new tools, the same restart pi itself needs); tool names
// are the table's names, prefix-free — the app's slug in the MCP
// registration IS the namespace.
//
// Every tool call is THE request the entry names (plan §3: no parallel
// RPC to invent or let drift): method + path against the apps socket
// (CYBERMOLE_APPS_SOCK — the env rules verbatim; empty = the apps
// surface is off, answered as a clear isError), base path
// /apps/<slug> baked in like every face. Results are the app's Result
// JSON VERBATIM — a domain failure (ok:false, errorCode) is a normal
// result the model must read; the only isError results are TRANSPORT
// failures (the socket unreachable, the surface off — no answer at all).
//
// stdout is the protocol channel: this process logs NOTHING (the apps
// MCP's rule); boot-time diagnostics go to stderr, and a boot that
// cannot succeed (no slug, a bad env, no built table) exits 1 so pi
// shows the failure instead of a silent no-tool server.
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
  'must turn the socket on (apps-plan §3)';

const unreachable = (sock: string, code: string | undefined, message: string): string =>
  `could not reach the app host at ${sock} ${code ? `(${code})` : `: ${message}`} ` +
  "— is the app host running (the console's serving badge), and is this app registered + built?";

export interface AppShimDeps {
  /** the app this shim fronts (its baked base and its namespace) */
  slug: string;
  /** the emitted route table — THE tool list (1:1, table order) */
  table: SerializedAction[];
  /** env.ts readAppsSocket — null = the apps surface is off (every call
   *  answers the clear error; the server still boots). */
  appsSocketPath: string | null;
  /** the socket call, injectable for tests */
  request?: typeof requestInternalApi;
  /** per-call timeout. Default 30 s. */
  timeoutMs?: number;
}

/** Build the stdio MCP server: one tool per table entry. The tool's
 *  inputSchema is built from the emitted input (typed as far as the
 *  kit's JSON-schema subset goes, coercive where the app coerces — the
 *  shim must never be stricter than the app it fronts). */
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
          // A local, lenient preflight failure — the app was never called.
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
        // The app's answer, byte for byte — its Result JSON (or its own
        // failure JSON on a non-200): a normal result, never isError.
        return json(parseOrRaw(answer.body));
      },
    );
  }
  return server;
}

// ---------- the entry ----------

/** Resolve the slug's tree + the sockets and serve over stdio. argv is
 *  the argument list after the binary (`app-mcp-shim.js <slug>`); a
 *  missing slug, a bad env, or no built table is stderr + exit 1 — the
 *  stop-the-boot stance (pi shows the failed server instead of a silent
 *  empty one). Returns when the transport closes (the client closing
 *  stdin — how pi stops stdio servers). */
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

// The self-exec guard in the CommonJS build's terms (the compiled
// `import.meta.url === argv[1]` idiom — the server build emits CJS; see
// server/mcp.ts's note). This file is both the importable module (units)
// and the runnable entry the tree's .pi/mcp.json registers.
if (require.main === module) {
  main(process.argv.slice(2)).catch(err => {
    console.error(`cybermole app-mcp-shim: ${(err as Error).stack ?? err}`);
    process.exitCode = 1;
  });
}
