// api.ts — zod schemas for the JSON request bodies the REST endpoints
// accept. Node-free (docs/CODE_STYLE.md §5): the API routes
// (src/pages/api/**) parse with them via parseAndValidateAPIRequest, the
// login route in server/main.ts with safeParse, and forms can validate
// client-side against the same definitions. A failed parse is a 400 whose
// body names the field (responses.service.ts).
//
// The ID rules (regex + brand) live in ids.ts and are reused here, so a
// parsed id is already a PiSessionId. What deliberately does NOT live
// here: cron validity (cron-parser stays server-side — saveJob) and value
// normalization that isn't part of a form (name slugification in
// /api/new, resize clamps).
import { z } from 'zod';
import { AppIdSchema, PiSessionIdSchema } from './ids';

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

/** POST /api/new — any string; slugification and the empty check ('name
 *  required') stay in the handler: normalization is not validation. */
export const newSessionBody = z.object({ name: z.string() });

// POST /api/jobs (save): JobSaveSchema in jobs.ts — shared with the
// /jobs dialog's client-side validation.

/** POST /api/jobs/validate — the schedule string. '' passes: checkCron
 *  answers { valid: false, 'schedule is required' } with a 200. */
export const jobValidateBody = z.object({ schedule: z.string() });

/** POST /api/session/hide */
export const hideBody = z.object({ id: PiSessionIdSchema });

/** POST /api/session/unhide — {all:true} (restore everything) or {id} to
 *  restore one; all wins when both are present, like the old check. The
 *  union's own message: zod's default for a failed union is only
 *  'Invalid input'. */
export const unhideBody = z.union([
  z.object({ all: z.literal(true) }),
  z.object({ id: PiSessionIdSchema }),
], { error: 'invalid session id' });

/** POST /api/update-pi — dryRun defaults to false (a real update), like
 *  the old `dryRun === true`; a mistyped dryRun is a 400 instead of
 *  silently falling through to a real install. */
export const updatePiBody = z.object({ dryRun: z.boolean().default(false) });

/** POST /api/auto-update-pi — the toggle's one boolean. */
export const autoUpdateBody = z.object({ enabled: z.boolean({ error: 'enabled must be a boolean' }) });

/** POST /api/zed/open — a directory (a session's cwd) to open in the Zed
 *  webapp (docs/zed-webapp.md). Absolute paths only: the server checks
 *  it is a directory it can see before forwarding to the launcher. */
export const zedOpenBody = z.object({ path: z.string().regex(/^\//, 'path must be absolute') });

// ---------- workspaces-plan §6: apps / workspaces / terminals bodies ----------
// (docs/workspaces-plan.md, branch task/ws-schema.) The name checks are
// split by family: save_app/save_workspace carry invalid_name as a DOMAIN
// code (the domains trim and slugify — normalization is not validation),
// so these schemas only type and cap the strings. The terminal families
// have no invalid_* code, so terminal titles are validated HERE (a bad
// title is a 400 before the domain is ever reached).

/** POST /api/apps — any string; the domain slugs it (empty slug →
 *  invalid_name). */
export const appCreateBody = z.object({ name: z.string().max(80, 'name is too long (max 80)') });

/** PATCH /api/apps/:slug — name only (the slug is stable once created, v1);
 *  absent = a no-op that returns the row. */
export const appPatchBody = z.object({ name: z.string().max(80, 'name is too long (max 80)').optional() });

/** POST /api/workspaces — appId null (or absent) = the console group; cwd
 *  optional, defaulting server-side to WEB_PI_NEW_SESSION_CWD (the domain
 *  validates absolute + existing directory). */
export const workspaceCreateBody = z.object({
  appId: AppIdSchema.nullable().optional(),
  name: z.string().max(120, 'name is too long (max 120)'),
  cwd: z.string().max(4096, 'cwd is too long').optional(),
});

/** PATCH /api/workspaces/:id — either field alone; absent fields keep. */
export const workspacePatchBody = z.object({
  name: z.string().max(120, 'name is too long (max 120)').optional(),
  cwd: z.string().max(4096, 'cwd is too long').optional(),
});

/** POST /api/workspaces/:id/terminals — a title for the new tab, or none
 *  (the UI then labels it "term N"). */
export const terminalCreateBody = z.object({
  title: z.string().trim().min(1, 'title is required').max(120, 'title is too long (max 120)').optional(),
});

/** PATCH /api/terminals/:id — rename the tab; title null clears it back to
 *  the "term N" label (an empty string is a 400, not a clear). */
export const terminalPatchBody = z.object({
  title: z.string().trim().min(1, 'title is required').max(120, 'title is too long (max 120)').nullable(),
});
