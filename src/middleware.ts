// middleware.ts — fail closed for the data routes. The JSON API
// (/api/*) and the server-rendered partials (/partials/*) only ever run
// inside the web-pi server: server/main.ts checks the origin and the
// session BEFORE handing a request to Astro, and passes the services in
// locals only on that authenticated path. Without them — `astro dev`
// serving a route itself, or the Astro handler run on its own — these
// routes answer 503 instead of running unauthenticated
// (docs/CODE_STYLE.md §6). Pages carry no data of their own without
// locals, so they render normally.
import { defineMiddleware } from 'astro:middleware';
import { jsonResponse } from './lib/web/responses.service';

const base = import.meta.env.BASE_URL.replace(/\/+$/, '');
const GUARDED = [`${base}/api/`, `${base}/partials/`];

export const onRequest = defineMiddleware((context, next) => {
  const guarded = GUARDED.some(prefix => context.url.pathname.startsWith(prefix));
  if (guarded && (!context.locals.webpi || !context.locals.session)) {
    return jsonResponse(
      {
        error: 'this route only runs inside the web-pi server (server/main.ts)',
        code: 'api_unavailable',
      },
      503,
    );
  }
  return next();
});
