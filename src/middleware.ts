// The API and partials only run inside the cybermole server, which passes
// services in locals after its auth checks. Without them (`astro dev`, or the
// handler run on its own) they answer 503 rather than run unauthenticated.
import { defineMiddleware } from 'astro:middleware';
import { jsonResponse } from '@cybermole/app-kit';

const base = import.meta.env.BASE_URL.replace(/\/+$/, '');
const GUARDED = [`${base}/api/`, `${base}/partials/`];

export const onRequest = defineMiddleware((context, next) => {
  const guarded = GUARDED.some(prefix => context.url.pathname.startsWith(prefix));
  if (guarded && (!context.locals.cybermole || !context.locals.session)) {
    return jsonResponse(
      {
        error: 'this route only runs inside the cybermole server (server/main.ts)',
        code: 'api_unavailable',
      },
      503,
    );
  }
  return next();
});
