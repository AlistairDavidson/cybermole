// HTTP over the internal API's (or app host's) unix socket. Rejects only on
// transport failure; a domain failure is a normal answer with its status.
import * as http from 'node:http';

/** A present body is always sent with Content-Length: the APIs answer 411 to chunked bodies. */
export interface InternalApiCall {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  path: string;
  body?: string;
}

export interface InternalApiAnswer {
  status: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}

export interface InternalApiCallOptions {
  /** A listener that accepts but never answers must not hang the caller. Default: none. */
  timeoutMs?: number;
}

/** `agent: false`: nothing stays open between calls. */
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
