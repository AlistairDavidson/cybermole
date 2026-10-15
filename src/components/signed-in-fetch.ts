// signed-in-fetch.ts — fetch() for the signed-in pages' components. It
// never rejects: a request that gets no answer is a failure Result
// (docs/CODE_STYLE.md §1), and a 401 (the session expired, or was logged
// out everywhere) sends the page to /login here, once for every caller —
// except the ones that opt out with on401: 'return' (the management
// dialog's re-auth POSTs: their 401 means WRONG CREDENTIALS while the
// session is still valid, and the dialog must toast and stay put,
// docs/management-page.md §1.6).
import type { ResultFailure, ResultSuccess } from '../types/result';
import { BASE } from '../base';

export type SignedInFetchData = { response: Response };
/** signed_out: a 401 — the page is already on its way to /login, so the
 *  caller shows nothing. network_error: no answer at all (offline, server
 *  down); errorMessage says why. */
export type SignedInFetchErrorCode = 'signed_out' | 'network_error';
export type SignedInFetchSuccess = ResultSuccess<'signed_in_fetch', SignedInFetchData>;
export type SignedInFetchFailure = ResultFailure<
  'signed_in_fetch',
  SignedInFetchData,
  SignedInFetchErrorCode
>;
export type SignedInFetchResult = SignedInFetchSuccess | SignedInFetchFailure;

/** 401 handling: 'navigate' (default) — the page goes to /login, once
 *  for every caller, and the caller gets the signed_out failure to show
 *  nothing. 'return' — the 401 response itself is the success payload:
 *  the caller reads it (an error answer usually carries a body worth
 *  showing). A stale-session 401 under 'return' then reads as
 *  wrong-credentials to the dialog; the next non-dialog action navigates
 *  to /login anyway. */
export type SignedInFetchOn401 = 'navigate' | 'return';

/** Every status but 401 is a success: the caller reads the response
 *  (an error answer usually carries a body worth showing). */
export async function signedInFetch(
  url: string,
  init?: RequestInit,
  on401: SignedInFetchOn401 = 'navigate',
) {
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
  if (response.status === 401 && on401 === 'navigate') {
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
