// responses.service.ts — the generic half of the Result→HTTP mapping: the
// ONLY place an error code becomes a status (docs/CODE_STYLE.md §3) for
// code that has no domain mappers of its own. Moved from cybermole's
// src/lib/web/responses.service.ts by task/app-kit (docs/apps-plan.md §5)
// — that file keeps the console's domain mappers (jobs, apps, workspaces,
// …) and imports these; failure bodies here are byte-identical to what the
// console's routes have always answered.
// Node-free (Response/JSON are web standards) — an app's client code may
// import jsonResponse too.

export function jsonResponse(
  body: unknown,
  status: number,
  headers?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    // no-store: these bodies are per-user state (and the service worker
    // never caches /api either).
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
}

export function successResponse<DataType extends object>(data: DataType): Response {
  return jsonResponse({ success: true, data }, 200);
}

/** The first issue as one line — 'field: message', or the bare message
 *  for a root-level issue (e.g. a failed union). */
export function firstIssueText(issues: Record<string, string>): string {
  const first = Object.entries(issues)[0];
  if (!first) return 'bad request';
  const [field, message] = first;
  return field ? `${field}: ${message}` : message;
}

/** The failure shape a zod parse produces: per-field issues keyed by
 *  dotted path ("" for the root). The console's parsing.service
 *  (ValidationFailure) and the route-table binder's input failures both
 *  carry it; the wire body never changes. */
export interface ValidationIssues {
  issues: Record<string, string>;
}

export function validationFailureResponse(result: ValidationIssues): Response {
  return jsonResponse(
    { error: firstIssueText(result.issues), code: 'validation_failure', issues: result.issues },
    400,
  );
}
