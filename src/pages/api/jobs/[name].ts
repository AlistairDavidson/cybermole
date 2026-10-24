// DELETE /api/jobs/<name> — drop a job's definition and run history. A
// live run's tmux session is deliberately left alone (kill it from Live).
import type { APIRoute } from 'astro';
import { assertCybermoleLocals } from '../../../lib/web/locals';
import {
  invalidJobNameResponse,
  jobFailureResponse,
  jsonResponse,
} from '../../../lib/web/responses.service';
import { JobNameSchema } from '@cybermole/app-kit';

export const DELETE: APIRoute = async ({ locals, params }) => {
  const { cybermole } = assertCybermoleLocals(locals);
  const name = JobNameSchema.safeParse(params.name);
  if (!name.success) return invalidJobNameResponse();
  const deleted = await cybermole.scheduler.deleteJob(name.data);
  if (!deleted.ok) return jobFailureResponse(deleted);
  return jsonResponse({ name: deleted.data.name, session: null }, 200);
};
