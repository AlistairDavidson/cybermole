// The app-pages agent drawer's pure half: which workspace a page's drawer
// attaches to, and where its builder link points — decided from the
// console's state JSON (GET /api/state), never from the DOM. Structural
// subsets: the console's ConsoleState is assignable to ConsoleStateLite.
// Node-free and DOM-free, so unit tests run it straight from dist-server.
import type { AppId, TerminalId, WorkspaceId } from './types/branded';

/** The slices of GET /api/state the drawer reads. */
export interface ConsoleStateLite {
  apps: Array<{ id: AppId; slug: string }>;
  workspaces: Array<{
    id: WorkspaceId;
    appId: AppId | null;
    /** 'build' = a build session at the root cwd; null = in-tree (the
     *  operator's kind, what the drawer wants). */
    kind: 'build' | null;
    order: number;
    terminals: Array<{ id: TerminalId; order: number }>;
  }>;
}

/** The app row for a page's slug, else null (not registered). */
export function appBySlug(
  state: ConsoleStateLite,
  slug: string,
): ConsoleStateLite['apps'][number] | null {
  return state.apps.find(a => a.slug === slug) ?? null;
}

/** This app's operator workspace (kind NULL, in the app tree): the first
 *  in console order, else null — the drawer then creates one (POST
 *  /api/workspaces {appId} derives the app tree cwd). */
export function operatorWorkspace(state: ConsoleStateLite, appId: AppId): WorkspaceId | null {
  const scoped = state.workspaces
    .filter(w => w.appId === appId && w.kind === null)
    .sort((a, b) => a.order - b.order);
  return scoped[0]?.id ?? null;
}

/** The drawer's first terminal of a workspace (its agent tab), else null. */
export function firstTerminal(
  state: ConsoleStateLite,
  workspaceId: WorkspaceId,
): TerminalId | null {
  const ws = state.workspaces.find(w => w.id === workspaceId);
  if (!ws) return null;
  const sorted = [...ws.terminals].sort((a, b) => a.order - b.order);
  return sorted[0]?.id ?? null;
}

/** The builder-page deep link for this app: its first build workspace's
 *  first terminal, else the plain portfolio page. */
export function builderLink(state: ConsoleStateLite, appId: AppId, base: string): string {
  const build = state.workspaces
    .filter(w => w.appId === appId && w.kind === 'build')
    .sort((a, b) => a.order - b.order)[0];
  const terminal = build ? firstTerminal(state, build.id) : null;
  return terminal ? `${base}/builder?t=${terminal}` : `${base}/builder`;
}
