// branded.ts — nominal types for the IDs that cross module boundaries
// (docs/CODE_STYLE.md §4). A bare string is not accepted where one is
// expected. Untrusted input gets its brand from the validating schemas in
// src/schemas/ids.ts; the as*() casts are for trusted sources only (pi's
// own session files, tmux output, a token the server minted, the state db).
declare const __brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [__brand]: B };

/** A tmux session name on the app's socket. */
export type TmuxSessionName = Brand<string, 'TmuxSessionName'>;
/** A scheduled job's (normalized) name. */
export type JobName = Brand<string, 'JobName'>;
/** A login session token (the webpi_session cookie value). */
export type SessionToken = Brand<string, 'SessionToken'>;
/** An app row's id (uuid v4) — the workspace-grouping container (src/lib/apps.ts). */
export type AppId = Brand<string, 'AppId'>;
/** An app's slug ([a-z0-9][a-z0-9-]{0,39}) — its stable URL identity. */
export type AppSlug = Brand<string, 'AppSlug'>;
/** A workspace row's id (uuid v4) — a cwd + terminal tabs (src/lib/workspaces.ts). */
export type WorkspaceId = Brand<string, 'WorkspaceId'>;
/** A terminal row's id (uuid v4) — one terminal tab = one tmux session. */
export type TerminalId = Brand<string, 'TerminalId'>;
/** An object's key in the storage bucket (src/lib/storage.ts). */
export type ObjectKey = Brand<string, 'ObjectKey'>;

export function asTmuxSessionName(value: string): TmuxSessionName {
  return value as TmuxSessionName;
}

export function asJobName(value: string): JobName {
  return value as JobName;
}

export function asSessionToken(value: string): SessionToken {
  return value as SessionToken;
}

export function asAppId(value: string): AppId {
  return value as AppId;
}

export function asAppSlug(value: string): AppSlug {
  return value as AppSlug;
}

export function asWorkspaceId(value: string): WorkspaceId {
  return value as WorkspaceId;
}

export function asTerminalId(value: string): TerminalId {
  return value as TerminalId;
}

export function asObjectKey(value: string): ObjectKey {
  return value as ObjectKey;
}
