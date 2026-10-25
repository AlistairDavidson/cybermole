import type { APIRoute } from 'astro';
import { assertCybermoleLocals } from '../../lib/web/locals';
import { parseAndValidateAPIRequest } from '../../lib/web/parsing.service';
import { databaseUpdateFailureResponse, failureResponse } from '../../lib/web/responses.service';
import { jsonResponse } from '@cybermole/app-kit';
import { autoUpdateBody } from '../../schemas/api';

export const POST: APIRoute = async ({ locals, request }) => {
  const { cybermole } = assertCybermoleLocals(locals);
  const parsed = await parseAndValidateAPIRequest(request, autoUpdateBody);
  if (!parsed.ok) return failureResponse(parsed);
  const saved = cybermole.autoUpdater.setEnabled(parsed.data.enabled);
  if (!saved.ok)
    return databaseUpdateFailureResponse(saved, saved.errorMessage ?? 'could not save the setting');
  return jsonResponse({ ok: true, enabled: parsed.data.enabled }, 200);
};
