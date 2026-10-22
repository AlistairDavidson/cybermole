// locals.ts — narrows Astro.locals for an API route or page that needs the
// web-pi services (the soothing-booking assertTenantLocals pattern).
// src/middleware.ts has already answered 503 for /api/* and /partials/*
// without them, and the data pages (settings, jobs) call this
// from their frontmatter — so a miss here is a broken invariant (a bug),
// not a state to render around: it throws. Type-only imports: safe for
// the Astro bundle (see services.ts).
import type { WebPiLocals, WebPiServices } from '../services';
import type { SessionToken } from '../../types/branded';

export function assertWebPiLocals(locals: WebPiLocals): {
  webpi: WebPiServices;
  session: SessionToken;
} {
  if (!locals.webpi || !locals.session) {
    throw new Error(
      'Expected web-pi services in locals — check src/middleware.ts and server/main.ts' +
        ' (in dev, astro dev renders pages without them: browse the npm run dev:server process instead)',
    );
  }
  return { webpi: locals.webpi, session: locals.session };
}
