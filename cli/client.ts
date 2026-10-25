// The CLI's transport: node:http over the internal API's unix socket. Every
// request with a body declares its exact Content-Length, since the API
// answers 411 to chunked bodies.
import * as http from 'node:http';
import { readInternalApiSocket } from '../src/lib/platform/env';
import type { ApiResponse } from './output';

export type { ApiResponse };

/** The socket is missing, dead, or not ours to open. The message names
 *  CYBERMOLE_SOCK, the one knob an operator can change. */
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

/** env.ts's resolution, never a second heuristic. An empty CYBERMOLE_SOCK
 *  (listener off) or a bad value becomes a friendly message, not a stack trace. */
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

/** `body` is the exact JSON string. Rejects with SocketUnavailableError on
 *  connect-phase failures; anything else rejects with its own Error. */
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
      headers['content-length'] = String(payload.byteLength);
    }
    const req = http.request(
      // No keep-alive: a pooled socket kept across a server restart would EPIPE.
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
