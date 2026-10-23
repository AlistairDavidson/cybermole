// Client-side URL base — Vite bakes in Astro's `base` at build time.
// Must match the server's CYBERMOLE_BASE ('' for root, else '/foo' with no
// trailing slash). The cast keeps this compiling wherever it's included.
const raw = (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/';
export const BASE: string = raw.replace(/\/+$/, '');
