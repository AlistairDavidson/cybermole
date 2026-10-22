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

// task/jobs-socket (plan §4): the internal API's two request bodies. The
// same field rules as JobSaveSchema; Node-free like everything here so the
// CLI/MCP client side (plan §5/§6) can reuse them.

/** PATCH /jobs/:name over the internal socket — set schedule/command/app:
 *  absent keeps the stored value, null clears the app tag (the
 *  appPatchBody convention). The route merges with the stored job and
 *  saves through the SAME saveJob the browser's POST /api/jobs uses. */
export const JobPatchSchema = z.object({
  schedule: z
    .string()
    .trim()
    .min(1, 'schedule is required')
    .max(MAX_SCHEDULE, `schedule is too long (max ${MAX_SCHEDULE})`)
    .regex(SINGLE_LINE, 'schedule must be one line')
    .optional(),
  command: z
    .string()
    .trim()
    .min(1, 'command is required')
    .max(MAX_COMMAND, `command is too long (max ${MAX_COMMAND})`)
    .regex(SINGLE_LINE, 'command must be one line')
    .optional(),
  appId: AppIdSchema.nullable().optional(),
});
export type JobPatch = z.output<typeof JobPatchSchema>;

/** POST /jobs/validate over the internal socket — cron + command
 *  validation (plan §4): either field, at least one (the browser's
 *  validate is schedule-only; the internal one checks a whole candidate
 *  command too). Raw strings here — the schedule's validity is checkCron's
 *  to judge, the command's is JobPatchSchema's command rule. */
export const JobValidateSchema = z
  .object({
    schedule: z.string().optional(),
    command: z.string().optional(),
  })
  .refine(v => v.schedule !== undefined || v.command !== undefined, {
    message: 'nothing to validate — send schedule and/or command',
  });
export type JobValidateBody = z.output<typeof JobValidateSchema>;
