// fetch() for signed-in pages: never rejects, and a 401 sends the page to
// /login once, for every caller.
import type { ResultFailure, ResultSuccess } from '@cybermole/app-kit';
import { BASE } from '../base';

export type SignedInFetchData = { response: Response };
/** signed_out: the page is already heading to /login, so show nothing. */
export type SignedInFetchErrorCode = 'signed_out' | 'network_error';
export type SignedInFetchSuccess = ResultSuccess<'signed_in_fetch', SignedInFetchData>;
export type SignedInFetchFailure = ResultFailure<
  'signed_in_fetch',
  SignedInFetchData,
  SignedInFetchErrorCode
>;
export type SignedInFetchResult = SignedInFetchSuccess | SignedInFetchFailure;

/** Every status but 401 is success; error bodies are usually worth showing. */
export async function signedInFetch(url: string, init?: RequestInit) {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (e) {
    return {
      ok: false,
      resultType: 'signed_in_fetch',
      errorCode: 'network_error',
      errorMessage: (e as Error).message,
    } satisfies SignedInFetchFailure;
  }
  if (response.status === 401) {
    location.href = `${BASE}/login`;
    return {
      ok: false,
      resultType: 'signed_in_fetch',
      errorCode: 'signed_out',
      errorMessage: 'signed out',
    } satisfies SignedInFetchFailure;
  }
  return {
    ok: true,
    resultType: 'signed_in_fetch',
    data: { response },
  } satisfies SignedInFetchSuccess;
}
