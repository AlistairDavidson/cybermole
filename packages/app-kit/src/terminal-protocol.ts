// The terminal WS wire protocol, node-free: the console's rich client
// (src/components/AgentTerminal), the app pages' lean drawer client
// (./agent-console) and server/main.ts's frame gate all share this one
// definition. The client frames are zod schemas (the server parses with
// parseClientMsg); ServerMsg is never parsed, so stays hand-written.
import { z } from 'zod';
import type { TerminalId, TmuxSessionName } from './types/branded';

// Big pastes arrive as several input frames.
const inputMsg = z.object({ type: z.literal('input'), data: z.string() });
const resizeMsg = z.object({ type: z.literal('resize'), cols: z.number(), rows: z.number() });
// Targets stay plain strings: the server brands them so a bad one gets an
// error frame rather than being silently dropped. 'terminal' carries the
// row uuid (respawned if dead); 'run' a live job run's session (never respawned).
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
// Not discriminatedUnion: the attach variants share a discriminator value,
// which zod v4 rejects. Ordered by frequency (input first). z.number() is
// finite-only, so an Infinity resize is dropped.
const clientMsgSchema = z.union([inputMsg, resizeMsg, attachTerminalMsg, attachRunMsg]);
export type ClientMsg = z.infer<typeof clientMsgSchema>;

// The one server frame clients validate: a malformed backfill would garble
// the terminal buffer.
const backfillMsgSchema = z.object({ type: z.literal('backfill'), data: z.string() });
export type BackfillMsg = z.infer<typeof backfillMsgSchema>;

export type ServerMsg =
  | { type: 'attached'; target: TmuxSessionName; socket: string }
  | { type: 'output'; data: string }
  /** Scrollback history, sent once before any 'output'; the client writes it
   *  and pushes the viewport down so the attach redraw lands below it. */
  | { type: 'backfill'; data: string }
  | { type: 'exit'; target: TmuxSessionName }
  | { type: 'error'; message: string }
  /** the token was dropped (logout); don't reconnect */
  | { type: 'signed-out' }
  /** server shutting down; reconnect with the usual backoff */
  | { type: 'restart' };

/** A client's selected target: a terminal tab or a live job run. */
export type ActiveKey = `terminal:${TerminalId}` | `run:${TmuxSessionName}`;

/** null for anything the schema rejects; dropped, never thrown on. */
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

/** null for anything the schemas reject; callers drop it. */
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
