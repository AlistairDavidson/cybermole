// branded.ts — nominal types for the IDs that cross module boundaries
// (docs/CODE_STYLE.md §4). A bare string is not accepted where one is
// expected. Untrusted input gets its brand from the validating schemas in
// src/schemas/ids.ts; the as*() casts are for trusted sources only (pi's
// own session files, tmux output, a token the server minted, the state db).
declare const __brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [__brand]: B };

/** pi session id (uuid in pi's session store): resume target, hidden-sessions key. */
export type PiSessionId = Brand<string, 'PiSessionId'>;
/** A tmux session name on the app's socket. */
export type TmuxSessionName = Brand<string, 'TmuxSessionName'>;
/** A scheduled job's (normalized) name. */
export type JobName = Brand<string, 'JobName'>;
/** A login session token (the webpi_session cookie value). */
export type SessionToken = Brand<string, 'SessionToken'>;
/** An object's key in the storage bucket (src/lib/storage.ts). */
export type ObjectKey = Brand<string, 'ObjectKey'>;
/** A full (40-hex) git commit sha of the workspace checkout — the
 *  management page's apply target (src/lib/releases.ts). */
export type CommitSha = Brand<string, 'CommitSha'>;

export function asPiSessionId(value: string): PiSessionId {
  return value as PiSessionId;
}

export function asTmuxSessionName(value: string): TmuxSessionName {
  return value as TmuxSessionName;
}

export function asJobName(value: string): JobName {
  return value as JobName;
}

export function asSessionToken(value: string): SessionToken {
  return value as SessionToken;
}

export function asObjectKey(value: string): ObjectKey {
  return value as ObjectKey;
}

export function asCommitSha(value: string): CommitSha {
  return value as CommitSha;
}
