// The self-naming rule (workspaces.ts): a workspace created without a
// meaningful name is named after the folder it starts in. Node-free: the
// schemas share its cap with the browser bundle.

/** The api schema's cap (schemas/api.ts uses the same constant). */
export const MAX_WORKSPACE_NAME = 120;

/** Posix basename with trailing slashes stripped ('/srv/notes/' → 'notes');
 *  '' only for '/'. */
function baseName(cwd: string): string {
  const stripped = cwd.replace(/\/+$/, '');
  return stripped.slice(stripped.lastIndexOf('/') + 1);
}

/** The resolved cwd's basename ('workspace' when the cwd has none worth
 *  taking), never longer than the schema's cap. An explicit name never goes
 *  through here — it always wins verbatim. */
export function workspaceNameFromCwd(cwd: string): string {
  const raw = baseName(cwd);
  return raw === '' || raw === '.' || raw === '..' ? 'workspace' : raw.slice(0, MAX_WORKSPACE_NAME);
}
