// frames.ts — the terminal WebSocket's client→server frames. Node-free
// (docs/conventions/CODE_STYLE.md §5): server/main.ts validates every frame with
// parseClientMsg, and the browser's agent-terminal.ts sends the ClientMsg
// type z.infer'd from the same schemas — the protocol is described once.
import { z } from 'zod';

// A big paste arrives as several consecutive input frames
// (agent-terminal.ts chunks it).
const inputMsg = z.object({ type: z.literal('input'), data: z.string() });
const resizeMsg = z.object({ type: z.literal('resize'), cols: z.number(), rows: z.number() });
// attach target/id stay plain strings here on purpose: server/main.ts
// brands them (TmuxSessionNameSchema / TerminalIdSchema) so a bad one
// answers an error frame ('bad target', 'no such terminal') instead of the
// frame being silently dropped. The two workspace-model modes (plan §7):
// 'terminal' carries the terminal row's uuid (the server derives t-<uuid>
// and RESPAWNS the session if it died — restart survival, §4); 'run'
// carries a live job run's tmux session name and NEVER respawns.
const attachTerminalMsg = z.object({
  type: z.literal('attach'),
  mode: z.literal('terminal'),
  id: z.string(),
});
const attachRunMsg = z.object({
  type: z.literal('attach'),
  mode: z.literal('run'),
  target: z.string(),
});
// Not z.discriminatedUnion('type', …): the attach variants share the
// 'attach' discriminator value and zod v4 rejects duplicates — this flat
// union has identical semantics. Member order follows the hot path:
// input (every keystroke/chunk) first, resize next, attach variants last
// (once per connection). Unknown extra keys are tolerated (stripped),
// exactly like the hand-rolled checks this replaced. One known delta:
// zod's z.number() is finite-only, so a resize with an overflowing JSON
// number (1e999 → Infinity, accepted-then-clamped before) is now dropped
// — unreachable from the real client (xterm sends integer dims) and the
// designed failure mode for junk frames.
const clientMsgSchema = z.union([inputMsg, resizeMsg, attachTerminalMsg, attachRunMsg]);
export type ClientMsg = z.infer<typeof clientMsgSchema>;

// The one SERVER frame the browser validates: 'backfill' bulk-writes a
// large blob into the terminal buffer, so a malformed frame must be
// dropped (below), not garble the terminal. Every other ServerMsg
// (src/lib/platform/types.ts) stays trusted-and-unparsed — the server wrote it,
// a parse would be ceremony.
const backfillMsgSchema = z.object({ type: z.literal('backfill'), data: z.string() });
export type BackfillMsg = z.infer<typeof backfillMsgSchema>;

/** One 'backfill' server frame, or null for anything the schema rejects
 *  (bad JSON, non-objects, a non-string `data`) — dropped, never thrown
 *  on, exactly like the client-frame gate. */
export function parseBackfillMsg(raw: string): BackfillMsg | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  const r = backfillMsgSchema.safeParse(v);
  return r.success ? r.data : null;
}

/** One client frame, or null for anything the schemas reject (bad JSON,
 *  `null`, arrays, non-objects, missing/mistyped fields, unknown type) —
 *  callers DROP malformed frames, they are never thrown on. */
export function parseClientMsg(raw: string): ClientMsg | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  const r = clientMsgSchema.safeParse(v);
  return r.success ? r.data : null;
}
