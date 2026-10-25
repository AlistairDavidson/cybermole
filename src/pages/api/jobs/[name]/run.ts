// 409 while the previous run is still alive.
import type { APIRoute } from 'astro';
import { assertCybermoleLocals } from '../../../../lib/web/locals';
import { invalidJobNameResponse, jobFailureResponse } from '../../../../lib/web/responses.service';
import { jsonResponse, JobNameSchema } from '@cybermole/app-kit';

export const POST: APIRoute = async ({ locals, params }) => {
  const { cybermole } = assertCybermoleLocals(locals);
  const name = JobNameSchema.safeParse(params.name);
  if (!name.success) return invalidJobNameResponse();
  const run = await cybermole.scheduler.runJob(name.data);
  if (!run.ok) return jobFailureResponse(run);
  return jsonResponse({ name: run.data.name, session: run.data.session }, 200);
};
