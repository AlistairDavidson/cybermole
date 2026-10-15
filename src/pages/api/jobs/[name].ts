// DELETE /api/jobs/<name> — drop a job's definition and run history. A
// live run's tmux session is deliberately left alone (kill it from Live).
import type { APIRoute } from 'astro';
import { assertWebPiLocals } from '../../../lib/web/locals';
import {
  invalidJobNameResponse,
  jobFailureResponse,
  jsonResponse,
} from '../../../lib/web/responses.service';
import { JobNameSchema } from '../../../schemas/ids';

export const DELETE: APIRoute = async ({ locals, params }) => {
  const { webpi } = assertWebPiLocals(locals);
  const name = JobNameSchema.safeParse(params.name);
  if (!name.success) return invalidJobNameResponse();
  const deleted = await webpi.scheduler.deleteJob(name.data);
  if (!deleted.ok) return jobFailureResponse(deleted);
  return jsonResponse({ name: deleted.data.name, session: null }, 200);
};
