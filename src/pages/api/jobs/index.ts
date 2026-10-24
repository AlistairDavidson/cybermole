// /api/jobs — GET lists the scheduled jobs; POST creates or updates one
// (JobSaveSchema — the same schema the /jobs dialog validates with).
import type { APIRoute } from 'astro';
import { assertCybermoleLocals } from '../../../lib/web/locals';
import { parseAndValidateAPIRequest } from '../../../lib/web/parsing.service';
import { failureResponse, jobFailureResponse } from '../../../lib/web/responses.service';
import { jsonResponse } from '@cybermole/app-kit';
import { JobSaveSchema } from '../../../schemas/jobs';

export const GET: APIRoute = async ({ locals }) => {
  const { cybermole } = assertCybermoleLocals(locals);
  const listed = await cybermole.scheduler.listJobs();
  if (!listed.ok) return jobFailureResponse(listed);
  return jsonResponse(listed.data, 200);
};

export const POST: APIRoute = async ({ locals, request }) => {
  const { cybermole } = assertCybermoleLocals(locals);
  const parsed = await parseAndValidateAPIRequest(request, JobSaveSchema);
  if (!parsed.ok) return failureResponse(parsed);
  const saved = await cybermole.scheduler.saveJob(parsed.data);
  if (!saved.ok) return jobFailureResponse(saved);
  return jsonResponse({ name: saved.data.name, session: null }, 200);
};
