// GET /api/settings — the read-only dashboard's effective config. Paths
// and versions only; no credential or hash contents ever leave.
import type { APIRoute } from 'astro';
import { assertCybermoleLocals } from '../../lib/web/locals';
import { jsonResponse, settingsStateFailureResponse } from '../../lib/web/responses.service';

export const GET: APIRoute = ({ locals }) => {
  const { cybermole } = assertCybermoleLocals(locals);
  const state = cybermole.settingsState();
  if (!state.ok) return settingsStateFailureResponse(state);
  return jsonResponse(state.data, 200);
};
