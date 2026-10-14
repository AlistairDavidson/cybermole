// GET /api/jobs/:name/runs/:fired_at/log — one run's persisted log TAIL
// (≤ 1 MiB, the newest bytes) as text/plain (docs/workspaces-plan.md
// §6/§9). :fired_at is an integer epoch-ms value, schema-validated like
// every other path param; the file path is built server-side from the
// run's row — the client only ever names the run, never a path.
import type { APIRoute } from 'astro';
import { assertWebPiLocals } from '../../../../../../lib/web/locals';
import {
  invalidFiredAtResponse, invalidJobNameResponse, jobFailureResponse, runLogResponse,
} from '../../../../../../lib/web/responses.service';
import { JobNameSchema } from '../../../../../../schemas/ids';
import { FiredAtSchema } from '../../../../../../schemas/jobs';

export const GET: APIRoute = async ({ locals, params }) => {
  const { webpi } = assertWebPiLocals(locals);
  const name = JobNameSchema.safeParse(params.name);
  if (!name.success) return invalidJobNameResponse();
  const firedAt = FiredAtSchema.safeParse(params.fired_at);
  if (!firedAt.success) return invalidFiredAtResponse();
  const log = webpi.scheduler.readRunLog(name.data, firedAt.data);
  if (!log.ok) return jobFailureResponse(log);
  return runLogResponse(log.data);
};
