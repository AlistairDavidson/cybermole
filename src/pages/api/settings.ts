// GET: the effective config (paths and versions, never credentials). POST:
// save the /settings overrides (a string sets, null clears, absent keeps).
import type { APIRoute } from 'astro';
import { assertCybermoleLocals } from '../../lib/web/locals';
import { parseAndValidateAPIRequest } from '../../lib/web/parsing.service';
import {
  failureResponse,
  jobWebhookFailureResponse,
  settingsStateFailureResponse,
  terminalDefaultsFailureResponse,
} from '../../lib/web/responses.service';
import { jsonResponse } from '@cybermole/app-kit';
import { settingsOverridesBody } from '../../schemas/api';

export const GET: APIRoute = ({ locals }) => {
  const { cybermole } = assertCybermoleLocals(locals);
  const state = cybermole.settingsState();
  if (!state.ok) return settingsStateFailureResponse(state);
  return jsonResponse(state.data, 200);
};

export const POST: APIRoute = async ({ locals, request }) => {
  const { cybermole } = assertCybermoleLocals(locals);
  const parsed = await parseAndValidateAPIRequest(request, settingsOverridesBody);
  if (!parsed.ok) return failureResponse(parsed);
  // Each form may send only its own fields; absent fields keep their row.
  const saved = cybermole.saveTerminalDefaults(parsed.data);
  if (!saved.ok) return terminalDefaultsFailureResponse(saved);
  const savedWebhook = cybermole.saveJobWebhook(parsed.data);
  if (!savedWebhook.ok) return jobWebhookFailureResponse(savedWebhook);
  return jsonResponse({ ...saved.data, ...savedWebhook.data }, 200);
};
