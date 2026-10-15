// jobs.ts — the scheduled-job form, defined once: the /jobs dialog
// validates against it in the browser (validation-enhancer-zod), and
// POST /api/jobs parses with it on the server (a failure is a 400 with
// per-field issues). Node-free. The cron schedule's *validity* is not
// here: cron-parser stays server-side — saveJob checks it (and the
// dialog's live feedback asks POST /api/jobs/validate).
import { z } from 'zod';
import { asJobName } from '../types/branded';
import { AppIdSchema } from './ids';
import { JOB_NAME_RE, MAX_JOB_NAME, normalizeJobName } from './patterns';

export const MAX_SCHEDULE = 120;
export const MAX_COMMAND = 4000;
const SINGLE_LINE = /^[^\r\n]*$/;

export const JobSaveSchema = z.object({
  // Normalized first ("Nightly Check" → nightly-check), then validated —
  // what the user typed is fine as long as it slugs to a valid name. The
  // length cap is on the typed value (it becomes the field's maxlength),
  // so normalizeJobName never has to cut a name short.
  name: z
    .string()
    .max(MAX_JOB_NAME, `name is too long (max ${MAX_JOB_NAME})`)
    .transform(normalizeJobName)
    .pipe(
      z
        .string()
        .min(1, 'name is required')
        .regex(JOB_NAME_RE, 'use letters, digits, - and _ (and not webpi-…)')
        .transform(asJobName),
    ),
  schedule: z
    .string()
    .trim()
    .min(1, 'schedule is required')
    .max(MAX_SCHEDULE, `schedule is too long (max ${MAX_SCHEDULE})`)
    .regex(SINGLE_LINE, 'schedule must be one line'),
  command: z
    .string()
    .trim()
    .min(1, 'command is required')
    .max(MAX_COMMAND, `command is too long (max ${MAX_COMMAND})`)
    .regex(SINGLE_LINE, 'command must be one line'),
  // task/ws-jobs (plan §9): the optional app tag — a display grouping
  // only (jobs are never owned by an app); null clears the tag on edit.
  appId: AppIdSchema.nullable().optional(),
});

/** A :fired_at path param (GET /api/jobs/:name/runs/:fired_at/log): an
 *  integer epoch-ms value — digits only, ≤15 digits (every such number
 *  is a safe integer), never negative, never a float. Validated at the
 *  request boundary like every other path param (docs/CODE_STYLE.md §4);
 *  malformed → 400. */
export const FiredAtSchema = z
  .string()
  .regex(/^\d{1,15}$/, 'invalid fired_at (integer epoch ms)')
  .transform(Number);

/** A parsed save: name normalized + branded, schedule/command trimmed and
 *  shape-checked — saveJob's input. */
export type SaveInput = z.output<typeof JobSaveSchema>;
