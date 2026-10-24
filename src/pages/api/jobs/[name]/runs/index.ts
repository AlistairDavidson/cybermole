// GET /api/jobs/:name/runs — the job's run history, newest first
// (docs/workspaces-plan.md §6/§9): one row per recorded fire with its
// observed exit/finish and whether a log file exists. Capped at the
// scheduler's RUN_HISTORY, like the pruning that enforces it.
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
