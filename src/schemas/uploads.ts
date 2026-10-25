// Upload policy for POST /api/files, node-free so pages can reuse it.

/** Uploads stream to storage, so this is policy, not memory. nginx's
 *  client_max_body_size must allow UPLOAD_MAX_BODY_BYTES. */
export const UPLOAD_MAX_FILE_BYTES = 5 * 1024 * 1024 * 1024;

/** The file plus its multipart envelope. Used by both the adapter's
 *  bodySizeLimit and main.ts's per-route cap. */
export const UPLOAD_MAX_BODY_BYTES = UPLOAD_MAX_FILE_BYTES + 1024 * 1024;

/** As declared by the browser (not sniffed). Only types inert if rendered:
 *  no HTML, no SVG. Downloads serve anything else as octet-stream. */
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
