// An invalid schedule is a 200 with { valid: false, error }: an answer, not a failed request.
import type { APIRoute } from 'astro';
import { assertCybermoleLocals } from '../../../lib/web/locals';
import { parseAndValidateAPIRequest } from '../../../lib/web/parsing.service';
import { failureResponse } from '../../../lib/web/responses.service';
import { jsonResponse } from '@cybermole/app-kit';
import { jobValidateBody } from '../../../schemas/api';

export const POST: APIRoute = async ({ locals, request }) => {
  const { cybermole } = assertCybermoleLocals(locals);
  const parsed = await parseAndValidateAPIRequest(request, jobValidateBody);
  if (!parsed.ok) return failureResponse(parsed);
  return jsonResponse(cybermole.checkCron(parsed.data.schedule), 200);
};
