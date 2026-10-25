// The ping action's logic — the app's domain code, one Result family per
// concern (docs/conventions/CODE_STYLE.md §1, the house rules this template bakes in).
// Kept node-free AND runtime-kit-free (the family's TYPES are an
// `import type` — stripped before execution) so the unit tests import
// this file with plain node: the kit ships TS sources, and node refuses
// to type-strip anything under node_modules, so a tested unit may only
// type-import from it.
import type { ResultFailure, ResultSuccess } from '@cybermole/app-kit';

export type PingData = { hello: string; at: number };
export type PingErrorCode = 'invalid_name';
export type PingSuccess = ResultSuccess<'ping', PingData>;
export type PingFailure = ResultFailure<'ping', PingData, PingErrorCode>;
export type PingResult = PingSuccess | PingFailure;

export function pingResult(rawName: string): PingResult {
  const name = rawName.trim();
  if (name.length === 0) {
    return {
      ok: false,
      resultType: 'ping',
      errorCode: 'invalid_name',
      errorMessage: 'name is required',
    } satisfies PingFailure;
  }
  if (name.length > 64) {
    return {
      ok: false,
      resultType: 'ping',
      errorCode: 'invalid_name',
      errorMessage: 'name is too long (max 64 chars)',
    } satisfies PingFailure;
  }
  return { ok: true, resultType: 'ping', data: { hello: name, at: Date.now() } } satisfies PingSuccess;
}
