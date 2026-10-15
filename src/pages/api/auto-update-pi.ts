// POST /api/auto-update-pi — the /settings toggle: persist the setting and
// rewire the periodic check (src/lib/auto-update.ts).
import type { APIRoute } from 'astro';
import { assertWebPiLocals } from '../../lib/web/locals';
import { parseAndValidateAPIRequest } from '../../lib/web/parsing.service';
import {
  databaseUpdateFailureResponse,
  failureResponse,
  jsonResponse,
} from '../../lib/web/responses.service';
import { autoUpdateBody } from '../../schemas/api';

export const POST: APIRoute = async ({ locals, request }) => {
  const { webpi } = assertWebPiLocals(locals);
  const parsed = await parseAndValidateAPIRequest(request, autoUpdateBody);
  if (!parsed.ok) return failureResponse(parsed);
  const saved = webpi.autoUpdater.setEnabled(parsed.data.enabled);
  if (!saved.ok)
    return databaseUpdateFailureResponse(saved, saved.errorMessage ?? 'could not save the setting');
  return jsonResponse({ ok: true, enabled: parsed.data.enabled }, 200);
};
