// client.ts — the CLI's transport over the internal API's unix socket
// (task/jobs-cli, docs/jobs-agent-plan.md §5). Zero new runtime deps:
// node:http with socketPath. Deliberately standalone and verb-free —
// one request function, one response shape, one unreachable-socket
// error — so the MCP server (plan §6) reuses this layer verbatim.
//
// Content-Length discipline: the internal API (server/internal-api.ts)
// refuses a body-carrying request with no declared length (411, its
// chunked-body stance). Every request that HAS a body here declares its
// exact byte length up front; bodyless requests (GET, and the bodyless
// POSTs `run`/`kill` send — Node frames those Content-Length: 0) never
// leave chunked framing on by accident. tests/unit/cli.test.mjs asserts
// the header at the wire level.
import * as http from 'node:http';
import { readInternalApiSocket } from '../src/lib/env';
import type { ApiResponse } from './output';

export type { ApiResponse };

/** No server answers on the socket — the file is missing, the server is
 *  down, or this user may not open it. Message names the CYBERMOLE_SOCK
 *  knob: it is the one thing an operator can point elsewhere. */
export class SocketUnavailableError extends Error {
  constructor(
    readonly socketPath: string,
    readonly errnoCode: string,
  ) {
    const why =
      errnoCode === 'EACCES'
        ? "this user may not open it — in the compose split the socket file's group grants access"
        : 'no cybermole server is listening there';
    super(
      `cannot reach the internal API at ${socketPath} (${errnoCode}) — ${why}. ` +
        'The CLI reaches the server over its internal unix socket: set CYBERMOLE_SOCK ' +
        '(absolute path) if it lives elsewhere, or check that the web server is running.',
    );
    this.name = 'SocketUnavailableError';
  }
}

export type SocketDiscovery = { ok: true; socketPath: string } | { ok: false; message: string };

/** Where the CLI finds the internal socket: env.ts's one resolution
 *  (readInternalApiSocket — $CYBERMOLE_SOCK, then /run/cybermole/cybermole.sock
 *  when the shared dir exists, else <state dir>/cybermole.sock). Never a
 *  second heuristic here (plan §5: import it, don't duplicate it). The
 *  two no-socket cases both become a friendly message: CYBERMOLE_SOCK
 *  empty = the listener is off (plan §3), and a set-but-non-absolute
 *  value is env.ts's own boot-time error, surfaced as text instead of
 *  a stack trace. */
export function discoverInternalSocket(): SocketDiscovery {
  let resolved: string | null;
  try {
    resolved = readInternalApiSocket();
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
  if (resolved === null) {
    return {
      ok: false,
      message:
        'the internal API is disabled on this server (CYBERMOLE_SOCK is empty) — ' +
        'the CLI has nothing to talk to',
    };
  }
  return { ok: true, socketPath: resolved };
}

const REQUEST_TIMEOUT_MS = 20_000;

/** One request over the socket. `body` (when given) is the exact request
 *  body string — callers JSON.stringify; this layer sets the headers.
 *  Rejects with SocketUnavailableError for connect-phase failures
 *  (missing/dead socket, permission denied); anything else (a timeout,
 *  a socket dropped mid-answer) rejects with its own Error and the
 *  dispatcher prints it the same way. */
export function internalRequest(
  socketPath: string,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  urlPath: string,
  body?: string,
): Promise<ApiResponse> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(body, 'utf8');
    const headers: Record<string, string> = {};
    if (payload !== null) {
      headers['content-type'] = 'application/json';
      // the 411 discipline: a body-carrying request declares its length
      headers['content-length'] = String(payload.byteLength);
    }
    const req = http.request(
      // agent: false — no keep-alive pooling: a CLI process makes one
      // request and exits, and a pooled socket (kept alive across a
      // server restart on the same path) is a stale-socket EPIPE waiting
      // to happen. Connection-per-request, closed with the response.
      { socketPath, method, path: urlPath, headers, timeout: REQUEST_TIMEOUT_MS, agent: false },
      res => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('error', err => reject(err)); // client died mid-answer
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            text: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.on('timeout', () => {
      req.destroy(
        new Error(
          `no answer from ${socketPath} within ${REQUEST_TIMEOUT_MS / 1000}s — ` +
            'is the web server healthy?',
        ),
      );
    });
    req.on('error', err => {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ECONNREFUSED' || code === 'ENOENT' || code === 'EACCES') {
        reject(new SocketUnavailableError(socketPath, code));
      } else reject(err);
    });
    if (payload === null) req.end();
    else req.end(payload);
  });
}
