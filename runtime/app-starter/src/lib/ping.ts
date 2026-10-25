// The ping action's logic, one Result family per concern. Only type imports
// from the kit: the unit tests run this with plain node, which won't
// type-strip anything under node_modules.
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
