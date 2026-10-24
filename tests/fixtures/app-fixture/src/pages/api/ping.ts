// The fixture's one API route: zod in → Result JSON out, hand-rolled in
// the console's wire shapes ({ ok, resultType, data } success bodies and
// { error, code, issues? } failures — the responses.service mapping; the
// app-kit binder generates this shape per table entry in a later branch,
// the fixture hand-rolls it).
import type { APIRoute } from 'astro';
import { z } from 'zod';

const PingQuery = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'name is required')
    .max(64, 'name is too long (max 64 chars)'),
});

const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

export const GET: APIRoute = ({ url }) => {
  const parsed = PingQuery.safeParse({ name: url.searchParams.get('name') ?? '' });
  if (!parsed.success) {
    const issues: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0] ?? '');
      issues[key] = issue.message;
    }
    return json({ error: issues.name ?? 'invalid name', code: 'validation_failure', issues }, 400);
  }
  return json(
    {
      ok: true,
      resultType: 'ping',
      data: { hello: parsed.data.name, at: Date.now() },
    } satisfies { ok: true; resultType: 'ping'; data: { hello: string; at: number } },
    200,
  );
};
