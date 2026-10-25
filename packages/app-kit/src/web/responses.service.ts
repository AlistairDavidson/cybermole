// The generic half of Result → HTTP, node-free. The console's domain
// mappers live in src/lib/web/responses.service.ts.

export function jsonResponse(
  body: unknown,
  status: number,
  headers?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    // Per-user state (the service worker never caches /api either).
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
}

export function successResponse<DataType extends object>(data: DataType): Response {
  return jsonResponse({ success: true, data }, 200);
}

/** 'field: message', or the bare message for a root-level issue. */
export function firstIssueText(issues: Record<string, string>): string {
  const first = Object.entries(issues)[0];
  if (!first) return 'bad request';
  const [field, message] = first;
  return field ? `${field}: ${message}` : message;
}

/** Per-field issues keyed by dotted path ("" for the root). */
export interface ValidationIssues {
  issues: Record<string, string>;
}

export function validationFailureResponse(result: ValidationIssues): Response {
  return jsonResponse(
    { error: firstIssueText(result.issues), code: 'validation_failure', issues: result.issues },
    400,
  );
}
