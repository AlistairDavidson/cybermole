// The console's state read (the event-driven refresh's loadState). Also
// re-arms the cookie's Max-Age when due (auth.cookieRefresh).
import type { APIRoute } from 'astro';
import { assertCybermoleLocals } from '../../lib/web/locals';
import { consoleStateFailureResponse } from '../../lib/web/responses.service';
import { jsonResponse } from '@cybermole/app-kit';

export const GET: APIRoute = async ({ locals }) => {
  const { cybermole, session } = assertCybermoleLocals(locals);
  const refresh = cybermole.auth.cookieRefresh(session, cybermole.cfg.base);
  const state = await cybermole.consoleState();
  if (!state.ok) return consoleStateFailureResponse(state);
  return jsonResponse(state.data, 200, refresh === null ? undefined : { 'Set-Cookie': refresh });
};
