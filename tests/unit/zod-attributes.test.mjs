// zod-attributes.test.mjs — zodSchemaToHTMLAttributes (src/lib/web/zod.service.ts):
// soothing-booking's cases ported to the toJSONSchema rebuild, plus the
// HTML-pattern guard — every pattern the app's form schemas emit must
// compile under the `v` flag browsers use for `pattern` (an invalid one is
// silently ignored by the browser, so it must never be emitted).
import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import {
  compilesAsHtmlPattern,
  zodSchemaToHTMLAttributes,
} from '../../dist-server/src/lib/web/zod.service.js';
import { JobSaveSchema } from '../../dist-server/src/schemas/jobs.js';
import { loginForm } from '../../dist-server/src/schemas/api.js';
import { UUID_RE } from '../../dist-server/src/schemas/patterns.js';
import { JobNameSchema, TmuxSessionNameSchema } from '../../dist-server/src/schemas/ids.js';

const attrs = shape => zodSchemaToHTMLAttributes(z.object(shape));

test('marks required string fields; optional, nullable and defaulted ones are not', () => {
  assert.deepEqual(attrs({ a: z.string() }).a, { required: true });
  assert.deepEqual(attrs({ a: z.string().optional() }).a, {});
  assert.deepEqual(attrs({ a: z.string().nullable() }).a, {});
  assert.deepEqual(attrs({ a: z.string().default('x') }).a, {});
});

test('min / max length, regex pattern, email and url types', () => {
  assert.deepEqual(attrs({ a: z.string().min(2) }).a, { required: true, minlength: 2 });
  assert.deepEqual(attrs({ a: z.string().max(9) }).a, { required: true, maxlength: 9 });
  assert.deepEqual(attrs({ a: z.string().regex(/^[a-z]+$/) }).a, {
    required: true,
    pattern: '^[a-z]+$',
  });
  assert.deepEqual(attrs({ a: z.email() }).a, { required: true, type: 'email' }); // no zod email pattern
  assert.deepEqual(attrs({ a: z.url() }).a, { required: true, type: 'url' });
});

test('combines checks on one field, and keeps them through optional/nullable wrappers', () => {
  assert.deepEqual(attrs({ a: z.string().min(1).max(5).regex(/^x+$/) }).a, {
    required: true,
    minlength: 1,
    maxlength: 5,
    pattern: '^x+$',
  });
  assert.deepEqual(attrs({ a: z.string().min(3).optional() }).a, { minlength: 3 });
  assert.deepEqual(attrs({ a: z.string().max(3).nullable() }).a, { maxlength: 3 });
});

test('non-string fields get no attributes; refinements and transforms are skipped, not fatal', () => {
  assert.deepEqual(attrs({ n: z.number().min(1), b: z.boolean() }), { n: {}, b: {} });
  assert.deepEqual(attrs({ a: z.string().refine(v => v !== 'x') }).a, { required: true });
  // a pipe exposes its INPUT side: the user types anything that normalizes validly
  assert.deepEqual(
    attrs({
      a: z
        .string()
        .transform(v => v.trim())
        .pipe(z.string().regex(/^a$/)),
    }).a,
    { required: true },
  );
});

test('a pattern the browser would reject (v flag) is omitted, never emitted', t => {
  const warn = t.mock.method(console, 'warn', () => {});
  assert.equal(compilesAsHtmlPattern('^[a-z-]+$'), false); // unescaped - in a class
  assert.equal(compilesAsHtmlPattern('^[a-z\\-]+$'), true);
  assert.deepEqual(attrs({ a: z.string().regex(/^[a-z-]+$/) }).a, { required: true });
  assert.equal(warn.mock.callCount(), 1);
});

test('the app’s form schemas: the attributes the forms render', () => {
  assert.deepEqual(zodSchemaToHTMLAttributes(JobSaveSchema), {
    name: { required: true, maxlength: 40 }, // typed length only: the charset applies after normalizing
    schedule: { required: true, minlength: 1, maxlength: 120, pattern: '^[^\\r\\n]*$' },
    command: { required: true, minlength: 1, maxlength: 4000, pattern: '^[^\\r\\n]*$' },
    appId: { pattern: UUID_RE.source }, // optional tag (task/ws-schema); not required, just shaped
  });
  assert.deepEqual(zodSchemaToHTMLAttributes(loginForm), {
    username: { required: true, minlength: 1 },
    password: { required: true, minlength: 1 },
  });
});

test('every pattern an app schema emits compiles under the v flag', () => {
  const schemas = [
    JobSaveSchema,
    loginForm,
    z.object({ a: JobNameSchema, b: TmuxSessionNameSchema }),
  ];
  for (const schema of schemas) {
    for (const [field, a] of Object.entries(zodSchemaToHTMLAttributes(schema))) {
      if (a.pattern !== undefined)
        assert.equal(compilesAsHtmlPattern(a.pattern), true, `${field}: ${a.pattern}`);
    }
  }
  // and the ID schemas really do emit theirs (the escaped hyphens are why they pass)
  const ids = zodSchemaToHTMLAttributes(z.object({ a: JobNameSchema, b: TmuxSessionNameSchema }));
  assert.ok(ids.a.pattern && ids.b.pattern);
});
