// POST /api/update-pi — manual `npm install pi@latest` in the app dir.
// Long-running by design (npm timeout 10 min server-side); concurrent runs
// are refused (409, shared with auto-update's busy guard). {dryRun:true}
// is a check-only mode: proves npm runs, installs nothing.
import type { APIRoute } from 'astro';
import { assertCybermoleLocals } from '../../lib/web/locals';
import { parseAndValidateAPIRequest } from '../../lib/web/parsing.service';
import { failureResponse, piUpdateResponse } from '../../lib/web/responses.service';
import { updatePiBody } from '../../schemas/api';

export const POST: APIRoute = async ({ locals, request }) => {
  const { cybermole } = assertCybermoleLocals(locals);
  const parsed = await parseAndValidateAPIRequest(request, updatePiBody);
  if (!parsed.ok) return failureResponse(parsed);
  return piUpdateResponse(await cybermole.runPiUpdate(parsed.data.dryRun));
};
