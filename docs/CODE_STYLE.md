# CODE_STYLE.md

Correctness conventions for cybermole. This file is about **using the type system and boundaries correctly**, not formatting: match the formatting and comment density of the code around you. Read it before touching `src/lib`, `src/schemas`, an API route, or a form. Porting old code into these conventions: `docs/REFACTOR_STYLE.md`.

---

## 1. `Result` is the contract for anything that can fail

`@cybermole/app-kit` (`packages/app-kit/src/types/result.ts` — moved there from src/ by task/app-kit):

```ts
export type Result<ResultType extends string, DataType extends object, ErrorCodeType extends string> =
  | ResultSuccess<ResultType, DataType>   // { ok: true;  resultType; data }
  | ResultFailure<ResultType, DataType, ErrorCodeType>; // { ok: false; resultType; data?; errorCode; errorMessage?; issues? }
```

`ResultFailure` distributes over `ErrorCodeType`, so every error code is
its own union member and a `switch` on `errorCode` narrows exactly.

### Declare a family per concern

```ts
export type SaveJobData      = { name: JobName };
export type SaveJobErrorCode = 'invalid_job_name' | 'command_required' | 'invalid_schedule' | 'database_error';
export type SaveJobSuccess   = ResultSuccess<'save_job', SaveJobData>;
export type SaveJobFailure   = ResultFailure<'save_job', SaveJobData, SaveJobErrorCode>;
export type SaveJobResult    = SaveJobSuccess | SaveJobFailure;
```

- `resultType` is unique per family. It discriminates when several
  families flow through one code path.
- `ErrorCode` is a **closed** string union. Adding a code is then a type
  error at every `switch` that doesn't handle it.
- Put `data` on a failure when the consumer still needs identity or
  context (e.g. a failed pi update still carries its npm output).

### Return with `satisfies`, not a return-type annotation

```ts
return { ok: false, resultType: 'save_job', errorCode: 'invalid_job_name',
  errorMessage: 'invalid job name' } satisfies SaveJobFailure;
```

`satisfies` keeps each literal's `errorCode` narrow, and leaving the
function's return type to inference means callers see exactly the codes it
can emit, not every code the family allows.

---

## 2. Control flow: catch at the boundary, propagate above it

- **Only the boundary layer catches.** That's the code that actually calls
  sqlite (`StateDb.all`/`get`/`run`, typed with Kysely via `qb`), `execFile`/tmux, npm, or the filesystem. It
  turns the exception into a failure result and returns.
- **Above the boundary**, propagate with `if (!result.ok) return result;`.
  When a parent needs its own family, build a new failure carrying the
  child's `errorCode` and `errorMessage`.
- **Branch on `errorCode` with an exhaustive `switch`** that ends
  `default: return result satisfies never;`.
- **Never compare error message strings** (`err.message.startsWith(…)`,
  `r.error === BUSY_ERROR`). If a caller needs to tell two failures apart,
  they need two error codes.
- **Never throw for an expected condition.** Not found, busy, invalid
  input, server not running, a duplicate: these are error codes. Throw
  only for broken invariants (bugs). `server/main.ts`'s last-resort
  `try/catch` around the request handler stays as a crash guard, not a
  control-flow tool.
- **Functions that can't fail by design** (e.g. `tmux.hasSession`, which
  reads "error" as "no") may return a plain value. Say so where they're
  declared.

## 3. HTTP status codes live in the HTTP layer

Domain modules (`src/lib/*`) never know about HTTP. Error codes map to
statuses in one exhaustive switch per family, in
`src/lib/web/responses.service.ts` (generic half in `@cybermole/app-kit`). That's the only place where "job not
found" becomes 404 or "busy" becomes 409.

## 4. Branded IDs

`@cybermole/app-kit`'s `types/branded.ts` defines nominal types for every ID that crosses a
module boundary: `PiSessionId`, `TmuxSessionName`, `JobName`,
`SessionToken`. A bare `string` is not accepted where one is expected, so
`hasSession(jobName)` (instead of `hasSession(jobSessionName(jobName))`)
is a type error.

- **Untrusted input** (request bodies, path params, WS frames) gets its
  brand by passing the validating schema in the kit's `schemas/ids.ts`
  (`JobNameSchema`, `PiSessionIdSchema`, …). The regex and the brand
  live together there.
- **Trusted sources** (pi's own session files, tmux output, a token the
  server just minted, a cookie value about to be looked up) may cast with
  `asJobName()` / `asPiSessionId()` / … at the point they enter.
- Prefer closed string unions over `string` for any field with a known set
  of values.

## 5. Schemas: one definition, shared by server and browser

- Wire shapes (request bodies, WS frames, form inputs) are zod schemas
  under `src/schemas/`. **No Node imports there**: the browser bundles the
  same schemas for client-side validation.
- Derive the TypeScript types with `z.infer`. Don't hand-write a type for
  a shape a schema already describes.
- Parse at the boundary: `parseAndValidateAPIRequest(request, Schema)` in
  an API route, `parseZod(value, Schema)` elsewhere. Both return a
  `Result` with per-field `issues`.
- Regexes in schemas also become HTML `pattern` attributes, which compile
  with the `v` flag. Escape a literal `-` in a character class (`[a-z0-9_\-]`).
  `tests/unit/zod-attributes.test.mjs` guards this.

## 6. API routes: thin, and always behind the main.ts gate

- JSON endpoints are Astro routes under `src/pages/api/`. A handler
  parses, calls one domain function, and maps the result. No `try/catch`
  in handlers.
- **Services come from `Astro.locals.cybermole`** (`src/lib/services.ts`,
  narrowed with `assertCybermoleLocals`). Never construct or import a stateful
  singleton (`StateDb`, `Auth`, `Scheduler`) inside the Astro bundle. Vite
  would bundle a second copy with its own state: a second scheduler with its
  own tick loop, a second `runPiUpdate` busy flag letting a manual and an
  automatic update race npm, a second `StateDb` connection. `server/main.ts` builds the
  services once and passes them to the Astro handler.
- **What Astro code may runtime-import:** `astro`, `src/lib/web/*`,
  `src/schemas/*`, and `import type` from anything. Anything else from
  `src/lib` is reached through `locals.cybermole`. (Check:
  `grep -r auth_sessions dist/server` should find nothing.)
- **Content types:** API bodies are parsed only as `application/json` or
  form-urlencoded; anything else is 415. The exception is a file upload:
  `multipart/form-data`, streamed through `streamFileUpload` (or, for a
  small file next to other form logic, buffered by `parseFileUpload`).
- **Security invariants.** Changing any of these is a security change:
  - `server/main.ts` runs the origin check and the session check *before*
    anything reaches Astro, and only passes `locals` on the authenticated
    path.
  - `src/middleware.ts` fails closed: `/api/*` and `/partials/*` answer
    503 when `locals.cybermole` is missing (`astro dev`, or the Astro handler
    run on its own). The data pages (settings, jobs) take the
    same stance in their frontmatter: `assertCybermoleLocals` (src/lib/web/
    locals.ts) throws — a page without the services is a broken
    invariant, never a loading placeholder the client fills in.
  - The adapter's `bodySizeLimit` is set (its default is 1 GiB) — to the
    upload cap, `UPLOAD_MAX_BODY_BYTES`, since it is global; every other
    route keeps 10 KiB through `server/main.ts`'s per-route cap
    (`bodyCapStatus`), which runs before Astro reads the body. A new
    route that takes large bodies gets its own entry there.
  - Node's `requestTimeout` is off; `server/main.ts` enforces the same
    5-minute whole-body deadline per request (`armBodyDeadline`), and
    only the upload route swaps it for a stall timeout
    (`guardUploadStall`).
  - Astro's `security.checkOrigin` is off because main.ts's trustProxy-aware
    `originOk()` is authoritative. Astro's own check derives the origin from
    the request URL, which is wrong behind a TLS proxy.
  - The WebSocket upgrade, login, logout and log-out-everywhere stay in
    main.ts: rate limiter, fail2ban's 401 semantics, socket tracking.

## 7. Pages: server-rendered first, enhanced by HTML web components

- Render data in the page's frontmatter so it arrives as HTML: get the
  services with `assertCybermoleLocals(Astro.locals)` — the render throws
  without them (the gate is the only renderer that has them; in dev,
  browse the `dev:server` process), never a placeholder the element
  fills in. A failed service call renders its error message instead. A
  custom element (light DOM, `connectedCallback`) enhances that markup:
  wiring buttons, polling, dialogs.
- Refresh by fetching a server-rendered partial (`src/pages/partials/*`,
  `export const partial = true`) and swapping it in. Don't template HTML
  strings in the browser.
- Guard every registration:
  `if (!customElements.get('x-y')) customElements.define('x-y', XY);`.
- Every SSR'd `wa-*` component must also be imported client-side, after
  the astro-lit support modules (AGENTS.md has the details).

## 8. Forms

- Wrap the form in `<validation-enhancer-zod>` and give it the same schema
  the server validates with (`setZodSchema(Schema)`).
- Put each field's error in its `hint` slot, via
  `src/components/form/WaField.astro` (`as="textarea"` for a textarea). The
  inner input's `aria-describedby` points at the hint slot, so screen
  readers associate the message. An `aria-errormessage` on the `wa-input`
  host doesn't reach the inner input.
- Spread `zodSchemaToHTMLAttributes(Schema)` onto the fields so the native
  constraints (`required`, `minlength`, `pattern`, …) match the schema.
- Handle `submit` on an element **above** the enhancer. It stops invalid
  submits from propagating, but a listener on the form itself fires
  before validation.
- A 400 from the server carries `issues`. Show them in the same error
  elements.

## 9. Tests

- Every Result family gets a test per error code, not just the happy path.
- Unit tests (`tests/unit/*.test.mjs`, node:test) run against the
  compiled `dist-server/`. Pure modules under `src/lib`, `src/schemas` and
  `src/types` are reachable there.
- e2e rules (serial, shared login budget, in-page `fetch`) are in
  AGENTS.md.
