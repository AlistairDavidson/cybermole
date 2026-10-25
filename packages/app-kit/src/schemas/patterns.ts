// ID rules as plain regexes, so browser code needing a pattern needn't
// bundle zod. Every literal `-` in a character class is escaped: these also
// become HTML `pattern` attributes (compiled with the `v` flag), where an
// unescaped `-` is a syntax error and the browser ignores the pattern.

/** 64: a job run's session is `cybermole-<job name>`, and job names go up to 40. */
// eslint-disable-next-line no-useless-escape -- escaped `-` compiles as an HTML `pattern` attribute (`v` flag); tests/unit/zod-attributes.test.mjs guards this
export const TMUX_SESSION_NAME_RE = /^[a-zA-Z0-9_\-]{1,64}$/;

/** uploads/<uuid v4>, lowercase. The download route serves nothing else. */
export const OBJECT_KEY_RE =
  /^uploads\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Applies to the typed name and the normalized one; normalizing never lengthens. */
export const MAX_JOB_NAME = 40;

/** "cybermole-" prefixes are rejected, so no run session is ever
 *  cybermole-cybermole-*. */
export const JOB_NAME_RE = new RegExp(
  `^(?!cybermole-)[a-z0-9][a-z0-9_\\-]{0,${MAX_JOB_NAME - 1}}$`,
);

export function normalizeJobName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_JOB_NAME);
}

/** The typed name's cap lives in the API body schemas. */
export const MAX_APP_SLUG = 40;

/** Stricter than job names: no underscore. */
export const APP_SLUG_RE = new RegExp(`^[a-z0-9][a-z0-9\\-]{0,${MAX_APP_SLUG - 1}}$`);

/** '' means nothing usable was typed; otherwise always satisfies APP_SLUG_RE. */
export function normalizeSlug(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_APP_SLUG);
}

/** Bare lowercase uuid v4. Version and variant nibbles are pinned, so a
 *  uuid v7 (pi session ids) never passes as ours. */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
