// /view's target: which single pane the page shows, resolved from the URL
// (?t=<terminal uuid> — the id the console's tab rows and /?t= deep links
// identify a tab with — or ?w=<workspace uuid> for its editor) and the
// workspace tree. Pure, so the page renders it and the units pin it.

import type { TerminalId, WorkspaceId } from '@cybermole/app-kit';
import { asTerminalId, asWorkspaceId, UUID_RE } from '@cybermole/app-kit';
import type { WorkspaceState } from '../platform/types';

export type PopoutView =
  | { kind: 'terminal'; id: TerminalId; label: string }
  | { kind: 'editor'; id: WorkspaceId; label: string; cwd: string }
  /** The page's message state: absent or malformed params, unknown ids, editor off. */
  | { kind: 'missing'; message: string };

export interface PopoutViewParams {
  /** Raw ?t= value; null when absent. */
  terminalId: string | null;
  /** Raw ?w= value; null when absent. */
  workspaceId: string | null;
  /** CYBERMOLE_EDITOR_UPSTREAM is set; false refuses the editor view. */
  editorEnabled: boolean;
}

/** ?t= wins when both are present: one pane per page, terminals first. */
export function resolvePopoutView(
  workspaces: WorkspaceState[],
  params: PopoutViewParams,
): PopoutView {
  const { terminalId, workspaceId, editorEnabled } = params;
  if (terminalId !== null) {
    if (!UUID_RE.test(terminalId)) return { kind: 'missing', message: 'malformed terminal id' };
    const id = asTerminalId(terminalId);
    for (const ws of workspaces) {
      const i = ws.terminals.findIndex(t => t.id === id);
      // The tab bar's own label rule: a titled tab shows its title, else "term N".
      if (i >= 0) return { kind: 'terminal', id, label: ws.terminals[i]!.title ?? `term ${i + 1}` };
    }
    return { kind: 'missing', message: 'no such terminal' };
  }
  if (workspaceId !== null) {
    if (!UUID_RE.test(workspaceId)) return { kind: 'missing', message: 'malformed workspace id' };
    const ws = workspaces.find(w => w.id === asWorkspaceId(workspaceId));
    if (!ws) return { kind: 'missing', message: 'no such workspace' };
    if (!editorEnabled) {
      return {
        kind: 'missing',
        message: 'the editor is not configured (CYBERMOLE_EDITOR_UPSTREAM is unset)',
      };
    }
    return { kind: 'editor', id: ws.id, label: `${ws.name} — editor`, cwd: ws.cwd };
  }
  return {
    kind: 'missing',
    message: 'nothing to show — /view needs ?t=<terminal id> or ?w=<workspace id>',
  };
}
