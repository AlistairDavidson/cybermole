// Nominal types for IDs that cross module boundaries. Untrusted input gets
// its brand from the schemas in schemas/ids.ts; the as*() casts are for
// trusted sources only (tmux output, server-minted tokens, the state db).
declare const __brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [__brand]: B };

export type TmuxSessionName = Brand<string, 'TmuxSessionName'>;
/** normalized */
export type JobName = Brand<string, 'JobName'>;
/** the cybermole_session cookie value */
export type SessionToken = Brand<string, 'SessionToken'>;
/** uuid v4 */
export type AppId = Brand<string, 'AppId'>;
/** stable URL identity */
export type AppSlug = Brand<string, 'AppSlug'>;
/** uuid v4 */
export type WorkspaceId = Brand<string, 'WorkspaceId'>;
/** uuid v4; one terminal tab = one tmux session */
export type TerminalId = Brand<string, 'TerminalId'>;
/** uploads/<uuid> */
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
