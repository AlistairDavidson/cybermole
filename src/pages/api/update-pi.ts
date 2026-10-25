// Manual `npm install pi@latest`. Runs up to 10 min; concurrent runs get 409.
// {dryRun:true} only checks that npm runs.
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
