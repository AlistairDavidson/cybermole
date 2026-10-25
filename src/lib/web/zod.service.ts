// HTML validation attributes from a zod object schema, so inputs carry the
// same native constraints the server enforces. Built on z.toJSONSchema()
// rather than zod internals. `io: 'input'` describes what the user types;
// refinements and transforms pass as "no constraint" (the server still runs
// them). A pattern that won't compile under the HTML `v` flag is omitted
// with a warning, since browsers silently ignore an invalid pattern.
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
  // nullable is anyOf [T, null]: not required
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
  // A typed field's format check covers it; zod's email pattern isn't meant for HTML.
  if (n.pattern !== undefined && attrs.type === undefined) {
    if (compilesAsHtmlPattern(n.pattern)) attrs.pattern = n.pattern;
    // console.warn: this module is Astro-bundled, and winston must stay out of the bundle.
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
