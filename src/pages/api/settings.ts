// /api/settings — the dashboard's data. GET answers the effective config
// (paths and versions only; no credential or hash contents ever leave).
// POST saves the terminal defaults (task/defaults-settings): the writable
// half of the page — a string sets the db override, null clears it back
// to the default chain, absent keeps.
import type { APIRoute } from 'astro';
import { assertCybermoleLocals } from '../../lib/web/locals';
import { parseAndValidateAPIRequest } from '../../lib/web/parsing.service';
import {
  failureResponse,
  settingsStateFailureResponse,
  terminalDefaultsFailureResponse,
} from '../../lib/web/responses.service';
import { jsonResponse } from '@cybermole/app-kit';
import { terminalDefaultsBody } from '../../schemas/api';

export const GET: APIRoute = ({ locals }) => {
  const { cybermole } = assertCybermoleLocals(locals);
  const state = cybermole.settingsState();
  if (!state.ok) return settingsStateFailureResponse(state);
  return jsonResponse(state.data, 200);
};

export const POST: APIRoute = async ({ locals, request }) => {
  const { cybermole } = assertCybermoleLocals(locals);
  const parsed = await parseAndValidateAPIRequest(request, terminalDefaultsBody);
  if (!parsed.ok) return failureResponse(parsed);
  const saved = cybermole.saveTerminalDefaults(parsed.data);
  if (!saved.ok) return terminalDefaultsFailureResponse(saved);
  return jsonResponse(saved.data, 200);
};
