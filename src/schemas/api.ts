// Zod schemas for JSON request bodies, node-free so forms can validate
// client-side against the same definitions. Cron validity and name
// normalization stay server-side, in the domains.
import { z } from 'zod';
import { AppIdSchema, TerminalIdSchema } from '@cybermole/app-kit';

/** A parse failure answers 401, which fail2ban counts. Empty strings pass:
 *  verify() decides those. */
export const loginBody = z.object({ username: z.string(), password: z.string() });

/** Stricter than loginBody so an empty field never spends a request from
 *  the 10-per-15-min login budget. */
export const loginForm = z.object({
  username: z.string().min(1, 'enter your username'),
  password: z.string().min(1, 'enter your password'),
});

// POST /api/jobs: JobSaveSchema in schemas/jobs.ts.

/** '' passes: checkCron answers valid:false with a 200. */
export const jobValidateBody = z.object({ schedule: z.string() });

/** A mistyped dryRun is a 400 rather than falling through to a real install. */
export const updatePiBody = z.object({ dryRun: z.boolean().default(false) });

export const autoUpdateBody = z.object({
  enabled: z.boolean({ error: 'enabled must be a boolean' }),
});

// ---------- apps / workspaces / terminals ----------
// Apps and workspaces report invalid_name as a domain code (the domains trim
// and slugify), so these only type and cap strings. Terminals have no such
// code, so titles are validated here.

/** Empty or absent cwd = unset; a non-empty one is checked by the domain. */
export const appCreateBody = z.object({
  name: z.string().max(80, 'name is too long (max 80)'),
  cwd: z.string().max(4096, 'cwd is too long').optional(),
});

/** The slug never changes. cwd: absent keeps, null clears, a string sets. */
export const appPatchBody = z.object({
  name: z.string().max(80, 'name is too long (max 80)').optional(),
  cwd: z.string().max(4096, 'cwd is too long').nullable().optional(),
});

/** appId null or absent = the console group. The cwd is derived: the
 *  parent app's, else CYBERMOLE_NEW_SESSION_CWD — except kind 'build'
 *  (a build session), which requires appId and always starts at the
 *  server default. */
export const workspaceCreateBody = z
  .object({
    appId: AppIdSchema.nullable().optional(),
    name: z.string().max(120, 'name is too long (max 120)'),
    kind: z.literal('build').optional(),
  })
  .refine(b => b.kind !== 'build' || (b.appId ?? null) !== null, {
    message: "kind 'build' requires appId",
    path: ['kind'],
  });

/** Absent fields keep. */
export const workspacePatchBody = z.object({
  name: z.string().max(120, 'name is too long (max 120)').optional(),
  cwd: z.string().max(4096, 'cwd is too long').optional(),
});

/** No title: labelled "term N". command picks what the tab runs; absent
 *  is the shell, the common case (the workspace's first, auto-opened tab
 *  is always an agent tab and is not created through this body). */
export const terminalCreateBody = z.object({
  title: z
    .string()
    .trim()
    .min(1, 'title is required')
    .max(120, 'title is too long (max 120)')
    .optional(),
  command: z.enum(['agent', 'shell']).optional(),
});

/** A full-list reorder: every terminal of the workspace, each once. The
 *  domain checks the set; the schema caps the list. */
export const terminalReorderBody = z.object({
  order: z.array(TerminalIdSchema).min(1, 'order is required').max(200, 'too many terminals'),
});

/** A string sets, null clears back to "term N", absent is a no-op; '' is a 400. */
export const terminalPatchBody = z.object({
  title: z
    .string()
    .trim()
    .min(1, 'title is required')
    .max(120, 'title is too long (max 120)')
    .nullable()
    .optional(),
});

// ---------- console dialog forms ----------
// Stricter than the bodies so an empty field never costs a round trip.

/** No min on cwd: the enhancer reads an empty wa-input as '', which means unset. */
export const appForm = z.object({
  name: z.string().trim().min(1, 'name is required').max(80, 'name is too long (max 80)'),
  cwd: z.string().trim().max(4096, 'cwd is too long').optional(),
});

export const workspaceForm = z.object({
  name: z.string().trim().min(1, 'name is required').max(120, 'name is too long (max 120)'),
});

// ---------- /settings terminal-defaults form ----------

export const MAX_TERMINAL_COMMAND = 500;
const SINGLE_LINE = /^[^\r\n]*$/;

/** Used by both the server and the /settings form. A non-empty string sets
 *  the override, null or '' clears it, absent keeps. '' must parse because
 *  the enhancer reads an emptied wa-input as ''. */
export const terminalDefaultsBody = z.object({
  agentCommand: z
    .string()
    .trim()
    .max(MAX_TERMINAL_COMMAND, `command is too long (max ${MAX_TERMINAL_COMMAND})`)
    .regex(SINGLE_LINE, 'command must be one line')
    .transform(v => (v === '' ? null : v))
    .nullable()
    .optional(),
  shellCommand: z
    .string()
    .trim()
    .max(MAX_TERMINAL_COMMAND, `command is too long (max ${MAX_TERMINAL_COMMAND})`)
    .regex(SINGLE_LINE, 'command must be one line')
    .transform(v => (v === '' ? null : v))
    .nullable()
    .optional(),
});
