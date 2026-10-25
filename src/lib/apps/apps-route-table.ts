// Reads an app's emitted dist/route-table.json and turns `{action, params}`
// into the exact request the entry names (shared by `call` and the app MCP
// shim, so there's no parallel RPC to drift).
//
// Validation is lenient: the app's own handler is the authority, so the
// preflight only checks what can't be a false rejection (params is an
// object, required fields are present). The shim's tool schemas are typed
// but coercive, never stricter than the app.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';

/** Restated locally: server code imports the kit only through its root specifier. */
export type TableJsonSchema = Record<string, unknown>;

export interface SerializedAction {
  name: string;
  method: string;
  path: string;
  description: string;
  input: TableJsonSchema;
}

export type ReadRouteTable =
  | { ok: true; table: SerializedAction[]; tablePath: string; tree: string }
  | {
      ok: false;
      tree: string;
      tablePath: string;
      errorCode: 'tree_not_found' | 'not_built';
      errorMessage: string;
    };

/** No table means the app isn't built: a domain answer, not a transport error. */
export function readRouteTable(tree: string): ReadRouteTable {
  const tablePath = path.join(tree, 'dist', 'route-table.json');
  if (!fs.existsSync(tree)) {
    return {
      ok: false,
      tree,
      tablePath,
      errorCode: 'tree_not_found',
      errorMessage: `no app tree at ${tree} — scaffold it first (the apps root owns the lookup)`,
    };
  }
  if (!fs.existsSync(tablePath)) {
    return {
      ok: false,
      tree,
      tablePath,
      errorCode: 'not_built',
      errorMessage: `no dist/route-table.json at ${tablePath} — the app is not built; run the build tool (or check) first, then this again`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(tablePath, 'utf8'));
  } catch (err) {
    return {
      ok: false,
      tree,
      tablePath,
      errorCode: 'not_built',
      errorMessage: `dist/route-table.json at ${tablePath} is not valid JSON (${(err as Error).message}) — rebuild the app`,
    };
  }
  const table = Array.isArray(parsed)
    ? parsed.filter(
        (e): e is SerializedAction =>
          typeof e === 'object' &&
          e !== null &&
          typeof (e as SerializedAction).name === 'string' &&
          typeof (e as SerializedAction).method === 'string' &&
          typeof (e as SerializedAction).path === 'string',
      )
    : [];
  return { ok: true, table, tablePath, tree };
}

export function findAction(table: SerializedAction[], action: string): SerializedAction | null {
  return table.find(e => e.name === action) ?? null;
}

// ---------- lenient validation ----------

const isRequired = (input: TableJsonSchema, name: string): boolean =>
  Array.isArray(input.required) && input.required.includes(name);

/** Accepts any value; rejects only a missing key. */
const presence = (name: string): z.ZodType =>
  z.any().refine(v => v !== undefined, { message: `${name} is required` });

/** Required properties must be present; nothing else is judged. */
export function lenientPreflight(input: TableJsonSchema): z.ZodType {
  const properties = (input.properties ?? {}) as Record<string, unknown>;
  const shape: Record<string, z.ZodType> = {};
  for (const name of Object.keys(properties)) {
    shape[name] = isRequired(input, name) ? presence(name) : z.any().optional();
  }
  return z.looseObject(shape);
}

/** First issue per field, "" for the root (parseZod's shape). */
export function zodIssuesToRecord(error: z.ZodError): Record<string, string> {
  const issues: Record<string, string> = {};
  for (const issue of error.issues) {
    const field = issue.path.map(String).join('.') || '';
    if (!issues[field]) issues[field] = issue.message;
  }
  return issues;
}

// ---------- request planning ----------

export interface PlannedRequest {
  method: string;
  /** '/apps/<slug>' + the entry path with :params filled in */
  pathname: string;
  /** '' when none */
  search: string;
  /** JSON; undefined for GET */
  body: string | undefined;
}

export type Planned =
  | { ok: true; request: PlannedRequest }
  | { ok: false; errorMessage: string; issues: Record<string, string> };

const PATH_PARAM_RE = /:([A-Za-z0-9_]+)/g;

/** Path params are interpolated; the rest go in the query (GET) or a JSON
 *  body. A preflight failure answers locally without calling the app. */
export function planActionRequest(
  slug: string,
  entry: SerializedAction,
  rawParams: unknown,
): Planned {
  if (
    rawParams !== undefined &&
    (typeof rawParams !== 'object' || rawParams === null || Array.isArray(rawParams))
  ) {
    return {
      ok: false,
      errorMessage: "params must be an object of the action's input fields",
      issues: { '': 'params must be an object' },
    };
  }
  const params = (rawParams ?? {}) as Record<string, unknown>;
  const preflight = lenientPreflight(entry.input).safeParse(params);
  if (!preflight.success) {
    return {
      ok: false,
      errorMessage: `invalid params for ${entry.name} (checked leniently against the emitted input — the app was not called; its own handler stays the authority)`,
      issues: zodIssuesToRecord(preflight.error),
    };
  }
  let pathname = `/apps/${slug}${entry.path}`;
  const pathParams: Array<[string, unknown]> = [];
  for (const match of entry.path.matchAll(PATH_PARAM_RE)) {
    const key = match[1]!;
    const value = params[key];
    if (value === undefined) {
      // A :param the emitted schema didn't name can't be interpolated.
      return {
        ok: false,
        errorMessage: `missing path param ${key} for ${entry.name}`,
        issues: { [key]: `${key} is required` },
      };
    }
    pathParams.push([key, value]);
    pathname = pathname.replace(`:${key}`, encodeURIComponent(String(value)));
  }
  const consumed = new Set(pathParams.map(([k]) => k));
  const rest = Object.fromEntries(Object.entries(params).filter(([k]) => !consumed.has(k)));
  if (entry.method === 'GET' || entry.method === 'HEAD') {
    const search = new URLSearchParams(
      Object.entries(rest).map(([k, v]) => [k, Array.isArray(v) ? JSON.stringify(v) : String(v)]),
    );
    return {
      ok: true,
      request: { method: entry.method, pathname, search: search.toString(), body: undefined },
    };
  }
  return {
    ok: true,
    request: { method: entry.method, pathname, search: '', body: JSON.stringify(rest) },
  };
}

// ---------- typed shape (the shim's inputSchema) ----------

/** The kit emits string/number/boolean/null consts. */
type LiteralValue = string | number | boolean | null;

function typedZodFrom(node: TableJsonSchema): z.ZodType {
  if (Array.isArray(node.anyOf)) {
    const options = (node.anyOf as TableJsonSchema[]).map(typedZodFrom);
    return options.length === 1
      ? options[0]!
      : z.union(options.length === 0 ? [z.any()] : (options as [z.ZodType, z.ZodType]));
  }
  if (Array.isArray(node.enum)) {
    const values = node.enum as unknown[];
    if (values.length === 0) return z.any();
    if (values.every(v => typeof v === 'string')) {
      return z.enum(values as [string, ...string[]]);
    }
    return z.union(
      values.map(v => z.literal(v as LiteralValue)) as unknown as [z.ZodType, z.ZodType],
    );
  }
  if (node.const !== undefined) return z.literal(node.const as LiteralValue);
  const bounds = {
    min: typeof node.minimum === 'number' ? node.minimum : undefined,
    max: typeof node.maximum === 'number' ? node.maximum : undefined,
  };
  switch (node.type) {
    case 'string': {
      let s = z.string();
      if (typeof node.minLength === 'number') s = s.min(node.minLength);
      if (typeof node.maxLength === 'number') s = s.max(node.maxLength);
      return s;
    }
    case 'integer':
    case 'number': {
      let n = node.type === 'integer' ? z.coerce.number().int() : z.coerce.number();
      if (bounds.min !== undefined) n = n.gte(bounds.min);
      if (bounds.max !== undefined) n = n.lte(bounds.max);
      return n;
    }
    case 'boolean':
      return z
        .union([z.boolean(), z.literal('true'), z.literal('false')])
        .transform(v => (typeof v === 'boolean' ? v : v === 'true'));
    case 'array':
      return z.array(typedZodFrom((node.items ?? {}) as TableJsonSchema));
    case 'object': {
      const properties = (node.properties ?? {}) as Record<string, TableJsonSchema>;
      const shape: Record<string, z.ZodType> = {};
      for (const [name, sub] of Object.entries(properties)) {
        shape[name] = isRequired(node, name) ? typedZodFrom(sub) : typedZodFrom(sub).optional();
      }
      return z.looseObject(shape);
    }
    default:
      return z.any(); // unknown construct: permissive
  }
}

/** Typed as far as the emitted schema goes; numbers and booleans also
 *  accept their string spellings, as the app coerces them. */
export function shapeFromJsonSchema(input: TableJsonSchema): Record<string, z.ZodType> {
  const properties = (input.properties ?? {}) as Record<string, TableJsonSchema>;
  const shape: Record<string, z.ZodType> = {};
  for (const name of Object.keys(properties)) {
    shape[name] = isRequired(input, name)
      ? typedZodFrom(properties[name]!)
      : typedZodFrom(properties[name]!).optional();
  }
  return shape;
}
