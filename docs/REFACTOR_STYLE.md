# REFACTOR_STYLE.md

Supplement to `docs/CODE_STYLE.md`, for porting existing cybermole code into
those conventions. Correctness only; formatting stays as the surrounding
code has it.

## What you are removing

1. **Error signalling by anything other than a Result.** Each of these
   becomes a closed `errorCode` on a failure result:

   | Before | After |
   | --- | --- |
   | node callback `(err, value)` | `Promise<XResult>` |
   | `Error \| null` return | `Result` with `errorCode` |
   | `throw` for an expected condition | `errorCode` (keep `throw` for bugs only) |
   | `err.message.startsWith(KNOWN_MSG)` / `r.error === CONST` | `switch (r.errorCode)` |
   | `{ ok, status, error }` with an HTTP status in a domain module | domain `errorCode`; status mapped in `responses.service.ts` |

   Afterwards, delete every `try/catch` whose only job was translating a
   domain-level throw. The translation now happens once, at the boundary.
2. **Ad-hoc result shapes → one family per concern** (`*Data`,
   `*ErrorCode`, `*Success`, `*Failure`, `*Result`). Keep identity and
   context on failures that consumers act on.
3. **Bare `string` IDs → brands.** Brand at the trust boundary (schema
   for untrusted input, `as*` for trusted sources). Push the brand into
   every signature that takes the ID.
4. **Validation scattered through handlers → a schema in `src/schemas/`**
   used by both the server and the browser.
5. **Hand-routed endpoints in `server/main.ts` → thin Astro routes** that
   get services from `locals.cybermole`. Keep the main.ts gate in front.

## Recipe (per module)

1. Read the module end to end. List every throw, every failure return
   shape, every string comparison on an error, and every caller.
2. Check the callers **before** choosing error codes, so the codes match
   the decisions the callers actually make. Don't invent codes nobody
   branches on, but do split a code wherever a caller needs to tell two
   failures apart.
3. Define the families, convert the boundary (catch → failure), then
   convert the layers above it (`if (!r.ok) return r` / `switch`).
4. Update every caller in the same change. No compatibility shims, and
   no re-exports from the old path: move the symbol and update the imports.
5. Add tests for each new error code. Keep wire responses (status codes,
   bodies the browser reads) unchanged unless the change is the point,
   and the e2e suite will tell you if they moved.
6. Run `npm run build && npm run lint && npm run check && npm run test:unit && npm run test:e2e`.

## Don't

- Mix a refactor with a feature. Note the bug and fix it separately.
- Introduce `any` or `as` casts to ease migration. A cast belongs only at
  a trust boundary, through a brand helper.
- Leave legacy result shapes alongside new ones.
