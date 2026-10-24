// GET /api/state — the console's poll (every open tab, every 15 s). It
// also re-arms the browser cookie's Max-Age when it has drifted near half
// the sliding window (auth.cookieRefresh decides — see the justification
// there).
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
