// api.ts — zod schemas for the JSON request bodies the REST endpoints
// accept. Node-free (docs/conventions/CODE_STYLE.md §5): the API routes
// (src/pages/api/**) parse with them via parseAndValidateAPIRequest, the
// login route in server/main.ts with safeParse, and forms can validate
// client-side against the same definitions. A failed parse is a 400 whose
// body names the field (responses.service.ts).
//
// The ID rules (regex + brand) live in ids.ts and are reused here, so a
// parsed id is already branded. What deliberately does NOT live
// here: cron validity (cron-parser stays server-side — saveJob) and value
// normalization that isn't part of a form (name slugification in the
// apps domain, resize clamps).
import { z } from 'zod';
import { AppIdSchema } from '@cybermole/app-kit';

/** POST /login — both fields must be strings; a parse failure answers 401
 *  upstream (like the old typeof check), because fail2ban counts 401/429
 *  on that route. Empty strings pass: verify() decides those. */
export const loginBody = z.object({ username: z.string(), password: z.string() });

/** The sign-in FORM, validated in the browser before anything is sent:
 *  stricter than loginBody on purpose — an empty field never needs a
 *  round trip (or a slot in the 10-per-15-min login budget), while the
 *  server stays permissive so a malformed POST is the 401 fail2ban counts. */
export const loginForm = z.object({
  username: z.string().min(1, 'enter your username'),
  password: z.string().min(1, 'enter your password'),
});

// POST /api/jobs (save): JobSaveSchema in jobs.ts — shared with the
// /jobs dialog's client-side validation.

/** POST /api/jobs/validate — the schedule string. '' passes: checkCron
 *  answers { valid: false, 'schedule is required' } with a 200. */
export const jobValidateBody = z.object({ schedule: z.string() });

/** POST /api/update-pi — dryRun defaults to false (a real update), like
 *  the old `dryRun === true`; a mistyped dryRun is a 400 instead of
 *  silently falling through to a real install. */
export const updatePiBody = z.object({ dryRun: z.boolean().default(false) });

/** POST /api/auto-update-pi — the toggle's one boolean. */
export const autoUpdateBody = z.object({
  enabled: z.boolean({ error: 'enabled must be a boolean' }),
});

// ---------- workspaces-plan §6: apps / workspaces / terminals bodies ----------
// (docs/plans/workspaces-plan.md, branch task/ws-schema.) The name checks are
// split by family: save_app/save_workspace carry invalid_name as a DOMAIN
// code (the domains trim and slugify — normalization is not validation),
// so these schemas only type and cap the strings. The terminal families
// have no invalid_* code, so terminal titles are validated HERE (a bad
// title is a 400 before the domain is ever reached).

/** POST /api/apps — name any string (the domain slugs it: empty slug →
 *  invalid_name); cwd optional (task/app-cwd): absent/empty = unset
 *  (workspaces under the app start at the server default), a non-empty
 *  one validated by the domain (absolute + existing dir). */
export const appCreateBody = z.object({
  name: z.string().max(80, 'name is too long (max 80)'),
  cwd: z.string().max(4096, 'cwd is too long').optional(),
});

/** PATCH /api/apps/:slug — name only (the slug is stable once created, v1);
 *  cwd per terminalPatchBody's title convention: absent = keep, null =
 *  clear back to unset (the server default applies), a string = set
 *  (domain-validated). */
export const appPatchBody = z.object({
  name: z.string().max(80, 'name is too long (max 80)').optional(),
  cwd: z.string().max(4096, 'cwd is too long').nullable().optional(),
});

/** POST /api/workspaces — appId null (or absent) = the console group. No
 *  cwd (task/app-cwd — "no folder setting when creating workspace": the
 *  app does that): the server DERIVES it — the parent app's cwd when it
 *  has one, else CYBERMOLE_NEW_SESSION_CWD (the domain validates the
 *  winner, absolute + existing directory). */
export const workspaceCreateBody = z.object({
  appId: AppIdSchema.nullable().optional(),
  name: z.string().max(120, 'name is too long (max 120)'),
});

/** PATCH /api/workspaces/:id — either field alone; absent fields keep. */
export const workspacePatchBody = z.object({
  name: z.string().max(120, 'name is too long (max 120)').optional(),
  cwd: z.string().max(4096, 'cwd is too long').optional(),
});

/** POST /api/workspaces/:id/terminals — a title for the new tab, or none
 *  (the UI then labels it "term N"). */
export const terminalCreateBody = z.object({
  title: z
    .string()
    .trim()
    .min(1, 'title is required')
    .max(120, 'title is too long (max 120)')
    .optional(),
});

/** PATCH /api/terminals/:id — rename the tab: a non-empty string sets the
 *  title, null clears it back to the "term N" label, absent is a no-op
 *  that returns the row (the plan's {title?} — same convention as the
 *  app/workspace patches; an empty string is a 400, not a clear). */
export const terminalPatchBody = z.object({
  title: z
    .string()
    .trim()
    .min(1, 'title is required')
    .max(120, 'title is too long (max 120)')
    .nullable()
    .optional(),
});

// ---------- the console dialogs' forms (task/ws-console, plan §8) ----------
// Stricter than the create bodies on purpose — the loginForm precedent:
// an empty field never costs a round trip, while the server stays
// permissive so a malformed POST is the domain's 400/409 to answer.

/** The new-app dialog: a required name (the domain slugs it) + an
 *  OPTIONAL cwd (task/app-cwd — no min: the enhancer parses an empty
 *  wa-input as '', which must pass; the domain treats '' as unset). */
export const appForm = z.object({
  name: z.string().trim().min(1, 'name is required').max(80, 'name is too long (max 80)'),
  cwd: z.string().trim().max(4096, 'cwd is too long').optional(),
});

/** The new-workspace dialog: name only (task/app-cwd — the folder setting
 *  is gone: the app carries it). The dialog shows where the workspace
 *  will start (the parent app's cwd, else the server default) as a hint;
 *  the server derives and validates the same way. */
export const workspaceForm = z.object({
  name: z.string().trim().min(1, 'name is required').max(120, 'name is too long (max 120)'),
});

// ---------- task/defaults-settings: the /settings terminal-defaults form ----------

/** The longest command line the terminal-defaults fields accept (a
 *  program + a few flags — the field's maxlength). */
export const MAX_TERMINAL_COMMAND = 500;
const SINGLE_LINE = /^[^\r\n]*$/;

/** POST /api/settings (save terminal defaults) — the same schema the
 *  /settings form validates with in the browser. Per field: a NON-EMPTY
 *  string SETS the db override, null CLEARS it back to the default
 *  chain, absent KEEPS the stored value. An empty (or whitespace-only:
 *  trim runs first) string ALSO clears — validation-enhancer-zod feeds an
 *  emptied wa-input as '' (its value is null, coerced before zod), so ''
 *  must parse or the per-field clear could never pass client validation;
 *  the transform normalizes it to the same null. What is INVALID, on both
 *  sides: longer than MAX_TERMINAL_COMMAND, or more than one line. */
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
