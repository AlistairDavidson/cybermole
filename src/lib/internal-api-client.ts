// internal-api-client.ts — the reusable HTTP-over-unix-socket client for
// the internal API (server/internal-api.ts): one request per call, a
// one-shot socket (agent: false), Content-Length on every body — the
// API's 411 body policy demands a declared length, and never letting
// node stream it chunked is this client's side of that contract.
//
// Generalized from the local client inside server/mcp.ts (the jobs MCP)
// so every internal-API consumer shares one transport: server/app-host.ts
// (the app host's discovery call, GET /apps) is the first; mcp.ts keeps
// its private copy for now and can adopt this module at a later merge
// (apps-plan §5 lists it as kit-bound too). Rejects on TRANSPORT failure
// only (ECONNREFUSED/ENOENT: nothing answering on the file, a reset
// mid-response, a timeout) — the caller turns that into its own error
// story; a domain failure arrives as a normal answer with its status.
import * as http from 'node:http';

/** One request to the internal API: method + request path (params
 *  already interpolated, percent-encoded) and, for the body verbs, a
 *  PRE-SENT body string — sent with a Content-Length header, always. */
export interface InternalApiCall {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  body?: string;
}

/** The internal API's answer: the wire body verbatim (JSON, except the
 *  log route's plain text) plus the status and headers it came with. */
export interface InternalApiAnswer {
  status: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}

export interface InternalApiCallOptions {
  /** Cut the request off after this many ms (the socket destroyed, the
   *  promise rejected) — a listener that accepted but never answers must
   *  not hang the caller. Undefined: no timeout (mcp.ts's semantics). */
  timeoutMs?: number;
}

/** One HTTP request over the internal API's unix socket. `agent: false`
 *  keeps the process holding nothing open between calls. */
export function requestInternalApi(
  socketPath: string,
  call: InternalApiCall,
  options: InternalApiCallOptions = {},
): Promise<InternalApiAnswer> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (call.body !== undefined) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(Buffer.byteLength(call.body, 'utf8'));
    }
    const req = http.request(
      { socketPath, method: call.method, path: call.path, headers, agent: false },
      res => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('error', reject);
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
            headers: res.headers,
          }),
        );
      },
    );
    req.on('error', reject);
    if (options.timeoutMs !== undefined) {
      req.setTimeout(options.timeoutMs, () => {
        req.destroy(new Error(`internal API request timed out after ${options.timeoutMs}ms`));
      });
    }
    if (call.body === undefined) req.end();
    else req.end(call.body);
  });
}
