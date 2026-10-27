// The self-naming rule, shared by the server (workspaces.ts) and the
// new-workspace dialog's live suggestion: a workspace created without a
// meaningful name is named after the folder it starts in. Node-free so the
// browser bundle can import the exact rule the server applies.

/** The api schema's cap (schemas/api.ts uses the same constant). */
export const MAX_WORKSPACE_NAME = 120;

/** Posix basename with trailing slashes stripped ('/srv/notes/' → 'notes');
 *  '' only for '/' and while a user is mid-path before any segment. */
function baseName(cwd: string): string {
  const stripped = cwd.replace(/\/+$/, '');
  return stripped.slice(stripped.lastIndexOf('/') + 1);
}

/** Boring by design: the resolved cwd's basename ('workspace' when the cwd
 *  has none worth taking), then '-2', '-3', … past siblings already holding
 *  the name (exact match, same group). An explicit name never goes through
 *  here — it always wins verbatim. Never longer than the schema's cap. */
export function workspaceNameFromCwd(cwd: string, siblings: Iterable<string> = []): string {
  const taken = new Set(siblings);
  const raw = baseName(cwd);
  const base =
    raw === '' || raw === '.' || raw === '..' ? 'workspace' : raw.slice(0, MAX_WORKSPACE_NAME);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const stem = base.slice(0, Math.max(1, MAX_WORKSPACE_NAME - suffix.length));
    if (!taken.has(stem + suffix)) return stem + suffix;
  }
}
