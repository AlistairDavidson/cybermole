// Vite bakes in Astro's `base`; must match CYBERMOLE_BASE ('' for root).
const raw = (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/';
export const BASE: string = raw.replace(/\/+$/, '');
