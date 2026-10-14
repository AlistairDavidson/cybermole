// patterns.ts — the ID rules as plain regexes (no zod import, so browser
// code that only needs a pattern doesn't bundle zod). src/schemas/ids.ts
// builds the validating, branding schemas from these.
//
// Every literal `-` inside a character class is escaped: these patterns
// also become HTML `pattern` attributes, which compile with the `v` flag,
// where an unescaped `-` in a class is a syntax error and the browser
// silently ignores the whole pattern.

/** pi session ids (uuid); also caps junk written into the state db. */
export const SESSION_ID_RE = /^[0-9a-zA-Z\-]{1,64}$/;

/** tmux session names on the app socket. 64, not 40: a job run's session
 *  is `webpi-<job name>` and job names go up to 40 (JOB_NAME_RE), so a
 *  40-char cap rejected every run of a job named longer than 34. */
export const TMUX_SESSION_NAME_RE = /^[a-zA-Z0-9_\-]{1,64}$/;

/** Object keys POST /api/files mints (src/lib/storage.ts): uploads/<uuid v4>,
 *  lowercase. The download route serves nothing else from the bucket. */
export const OBJECT_KEY_RE = /^uploads\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Longest job name — as typed (JobSaveSchema) and once normalized
 *  (JOB_NAME_RE). Normalizing never lengthens a name. */
export const MAX_JOB_NAME = 40;

/** Job name charset: tmux-session-name-safe. Names starting with "webpi-"
 *  are rejected so a job can never produce a doubly-prefixed (confusingly
 *  nested) webpi-webpi-* run session. */
export const JOB_NAME_RE = new RegExp(`^(?!webpi-)[a-z0-9][a-z0-9_\\-]{0,${MAX_JOB_NAME - 1}}$`);

/** Normalize a user-supplied job name the way /api/new does for sessions. */
export function normalizeJobName(raw: string): string {
  return raw.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, MAX_JOB_NAME);
}

/** Normalize a user-supplied new-session name (POST /api/new): the same
 *  slug rules, capped at 30 (the sidebar input's maxlength). '' means
 *  nothing usable was typed. */
export function normalizeSessionName(raw: string): string {
  return raw.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 30);
}

/** Longest app slug — as normalized (APP_SLUG_RE); the cap on the typed
 *  name lives in the API body schemas. */
export const MAX_APP_SLUG = 40;

/** App slug charset: lowercase slug, no underscore (job/session names
 *  allow `_`; app slugs are the stricter, URL-shaped subset). */
export const APP_SLUG_RE = new RegExp(`^[a-z0-9][a-z0-9\\-]{0,${MAX_APP_SLUG - 1}}$`);

/** Normalize a display name into an app slug (POST /api/apps): lowercase,
 *  runs of anything that isn't [a-z0-9] — underscores included — collapse
 *  to '-', leading/trailing '-' stripped, capped at MAX_APP_SLUG. '' means
 *  nothing usable was typed. The output always satisfies APP_SLUG_RE or
 *  is empty. */
export function normalizeSlug(raw: string): string {
  return raw.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, MAX_APP_SLUG);
}

/** Lowercase uuid v4 — the id shape apps/workspaces/terminals mint
 *  (crypto.randomUUID), bare (no prefix), unlike OBJECT_KEY_RE's uploads/
 *  form. Version and variant nibbles are pinned, so a uuid v7 (pi session
 *  ids) can never pass as one of ours. */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
