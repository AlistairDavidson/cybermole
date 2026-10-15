// POST /api/jobs/<name>/run — run a job now. Refused (409) while the
// previous run's tmux session is still alive.
import type { APIRoute } from 'astro';
import { assertWebPiLocals } from '../../../../lib/web/locals';
import {
  invalidJobNameResponse,
  jobFailureResponse,
  jsonResponse,
} from '../../../../lib/web/responses.service';
import { JobNameSchema } from '../../../../schemas/ids';

export const POST: APIRoute = async ({ locals, params }) => {
  const { webpi } = assertWebPiLocals(locals);
  const name = JobNameSchema.safeParse(params.name);
  if (!name.success) return invalidJobNameResponse();
  const run = await webpi.scheduler.runJob(name.data);
  if (!run.ok) return jobFailureResponse(run);
  return jsonResponse({ name: run.data.name, session: run.data.session }, 200);
};
