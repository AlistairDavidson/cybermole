import type { APIRoute } from 'astro';
import { assertCybermoleLocals } from '../../../../../lib/web/locals';
import {
  invalidJobNameResponse,
  jobFailureResponse,
} from '../../../../../lib/web/responses.service';
import { jsonResponse, JobNameSchema } from '@cybermole/app-kit';

export const GET: APIRoute = async ({ locals, params }) => {
  const { cybermole } = assertCybermoleLocals(locals);
  const name = JobNameSchema.safeParse(params.name);
  if (!name.success) return invalidJobNameResponse();
  const listed = cybermole.scheduler.listRuns(name.data);
  if (!listed.ok) return jobFailureResponse(listed);
  return jsonResponse(listed.data, 200);
};
