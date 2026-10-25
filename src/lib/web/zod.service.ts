// zod.service.ts — HTML validation attributes from a zod object schema
// (soothing-booking's zodSchemaToHTMLAttributes), so an <input>/<wa-input>
// carries the same native constraints the schema enforces — the baseline
// before validation-enhancer-zod takes over in the browser.
//
// Rebuilt on zod's public z.toJSONSchema() instead of the private `_def`
// internals the original walked, so a zod upgrade can't silently break it.
// `io: 'input'` describes what the user types (a transform/pipe exposes its
// input side); `unrepresentable: 'any'` lets refinements and transforms
// through as "no constraint" — they still run on the server.
//
// Supports string fields: required (not optional/nullable/defaulted),
// min/max length, regex pattern, email/url format. A pattern that would
// not compile as an HTML `pattern` (the `v` flag — e.g. an unescaped `-`
// in a character class) is omitted with a warning: browsers silently
// ignore an invalid pattern, so emitting it would only look like a
// constraint.
import { z } from 'zod';

export interface HtmlInputAttrs {
  type?: 'email' | 'url';
  required?: boolean;
  minlength?: number;
  maxlength?: number;
  pattern?: string;
}

type JsonSchemaNode = {
  type?: string;
  format?: string;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  anyOf?: JsonSchemaNode[];
};

function attrsFromNode(node: JsonSchemaNode, required: boolean, field: string): HtmlInputAttrs {
  // nullable → anyOf [T, null]: a field that may be empty is not required
  let n = node;
  let nullable = false;
  if (n.anyOf) {
    const nonNull = n.anyOf.filter(a => a.type !== 'null');
    nullable = nonNull.length !== n.anyOf.length;
    if (nonNull.length !== 1) return {};
    n = nonNull[0]!;
  }
  if (n.type !== 'string') return {};

  const attrs: HtmlInputAttrs = {};
  if (required && !nullable) attrs.required = true;
  if (n.format === 'email') attrs.type = 'email';
  else if (n.format === 'uri') attrs.type = 'url';
  if (n.minLength !== undefined) attrs.minlength = n.minLength;
  if (n.maxLength !== undefined) attrs.maxlength = n.maxLength;
  // A typed field's own format check covers it; zod's email pattern is
  // not meant as an HTML pattern.
  if (n.pattern !== undefined && attrs.type === undefined) {
    if (compilesAsHtmlPattern(n.pattern)) attrs.pattern = n.pattern;
    // console.warn on purpose, not src/lib/logger.ts: this module is
    // Astro-bundled (frontmatter imports it) and the winston logger must
    // stay out of the Vite bundle (docs/conventions/CODE_STYLE.md §6).
    else
      console.warn(
        `zodSchemaToHTMLAttributes: ${field}: pattern /${n.pattern}/ is not valid under the HTML v flag — omitted`,
      );
  }
  return attrs;
}

/** Would the browser accept this as a `pattern` attribute? */
export function compilesAsHtmlPattern(pattern: string): boolean {
  try {
    new RegExp(`^(?:${pattern})$`, 'v');
    return true;
  } catch {
    return false;
  }
}

/**
 * Given a ZodObject schema, return a record mapping each field name
 * to its derived HTML validation attributes.
 *
 * Usage:
 * ```astro
 * const validation = zodSchemaToHTMLAttributes(MySchema);
 * <wa-input name="email" {...validation.email}></wa-input>
 * ```
 */
export function zodSchemaToHTMLAttributes<T extends z.ZodObject<z.ZodRawShape>>(
  schema: T,
): Record<keyof z.input<T> & string, HtmlInputAttrs> {
  const json = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as {
    properties?: Record<string, JsonSchemaNode>;
    required?: string[];
  };
  const required = new Set(json.required ?? []);
  const result: Record<string, HtmlInputAttrs> = {};
  for (const key of Object.keys(schema.shape)) {
    const node = json.properties?.[key];
    result[key] = node ? attrsFromNode(node, required.has(key), key) : {};
  }
  return result as Record<keyof z.input<T> & string, HtmlInputAttrs>;
}
