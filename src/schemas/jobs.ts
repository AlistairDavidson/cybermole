// The job form schema, shared by the /jobs dialog and POST /api/jobs.
// Cron validity is checked server-side by saveJob.
import { z } from 'zod';
import { asJobName } from '@cybermole/app-kit';
import { AppIdSchema } from '@cybermole/app-kit';
import { JOB_NAME_RE, MAX_JOB_NAME, normalizeJobName } from '@cybermole/app-kit';

export const MAX_SCHEDULE = 120;
export const MAX_COMMAND = 4000;
const SINGLE_LINE = /^[^\r\n]*$/;

export const JobSaveSchema = z.object({
  // Normalized ("Nightly Check" → nightly-check), then validated. The cap is
  // on the typed value (the field's maxlength), so normalizing never truncates.
  name: z
    .string()
    .max(MAX_JOB_NAME, `name is too long (max ${MAX_JOB_NAME})`)
    .transform(normalizeJobName)
    .pipe(
      z
        .string()
        .min(1, 'name is required')
        .regex(JOB_NAME_RE, 'use letters, digits, - and _ (and not cybermole-…)')
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
  // A display tag only; null clears it.
  appId: AppIdSchema.nullable().optional(),
});

/** Digits only, ≤15 so it's always a safe integer. */
export const FiredAtSchema = z
  .string()
  .regex(/^\d{1,15}$/, 'invalid fired_at (integer epoch ms)')
  .transform(Number);

export type SaveInput = z.output<typeof JobSaveSchema>;

// Internal API bodies, with JobSaveSchema's field rules.

/** Absent keeps, null clears the app tag. The route merges with the stored
 *  job and saves through saveJob. */
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

/** At least one field. Raw strings: checkCron and JobPatchSchema's command
 *  rule judge them. */
export const JobValidateSchema = z
  .object({
    schedule: z.string().optional(),
    command: z.string().optional(),
  })
  .refine(v => v.schedule !== undefined || v.command !== undefined, {
    message: 'nothing to validate — send schedule and/or command',
  });
export type JobValidateBody = z.output<typeof JobValidateSchema>;
