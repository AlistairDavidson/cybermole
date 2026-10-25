// route-table.ts — the route-table binder (docs/plans/apps-plan.md §5): an app
// declares ONE table (src/routes.ts — name, method, path, zod in, handler
// → Result) and the kit binds it to every face the plan promised:
//
//   (a) handleApiRequest()/astroApiHandlers() — the Astro catch-all API
//       glue: method+path matching, zod parse, handler, Result→HTTP. An
//       app's src/pages/api/[...path].ts delegates here; unknown
//       method+path answers 404 Result JSON.
//   (b) toMcpToolShapes() — MCP tool shapes (name, description,
//       inputSchema as JSON schema, converted from the zod schemas by the
//       documented subset in zodToJSONSchema below).
//   (c) createRouteClient() — the typed client for sibling calls: one
//       function per entry, issuing the very HTTP request the entry names
//       (plan §3: "no parallel RPC to invent or let drift"), reading the
//       Result JSON back.
//   (d) serializeRouteTable() (+ writeRouteTable in route-table-emit.ts)
//       — dist/route-table.json: what describe/call and the app's MCP
//       shim read.
//
// Results are the wire bodies VERBATIM (plan §0: one action vocabulary —
// same Result JSON on the UI, the tools and the sibling calls); statuses
// come from the entry's errorStatus map, one status per closed error
// code, exhaustive by construction. Binder-own failures (unknown route,
// invalid input, a thrown handler) are the RouteApi family below.
//
// Node-free — client islands may import the client face; only
// route-table-emit.ts (the build-time writer) touches node:fs.
import type { z } from 'zod';
import type { APIRoute } from 'astro';
import { jsonResponse } from './web/responses.service';
import type { Result, ResultFailure } from './types/result';

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

/** Any Result a table entry's handler may return (apps bring their own
 *  families; `string` is the loosest closed shape). */
export type RouteResult = Result<string, object, string>;

/** The error codes of everything a handler can return (success members
 *  distribute away). */
type RouteErrors<R> = R extends { ok: false; errorCode: infer E } ? E : never;

/** What a handler receives: the entry's parsed parts. params are the
 *  :segments of the path — they arrive as STRINGS (use z.coerce.number()
 *  and friends when a param is not a string); query is the URL's search
 *  params (last value wins per key); body is the parsed JSON body
 *  (application/json only). */
export interface RouteInput<Params, Query, Body> {
  params: Params;
  query: Query;
  body: Body;
}

type OptionalSchemaOutput<S> = S extends z.ZodTypeAny ? z.output<S> : undefined;

// The loose table the binder's runtime reads through carries the same
// deliberate `any`s as the distribution any in types/result.ts — see
// AnyRouteEntry below.
/** One entry: declared with defineRoute() below so params/query/body and
 *  the handler's Result family all infer from one object literal. */
export interface RouteEntry<
  Params extends z.ZodTypeAny = z.ZodTypeAny,
  Query extends z.ZodTypeAny | undefined = undefined,
  Body extends z.ZodTypeAny | undefined = undefined,
  R extends RouteResult = RouteResult,
> {
  /** Unique across the table — the MCP tool name and the client method. */
  name: string;
  /** One line, third person: the tool description and the table doc. */
  description: string;
  method: HttpMethod;
  /** Path with :param segments, relative to the app's baked base
   *  ('/api/notes/:id'). */
  path: string;
  /** Parses the path's :params (required on every entry — z.object({})
   *  when the path has none). */
  params: Params;
  /** Parses the query string as an object of strings. */
  query?: Query;
  /** Parses the JSON body (methods that carry one). */
  body?: Body;
  /** One status per error code of the family the handler returns — the
   *  entry's own responses.service, exhaustive by type: a new code is a
   *  type error here until it gets a status. */
  errorStatus: { [E in RouteErrors<R>]: number };
  /** Success status override (e.g. 201 for creates); 200 by default. */
  successStatus?: number;
  handler: (
    input: RouteInput<z.output<Params>, OptionalSchemaOutput<Query>, OptionalSchemaOutput<Body>>,
  ) => R | Promise<R>;
}

/** Declare one entry with full inference (params/query/body schemas, the
 *  handler's Result family and the errorStatus map check each other). */
export function defineRoute<
  Params extends z.ZodTypeAny,
  Query extends z.ZodTypeAny | undefined,
  Body extends z.ZodTypeAny | undefined,
  R extends RouteResult,
>(entry: RouteEntry<Params, Query, Body, R>): RouteEntry<Params, Query, Body, R> {
  return entry;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- see RouteEntry
export type AnyRouteEntry = RouteEntry<any, any, any, any>;
export type RouteTable = readonly AnyRouteEntry[];

// ---------- (a) the HTTP face ----------

/** Binder-own failures: the closed family everything around the handlers
 *  answers with (an entry's handler failures use the entry's own family
 *  and errorStatus map). */
export type RouteApiErrorCode =
  | 'route_not_found'
  | 'method_not_allowed'
  | 'invalid_params'
  | 'invalid_query'
  | 'invalid_body'
  | 'invalid_json'
  | 'unsupported_content_type'
  | 'internal_error';
export type RouteApiFailure = ResultFailure<'route_api', object, RouteApiErrorCode>;

export interface BindRoutesOptions {
  /** Strip this prefix from the request path before matching — the app's
   *  baked Astro base ('/apps/notes'), so entries name paths the way the
   *  app thinks of them ('/api/notes/:id'). */
  basePath?: string;
}

const splitSegments = (p: string): string[] => p.split('/').filter(s => s.length > 0);

/** Match a request path against an entry's :param pattern; the captured
 *  params (raw string segments) or null. */
function matchPath(pattern: string, segments: string[]): Record<string, string> | null {
  const pat = splitSegments(pattern);
  if (pat.length !== segments.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pat.length; i++) {
    const p = pat[i]!;
    if (p.startsWith(':')) params[p.slice(1)] = decodeURIComponent(segments[i]!);
    else if (p !== segments[i]) return null;
  }
  return params;
}

function routeApiFailure(
  errorCode: RouteApiErrorCode,
  errorMessage: string,
  status: number,
  issues?: Record<string, string>,
): Response {
  return jsonResponse(
    { ok: false, resultType: 'route_api', errorCode, errorMessage, ...(issues ? { issues } : {}) },
    status,
  );
}

/** zod issues → the per-field record the house validation bodies carry
 *  (first issue per field, dotted path, "" for the root — parseZod's
 *  shape, so tool results and sibling calls read one format). */
function zodIssues(error: z.ZodError): Record<string, string> {
  const issues: Record<string, string> = {};
  for (const issue of error.issues) {
    const field = issue.path.map(String).join('.');
    if (!issues[field]) issues[field] = issue.message;
  }
  return issues;
}

/** The Astro catch-all API glue: match, parse, run, map. An app's
 *  src/pages/api/[...path].ts delegates every method here:
 *
 *   export const { GET, POST, PATCH, PUT, DELETE } =
 *     astroApiHandlers(routes, { basePath: import.meta.env.BASE_URL });
 *
 * (or calls handleApiRequest() directly from its own handlers). */
export async function handleApiRequest(
  request: Request,
  table: RouteTable,
  options: BindRoutesOptions = {},
): Promise<Response> {
  const url = new URL(request.url);
  const base = options.basePath?.replace(/\/+$/, '') ?? '';
  const pathname =
    base && url.pathname.startsWith(`${base}/`) ? url.pathname.slice(base.length) : url.pathname;
  const segments = splitSegments(pathname);

  const matches = table.filter(entry => matchPath(entry.path, segments) !== null);
  if (matches.length === 0) {
    return routeApiFailure('route_not_found', `no route for ${request.method} ${pathname}`, 404);
  }
  const entry = matches.find(e => e.method === request.method);
  if (!entry) {
    const allow = [...new Set(matches.map(e => e.method))].join(', ');
    return new Response(null, {
      status: 405,
      headers: { Allow: allow, 'Cache-Control': 'no-store' },
    });
  }
  const params = matchPath(entry.path, segments)!;

  const parsedParams = entry.params.safeParse(params);
  if (!parsedParams.success) {
    return routeApiFailure(
      'invalid_params',
      'invalid path params',
      400,
      zodIssues(parsedParams.error),
    );
  }
  let query: unknown = undefined;
  if (entry.query) {
    const parsedQuery = entry.query.safeParse(Object.fromEntries(url.searchParams));
    if (!parsedQuery.success) {
      return routeApiFailure('invalid_query', 'invalid query', 400, zodIssues(parsedQuery.error));
    }
    query = parsedQuery.data;
  }
  let body: unknown = undefined;
  if (entry.body) {
    if (!(request.headers.get('content-type') ?? '').includes('application/json')) {
      return routeApiFailure('unsupported_content_type', 'Unsupported content type', 415);
    }
    try {
      body = await request.json();
    } catch {
      return routeApiFailure('invalid_json', 'Invalid JSON', 400);
    }
    const parsedBody = entry.body.safeParse(body);
    if (!parsedBody.success) {
      return routeApiFailure('invalid_body', 'invalid body', 400, zodIssues(parsedBody.error));
    }
    body = parsedBody.data;
  }

  let result: RouteResult;
  try {
    result = await entry.handler({ params: parsedParams.data, query, body });
  } catch (err) {
    return routeApiFailure('internal_error', `handler threw: ${(err as Error).message}`, 500);
  }

  const status = result.ok
    ? (entry.successStatus ?? 200)
    : ((entry.errorStatus as Record<string, number | undefined>)[result.errorCode] ?? 400);
  return jsonResponse(result, status);
}

/** Every method Astro routes export, delegating to handleApiRequest —
 *  the one-liner an app's [...path].ts route spreads. */
export function astroApiHandlers(
  table: RouteTable,
  options: BindRoutesOptions = {},
): Record<HttpMethod, APIRoute> {
  const handler: APIRoute = ({ request }) => handleApiRequest(request, table, options);
  return { GET: handler, POST: handler, PATCH: handler, PUT: handler, DELETE: handler };
}

// ---------- (b) MCP tool shapes + (d) the serialized table ----------

/** JSON schema, as far as the documented subset below goes. Unknown zod
 *  constructs convert to {} (permissive) — never a wrong rejection. */
export type JsonSchema = Record<string, unknown>;

/** zod → JSON schema, the documented subset: objects (properties,
 *  required, additionalProperties: false), strings (minLength/maxLength),
 *  numbers (integer, bounds), booleans, enums/literals (enum/const),
 *  arrays, records, unions, nullable, optional/default (unwrapped),
 *  .describe() → description. Everything else (dates, effects, template
 *  literals, …) becomes {} — an MCP client never rejects valid input on
 *  the kit's account. Reads zod's _zod.def shape (v4); guarded access,
 *  total function. */
export function zodToJSONSchema(schema: z.ZodTypeAny): JsonSchema {
  return convert(schema);
}

function convert(schema: z.ZodTypeAny): JsonSchema {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- zod v4's def bag
  const def = (schema as any)._zod?.def;
  const node: JsonSchema = {};
  if (typeof schema.description === 'string') node.description = schema.description;
  if (!def || typeof def.type !== 'string') return Object.keys(node).length ? node : {};
  switch (def.type as string) {
    case 'object': {
      const shape = def.shape as Record<string, z.ZodTypeAny>;
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        properties[key] = convert(unwrap(value));
        // optionality is a property of the WRAPPER, so it is read before
        // unwrap() strips it — reading it after would mark every optional
        // field required (the notes app's emitted table caught that).
        const wrapper = value._zod.def.type;
        if (wrapper !== 'optional' && wrapper !== 'default') required.push(key);
      }
      node.type = 'object';
      node.properties = properties;
      if (required.length) node.required = required;
      node.additionalProperties = false;
      return node;
    }
    case 'string': {
      node.type = 'string';
      for (const raw of def.checks ?? []) {
        const check = raw?._zod?.def;
        if (check?.check === 'min_length' && typeof check.minimum === 'number')
          node.minLength = check.minimum;
        if (check?.check === 'max_length' && typeof check.maximum === 'number')
          node.maxLength = check.maximum;
      }
      return node;
    }
    case 'number': {
      let integer = false;
      for (const raw of def.checks ?? []) {
        const check = raw?._zod?.def;
        if (
          check?.check === 'number_format' &&
          (check.format === 'int' || check.format === 'safeint')
        )
          integer = true;
        if (check?.check === 'greater_than')
          if (check.inclusive) node.minimum = check.value;
          else node.exclusiveMinimum = check.value;
        if (check?.check === 'less_than')
          if (check.inclusive) node.maximum = check.value;
          else node.exclusiveMaximum = check.value;
      }
      node.type = integer ? 'integer' : 'number';
      return node;
    }
    case 'boolean':
      node.type = 'boolean';
      return node;
    case 'bigint':
      node.type = 'integer';
      return node;
    case 'literal': {
      const values = (def.values as unknown[]).filter(v => v !== undefined);
      if (values.length === 1) node.const = values[0];
      else node.enum = values;
      return node;
    }
    case 'enum': {
      const values = Object.values(def.entries as Record<string, unknown>);
      node.enum = values;
      if (values.every(v => typeof v === 'string')) node.type = 'string';
      else if (values.every(v => typeof v === 'number')) node.type = 'number';
      return node;
    }
    case 'array': {
      node.type = 'array';
      node.items = convert(def.element);
      return node;
    }
    case 'record': {
      node.type = 'object';
      node.additionalProperties = convert(def.valueType);
      return node;
    }
    case 'union': {
      const options = (def.options as z.ZodTypeAny[]) ?? [];
      const converted = options.map(o => convert(o));
      if (converted.length === 1) return converted[0]!;
      if (converted.length === 0) return {};
      node.anyOf = converted;
      return node;
    }
    case 'nullable': {
      const inner = convert(def.innerType);
      node.anyOf = [inner, { type: 'null' }];
      return node;
    }
    case 'intersection': {
      node.allOf = [convert(def.left), convert(def.right)];
      return node;
    }
    default:
      // optional/default are unwrapped by the caller (unwrap below);
      // anything else (pipe, date, effects, catch, …) is permissive.
      return Object.keys(node).length ? node : {};
  }
}

function unwrap(schema: z.ZodTypeAny): z.ZodTypeAny {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- zod v4's def bag
  const def = (schema as any)._zod?.def;
  const t = def?.type;
  return t === 'optional' || t === 'default' ? unwrap(def.innerType) : schema;
}

/** An entry's flattened input schema: params + query + body properties in
 *  ONE object (an MCP tool takes one input object). The namespaces share
 *  the flat key space — a name used twice collides (body wins, in
 *  declaration order params → query → body); name them apart. */
export function flattenedInputSchema(entry: AnyRouteEntry): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  let required: string[] = [];
  const add = (schema: z.ZodTypeAny | undefined): void => {
    if (!schema) return;
    const converted = zodToJSONSchema(schema);
    Object.assign(properties, converted.properties);
    required = required.concat((converted.required as string[] | undefined) ?? []);
  };
  add(entry.params);
  add(entry.query);
  add(entry.body);
  const node: JsonSchema = {
    type: 'object',
    properties,
    ...(required.length ? { required: [...new Set(required)] } : {}),
    additionalProperties: false,
  };
  return node;
}

/** One MCP tool shape per entry (inputSchema is a JSON schema; tools read
 *  results as Result JSON verbatim — the shim's contract). */
export interface McpToolShape {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

export function toMcpToolShapes(table: RouteTable): McpToolShape[] {
  return table.map(entry => ({
    name: entry.name,
    description: entry.description,
    inputSchema: flattenedInputSchema(entry),
  }));
}

/** One dist/route-table.json entry — what describe/call and the app's
 *  MCP shim read (same shape the internal API's verbs are described in:
 *  name, method, path, input, description). */
export interface SerializedRouteEntry {
  name: string;
  method: HttpMethod;
  path: string;
  description: string;
  input: JsonSchema;
}

/** The serialized table — the dist/route-table.json body. */
export function serializeRouteTable(table: RouteTable): SerializedRouteEntry[] {
  return table.map(entry => ({
    name: entry.name,
    method: entry.method,
    path: entry.path,
    description: entry.description,
    input: flattenedInputSchema(entry),
  }));
}

// ---------- (c) the typed client ----------

/** The client's own failure: the HTTP call itself failed (network error,
 *  a non-JSON answer — a proxy's 502 HTML page). Everything else is the
 *  entry's Result JSON, verbatim. */
export type RouteClientTransportFailure = {
  ok: false;
  resultType: 'route_client';
  errorCode: 'transport_error';
  errorMessage: string;
};

export interface RouteClientOptions {
  /** Where the table is served — the app's own base for islands, the host
   *  socket's origin for sibling calls. A path prefix is kept as-is. */
  base: string | URL;
  /** Headers every call carries (auth, when the base needs it). */
  headers?: Record<string, string>;
  /** Injectable for tests; global fetch by default. */
  fetchImpl?: typeof fetch;
}

/** A table's client: one function per entry, typed by that entry (the
 *  handler's Result family is the return; params are the :segments).
 *  query/body inputs are loosely typed (Record<string, unknown> /
 *  unknown) — the binder validates them against the entry's schemas at
 *  runtime; wrap locally when you want them precise. */
export function createRouteClient<T extends RouteTable>(
  table: T,
  options: RouteClientOptions,
): {
  [K in T[number]['name']]: (input: {
    params: z.output<Extract<T[number], { name: K }>['params']>;
    query?: Record<string, unknown>;
    body?: unknown;
  }) => Promise<
    | (Extract<T[number], { name: K }>['handler'] extends (input: never) => infer R
        ? Awaited<R>
        : never)
    | RouteClientTransportFailure
  >;
} {
  const base = options.base.toString().replace(/\/+$/, '');
  const doFetch = options.fetchImpl ?? fetch;
  const client: Record<
    string,
    (input: { params: unknown; query?: unknown; body?: unknown }) => Promise<unknown>
  > = {};
  for (const entry of table) {
    client[entry.name] = async input => {
      const path = entry.path.replace(/:([A-Za-z0-9_]+)/g, (_, name: string) => {
        const value = (input.params as Record<string, unknown>)[name];
        if (value === undefined)
          throw new Error(`route client ${entry.name}: missing path param ${name}`);
        return encodeURIComponent(String(value));
      });
      const search =
        input.query && Object.keys(input.query).length > 0
          ? `?${new URLSearchParams(input.query as Record<string, string>).toString()}`
          : '';
      let response: Response;
      try {
        response = await doFetch(`${base}${path}${search}`, {
          method: entry.method,
          headers: {
            ...(input.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
            ...options.headers,
          },
          ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
        });
      } catch (err) {
        return {
          ok: false,
          resultType: 'route_client',
          errorCode: 'transport_error',
          errorMessage: `${entry.name}: ${(err as Error).message}`,
        } satisfies RouteClientTransportFailure;
      }
      let parsed: unknown;
      try {
        parsed = await response.json();
      } catch {
        return {
          ok: false,
          resultType: 'route_client',
          errorCode: 'transport_error',
          errorMessage: `${entry.name}: non-JSON answer (status ${response.status})`,
        } satisfies RouteClientTransportFailure;
      }
      return parsed;
    };
  }
  return client as never;
}
