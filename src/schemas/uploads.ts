// uploads.ts — the upload policy POST /api/files enforces. Node-free, so a
// page can reuse it (an <input accept>, a size check before sending).

/** Uploads stream to storage (src/lib/web/parsing.service.ts
 *  streamFileUpload → src/lib/storage.ts), so this is a policy choice, not
 *  a memory one. Behind nginx, client_max_body_size must allow
 *  UPLOAD_MAX_BODY_BYTES (deploy/nginx-cybermole.conf). */
export const UPLOAD_MAX_FILE_BYTES = 5 * 1024 * 1024 * 1024;

/** The whole multipart body: the file plus its envelope (boundary lines,
 *  part headers, the few small fields the parser tolerates).
 *  astro.config.mjs's adapter bodySizeLimit and server/main.ts's per-route
 *  body cap both use it — the only route allowed past the JSON API's 10 KiB. */
export const UPLOAD_MAX_BODY_BYTES = UPLOAD_MAX_FILE_BYTES + 1024 * 1024;

/** The type the browser declares (its guess from the file name — not
 *  sniffed). Kept to types that are inert if ever rendered: no HTML, no
 *  SVG. The download route also serves anything else as
 *  application/octet-stream. */
export const UPLOAD_ALLOWED_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
  'text/plain',
  'text/csv',
  'text/markdown',
  'application/json',
] as const;
