// frames.ts — the terminal WebSocket's client→server frames. Node-free
// (docs/CODE_STYLE.md §5): server/main.ts validates every frame with
// parseClientMsg, and the browser's agent-terminal.ts sends the ClientMsg
// type z.infer'd from the same schemas — the protocol is described once.
import { z } from 'zod';

// A big paste arrives as several consecutive input frames
// (agent-terminal.ts chunks it).
const inputMsg = z.object({ type: z.literal('input'), data: z.string() });
const resizeMsg = z.object({ type: z.literal('resize'), cols: z.number(), rows: z.number() });
// attach target/id stay plain strings here on purpose: server/main.ts
// brands them (TmuxSessionNameSchema / PiSessionIdSchema / TerminalIdSchema)
// so a bad one answers an error frame ('bad target', 'no such session')
// instead of the frame being silently dropped.
const attachLiveMsg = z.object({ type: z.literal('attach'), mode: z.literal('live'), target: z.string() });
const attachResumeMsg = z.object({ type: z.literal('attach'), mode: z.literal('resume'), id: z.string() });
// task/ws-terminal (plan §7): the terminal tab and job-run attach modes.
// A terminal attach carries the terminal row's uuid (the server derives
// t-<uuid> and RESPAWNS the session if it died — restart survival, §4); a
// run attach carries a live job run's tmux session name and NEVER
// respawns. They join live/resume additively — branch 4 deletes the old
// two with the UI that sends them.
const attachTerminalMsg = z.object({ type: z.literal('attach'), mode: z.literal('terminal'), id: z.string() });
const attachRunMsg = z.object({ type: z.literal('attach'), mode: z.literal('run'), target: z.string() });
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
const clientMsgSchema = z.union(
  [inputMsg, resizeMsg, attachLiveMsg, attachResumeMsg, attachTerminalMsg, attachRunMsg]);
export type ClientMsg = z.infer<typeof clientMsgSchema>;

/** One client frame, or null for anything the schemas reject (bad JSON,
 *  `null`, arrays, non-objects, missing/mistyped fields, unknown type) —
 *  callers DROP malformed frames, they are never thrown on. */
export function parseClientMsg(raw: string): ClientMsg | null {
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return null; }
  const r = clientMsgSchema.safeParse(v);
  return r.success ? r.data : null;
}
