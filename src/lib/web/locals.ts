// Middleware has already answered 503 for /api/* and /partials/* without the
// services, so a miss here is a bug: it throws rather than render around it.
import type { CybermoleLocals, CybermoleServices } from '../platform/services';
import type { SessionToken } from '@cybermole/app-kit';

export function assertCybermoleLocals(locals: CybermoleLocals): {
  cybermole: CybermoleServices;
  session: SessionToken;
} {
  if (!locals.cybermole || !locals.session) {
    throw new Error(
      'Expected cybermole services in locals — check src/middleware.ts and server/main.ts' +
        ' (in dev, astro dev renders pages without them: browse the npm run dev:server process instead)',
    );
  }
  return { cybermole: locals.cybermole, session: locals.session };
}
