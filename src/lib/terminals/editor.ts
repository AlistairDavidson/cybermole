// Policy for the same-origin editor proxy (the transport is in server/main.ts).
// The editor's integrated terminal is a shell, so logout must cut its tunnels.

import { UPLOAD_MAX_BODY_BYTES } from '../../schemas/uploads';

/** Node regenerates these for the leg it owns. */
export const EDITOR_HOP_BY_HOP_HEADERS = [
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
] as const;

export type IncomingHeaders = Record<string, string | string[] | undefined>;

/** Strip hop-by-hop, then re-add the upgrade pair: without
 *  `Connection: Upgrade` the upstream sees a plain GET and never answers
 *  101. Host must pass through: the editor embeds it as remoteAuthority. */
export function editorUpgradeHeaders(incoming: IncomingHeaders): IncomingHeaders {
  const headers: IncomingHeaders = { ...incoming };
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- scrubbing the hop-by-hop header set
  for (const hop of EDITOR_HOP_BY_HOP_HEADERS) delete headers[hop];
  headers.connection = 'Upgrade';
  headers.upgrade =
    typeof incoming.upgrade === 'string' && incoming.upgrade !== ''
      ? incoming.upgrade
      : 'websocket';
  return headers;
}

/** null when CYBERMOLE_EDITOR_UPSTREAM is unset (editor off). */
export interface EditorUpstream {
  /** Origin only; request paths are forwarded verbatim. */
  origin: string;
}
/** `${BASE}/editor` and below; `/editorial` must not match. */
export function isEditorHttpPath(base: string, url: string): boolean {
  return url === basePath(base) || url.startsWith(basePath(base) + '/');
}

/** The browser dials `${BASE}/editor/stable-<commit>?reconnectionToken=…`. */
export function isEditorUpgradePath(base: string, url: string): boolean {
  return url.startsWith(basePath(base) + '/');
}

function basePath(base: string): string {
  return base === '/' ? '/editor' : base + '/editor';
}

/**
 * Set before writeHead, so they win over hardenResponse's defaults.
 * SAMEORIGIN: the console frames the editor. The CSP fits the VS Code web
 * workbench; marketplace queries go through the editor container, not the
 * browser, so connect-src leaves them out.
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

/** Editor HTTP POSTs (e.g. dropped uploads) are sized like uploads, not the JSON API's 10 KiB. */
export const EDITOR_MAX_BODY_BYTES = UPLOAD_MAX_BODY_BYTES;

/** The boot document is a few KiB; anything larger streams through untouched. */
export const EDITOR_HTML_REWRITE_MAX_BYTES = 262_144;

/** Injected into the workbench boot document so the editor follows the
 *  browser's color scheme. A ?theme= param or settings.json can't do it:
 *  the web workbench keeps window settings in IndexedDB, but honors
 *  configurationDefaults from its boot meta tag. Live re-theming on a
 *  scheme flip is unreliable, so the console reloads the pane instead.
 *  Users can still override these in the workbench. */
export const EDITOR_THEME_CONFIGURATION_DEFAULTS: Record<string, unknown> = {
  'window.autoDetectColorScheme': true,
  // Ids from this build's theme-defaults extension.
  'workbench.preferredDarkColorTheme': 'Dark 2026',
  'workbench.preferredLightColorTheme': 'Light 2026',
};

/** data-settings is HTML-attribute-escaped JSON. */
const WORKBENCH_CONFIG_META =
  /(<meta\s+id="vscode-workbench-web-configuration"\s+data-settings=")([^"]*)(")/;

const decodeAttribute = (value: string): string =>
  value
    .replaceAll('&quot;', '"')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&'); // last, or it would re-decode the entities above
const encodeAttribute = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

/** Anything unexpected (no meta tag, bad JSON) returns the input untouched:
 *  the editor still boots, just without following the scheme. */
export function injectWorkbenchThemeDefaults(html: string): string {
  const match = WORKBENCH_CONFIG_META.exec(html);
  const encoded = match?.[2];
  if (!match || encoded === undefined) return html;
  let config: Record<string, unknown>;
  try {
    config = JSON.parse(decodeAttribute(encoded)) as Record<string, unknown>;
  } catch {
    return html;
  }
  const existing = config.configurationDefaults;
  config.configurationDefaults = {
    ...(typeof existing === 'object' && existing !== null ? existing : {}),
    ...EDITOR_THEME_CONFIGURATION_DEFAULTS,
  };
  return (
    html.slice(0, match.index) +
    match[1] +
    encodeAttribute(JSON.stringify(config)) +
    match[3] +
    html.slice(match.index + match[0].length)
  );
}

/** Unlike other non-upload routes, never 411: chunked bodies are accepted
 *  and stall-guarded instead. */
export function editorBodyCapStatus(req: {
  method?: string | undefined;
  headers: Record<string, string | string[] | undefined>;
}): 413 | null {
  if (req.method === 'GET' || req.method === 'HEAD') return null;
  const declared = req.headers['content-length'];
  if (declared === undefined) return null;
  return Number(declared) <= EDITOR_MAX_BODY_BYTES ? null : 413;
}

/** Idempotent: closeToken may race a socket's own end. */
export type { TunnelHandle as EditorTunnelHandle } from '../platform/ws-tunnels';
export { TunnelTracker as EditorTunnelTracker } from '../platform/ws-tunnels';
