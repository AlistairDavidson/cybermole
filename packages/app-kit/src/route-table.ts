// The route-table binder: an app declares one table (src/routes.ts: name,
// method, path, zod schemas, handler → Result) and the kit binds it to:
//
//   (a) handleApiRequest()/astroApiHandlers(): the Astro catch-all API.
//   (b) toMcpToolShapes(): MCP tool shapes, schemas converted to JSON schema.
//   (c) createRouteClient(): a typed client issuing the same HTTP requests
//       (the components' enhancers and stores call it in the browser).
//   (d) serializeRouteTable(): dist/route-table.json, for describe/call and
//       the app's MCP shim.
//
// Results go over the wire verbatim; statuses come from each entry's
// errorStatus map. Node-free: only route-table-emit.ts touches node:fs.
import type { z } from 'zod';
import type { APIRoute } from 'astro';
import { jsonResponse } from './web/responses.service';
import type { Result, ResultFailure } from './types/result';

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

/** Apps bring their own families; `string` is the loosest closed shape. */
export type RouteResult = Result<string, object, string>;

type RouteErrors<R> = R extends { ok: false; errorCode: infer E } ? E : never;

/** params arrive as strings (use z.coerce for others); query is the search
 *  params, last value wins; body is parsed JSON (application/json only). */
export interface RouteInput<Params, Query, Body> {
  params: Params;
  query: Query;
  body: Body;
}

type OptionalSchemaOutput<S> = S extends z.ZodTypeAny ? z.output<S> : undefined;

/** Declare with defineRoute() so everything infers from one literal. */
export interface RouteEntry<
  Params extends z.ZodTypeAny = z.ZodTypeAny,
  Query extends z.ZodTypeAny | undefined = undefined,
  Body extends z.ZodTypeAny | undefined = undefined,
  R extends RouteResult = RouteResult,
> {
  /** Unique in the table: the MCP tool name and client method. */
  name: string;
  /** One line, third person. */
  description: string;
  method: HttpMethod;
  /** Relative to the app's base, with :param segments ('/api/notes/:id'). */
  path: string;
  /** Required on every entry: z.object({}) when the path has none. */
  params: Params;
  query?: Query;
  body?: Body;
  /** One status per error code; a new code is a type error until it gets one. */
  errorStatus: { [E in RouteErrors<R>]: number };
  /** Default 200. */
  successStatus?: number;
  handler: (
    input: RouteInput<z.output<Params>, OptionalSchemaOutput<Query>, OptionalSchemaOutput<Body>>,
  ) => R | Promise<R>;
}

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

// ---------- (a) HTTP ----------

/** The binder's own failures (entries use their own families). */
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
  /** The app's baked base, stripped before matching. */
  basePath?: string;
}

const splitSegments = (p: string): string[] => p.split('/').filter(s => s.length > 0);

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

/** First issue per field, dotted path ("" for the root): parseZod's shape. */
function zodIssues(error: z.ZodError): Record<string, string> {
  const issues: Record<string, string> = {};
  for (const issue of error.issues) {
    const field = issue.path.map(String).join('.');
    if (!issues[field]) issues[field] = issue.message;
  }
  return issues;
}

/** Match, parse, run, map. An app's src/pages/api/[...path].ts:
 *
 *   export const { GET, POST, PATCH, PUT, DELETE } =
 *     astroApiHandlers(routes, { basePath: import.meta.env.BASE_URL });
 */
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

export function astroApiHandlers(
  table: RouteTable,
  options: BindRoutesOptions = {},
): Record<HttpMethod, APIRoute> {
  const handler: APIRoute = ({ request }) => handleApiRequest(request, table, options);
  return { GET: handler, POST: handler, PATCH: handler, PUT: handler, DELETE: handler };
}

// ---------- (b) MCP tool shapes, (d) serialized table ----------

/** Unknown zod constructs convert to {}, never a wrong rejection. */
export type JsonSchema = Record<string, unknown>;

/** The supported subset: objects, strings (length), numbers (integer,
 *  bounds), booleans, enums/literals, arrays, records, unions, nullable,
 *  optional/default (unwrapped) and .describe(). Anything else becomes {}.
 *  Reads zod v4's _zod.def. */
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
        // Optionality lives on the wrapper, so read it before unwrap().
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
      // optional/default are unwrapped by the caller; the rest is permissive.
      return Object.keys(node).length ? node : {};
  }
}

function unwrap(schema: z.ZodTypeAny): z.ZodTypeAny {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- zod v4's def bag
  const def = (schema as any)._zod?.def;
  const t = def?.type;
  return t === 'optional' || t === 'default' ? unwrap(def.innerType) : schema;
}

/** params + query + body flattened into one object (a tool takes one
 *  input). Duplicate names collide, later namespaces winning. */
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

/** One dist/route-table.json entry. */
export interface SerializedRouteEntry {
  name: string;
  method: HttpMethod;
  path: string;
  description: string;
  input: JsonSchema;
}

export function serializeRouteTable(table: RouteTable): SerializedRouteEntry[] {
  return table.map(entry => ({
    name: entry.name,
    method: entry.method,
    path: entry.path,
    description: entry.description,
    input: flattenedInputSchema(entry),
  }));
}

// ---------- (c) typed client ----------

/** The call itself failed (network, or a non-JSON answer like a proxy's
 *  502 page). Everything else is the entry's Result, verbatim. */
export type RouteClientTransportFailure = {
  ok: false;
  resultType: 'route_client';
  errorCode: 'transport_error';
  errorMessage: string;
};

export interface RouteClientOptions {
  /** The app's base for app pages, the host socket's origin for sibling calls. */
  base: string | URL;
  headers?: Record<string, string>;
  /** for tests */
  fetchImpl?: typeof fetch;
}

/** One function per entry, returning its handler's Result family. query
 *  and body are loosely typed; the binder validates them at runtime. */
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
