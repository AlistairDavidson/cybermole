// The run's newest 1 MiB of log as text/plain. The path is built from the
// row; the client only ever names the run.
import type { APIRoute } from 'astro';
import { assertCybermoleLocals } from '../../../../../../lib/web/locals';
import {
  invalidFiredAtResponse,
  invalidJobNameResponse,
  jobFailureResponse,
  runLogResponse,
} from '../../../../../../lib/web/responses.service';
import { JobNameSchema } from '@cybermole/app-kit';
import { FiredAtSchema } from '../../../../../../schemas/jobs';

export const GET: APIRoute = async ({ locals, params }) => {
  const { cybermole } = assertCybermoleLocals(locals);
  const name = JobNameSchema.safeParse(params.name);
  if (!name.success) return invalidJobNameResponse();
  const firedAt = FiredAtSchema.safeParse(params.fired_at);
  if (!firedAt.success) return invalidFiredAtResponse();
  const log = cybermole.scheduler.readRunLog(name.data, firedAt.data);
  if (!log.ok) return jobFailureResponse(log);
  return runLogResponse(log.data);
};
