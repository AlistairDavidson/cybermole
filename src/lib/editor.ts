// editor.ts — the same-origin editor proxy's policy surface
// (docs/editor-webapp.md, docs/editor-spike.md). The proxy itself —
// streaming HTTP + raw WS piping — lives in server/main.ts next to the
// terminal's; everything that is a POLICY lives here so tests cover it
// without booting the server: which paths belong to the editor, the
// header set editor HTML carries, its body cap, and per-token tunnel
// tracking (logout / "log out everywhere" must cut editor shells too —
// the integrated terminal makes the editor another shell as uid 2000).

import type { SessionToken } from '../types/branded';
import { UPLOAD_MAX_BODY_BYTES } from '../schemas/uploads';

/** The editor webapp's upstream (readEditorUpstream in env.ts builds it
 *  from WEB_PI_EDITOR_UPSTREAM), or null when unset = editor off. */
export interface EditorUpstream {
  /** origin only, e.g. http://editor:3000 — never carries a path (the
   *  proxy forwards request paths verbatim under the app's base) */
  origin: string;
}

/** Does this request path belong to the editor proxy? `${BASE}/editor`
 *  and everything below it; `/editorial` must NOT match. */
export function isEditorHttpPath(base: string, url: string): boolean {
  return url === basePath(base) || url.startsWith(basePath(base) + '/');
}

/** The editor's WebSocket upgrades: the browser dials
 *  `${BASE}/editor/stable-<commit>?reconnectionToken=…` (pinned by the
 *  spike — same-origin under the base path; microsoft/vscode#208278's
 *  subpath breakage does not apply), so a prefix match, not equality. */
export function isEditorUpgradePath(base: string, url: string): boolean {
  return url.startsWith(basePath(base) + '/');
}

function basePath(base: string): string {
  return base === '/' ? '/editor' : base + '/editor';
}

/**
 * The header set editor HTML answers with. hardenResponse (server/main.ts)
 * only fills ABSENT headers, so setting these on the proxied response
 * before writeHead wins over the global SECURITY_HEADERS:
 * - `X-Frame-Options: SAMEORIGIN` overrides the global DENY — the console
 *   frames the editor in an iframe on the same origin.
 * - A CSP that fits the VS Code web workbench (pinned by the spike against
 *   a real browser; docs/editor-spike.md): blob/data workers and images,
 *   same-origin frames (the web-worker extension host iframe), and inline
 *   script/style for the boot HTML. connect-src deliberately does NOT
 *   include the extension marketplace (open-vsx.org): across four full
 *   workbench sessions the browser never fetched it directly — gallery
 *   queries ride the remote tunnel (the editor container's own egress) —
 *   and the two advisory fetches that ARE browser-side (extension-control
 *   and announcements, both raw.githubusercontent.com) degrade gracefully
 *   when refused. Flip them in here if host verification disagrees.
 */
export function editorSecurityHeaders(): Record<string, string> {
  return {
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data: blob:; font-src 'self' data:; worker-src 'self' blob:; " +
      "connect-src 'self' ws: wss:; frame-src 'self'; frame-ancestors 'self'",
    'X-Frame-Options': 'SAMEORIGIN',
  };
}

/** The largest body an editor request may carry. The workbench's saves
 *  travel its WebSocket, but its HTTP POSTs (uploads dropped onto the
 *  workbench, among others) are sized like a large editor save, not the
 *  JSON API's 10 KiB — the upload route's cap, the same one the adapter's
 *  global bodySizeLimit uses. */
export const EDITOR_MAX_BODY_BYTES = UPLOAD_MAX_BODY_BYTES;

/** Editor body-cap entry: 413 over the cap, and — unlike every other
 *  non-upload route — NEVER 411: a length-less (chunked) body is
 *  accepted, streamed to the upstream, and guarded by the stall watch
 *  instead of a whole-body deadline. */
export function editorBodyCapStatus(req: { method?: string | undefined; headers: Record<string, string | string[] | undefined> }): 413 | null {
  if (req.method === 'GET' || req.method === 'HEAD') return null;
  const declared = req.headers['content-length'];
  if (declared === undefined) return null; // chunked: accepted, stall-guarded
  return Number(declared) <= EDITOR_MAX_BODY_BYTES ? null : 413;
}

/** The surface logout/shutdown needs from a proxied editor WebSocket:
 *  cut both sides. Idempotent — closeToken may race a socket's own end. */
export interface EditorTunnelHandle {
  close(): void;
}

/** Live editor tunnels per session token. POST /logout, log-out-
 *  everywhere and shutdown must end the editor shells a token
 *  authenticated — not merely stop future requests — inside the same
 *  30-second guarantee the terminals keep (main.ts calls closeToken /
 *  closeAll from those paths). */
export class EditorTunnelTracker {
  private readonly byToken = new Map<SessionToken, Set<EditorTunnelHandle>>();

  track(token: SessionToken, handle: EditorTunnelHandle): void {
    let set = this.byToken.get(token);
    if (!set) { set = new Set(); this.byToken.set(token, set); }
    set.add(handle);
  }

  untrack(token: SessionToken, handle: EditorTunnelHandle): void {
    const set = this.byToken.get(token);
    if (!set) return;
    set.delete(handle);
    if (set.size === 0) this.byToken.delete(token);
  }

  /** Every tunnel authenticated with `token` — logout / token expiry. */
  closeToken(token: SessionToken): void {
    const set = this.byToken.get(token);
    if (!set) return;
    this.byToken.delete(token);
    for (const handle of set) handle.close();
  }

  /** Every tunnel, whichever token it used — log out everywhere, shutdown. */
  closeAll(): void {
    for (const set of this.byToken.values()) for (const handle of set) handle.close();
    this.byToken.clear();
  }

  /** Live tunnels (test/diagnostic surface). */
  count(): number {
    let n = 0;
    for (const set of this.byToken.values()) n += set.size;
    return n;
  }
}
