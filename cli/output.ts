// output.ts — the CLI's console plumbing (task/jobs-cli,
// docs/plans/jobs-agent-plan.md §5): injected writers so the unit tests
// capture stdout/stderr in-process (no spawning for every verb), plus
// the small presentation helpers — aligned tables, local timestamps,
// truncation — every verb shares. Plain process.stdout/stderr writes on
// purpose, set-password.ts's stance: a human/agent-facing CLI, not a
// server component, so no src/lib/logger.ts (winston would timestamp
// output that scripts parse).
import type { IncomingHttpHeaders } from 'node:http';

/** Where a command writes. Both write the text given, completing a
 *  missing final newline (tables and one-liners compose their own
 *  newlines; a raw log tail that already ends in one stays verbatim). */
export interface Output {
  out(text: string): void;
  err(text: string): void;
}

export function consoleOutput(): Output {
  const write = (stream: NodeJS.WriteStream, text: string): void => {
    stream.write(text === '' || text.endsWith('\n') ? text : `${text}\n`);
  };
  return {
    out: text => write(process.stdout, text),
    err: text => write(process.stderr, text),
  };
}

/** One answer from the internal API, headers included: the log tail's
 *  truncation marker rides a header (X-Run-Log-Truncated), so callers
 *  need more than status + body. */
export interface ApiResponse {
  status: number;
  headers: IncomingHttpHeaders;
  text: string;
}

/** Local-time "YYYY-MM-DD HH:mm" — the schedule fields are local time
 *  and the /jobs page formats them the same way (src/lib/jobs.ts
 *  formatFire). The list verb prints the server's pre-formatted strings;
 *  runs rows carry raw epoch ms, so the CLI renders those itself. */
export function formatLocalMs(ms: number): string {
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}`
  );
}

/** Shorten to `max` chars with an ellipsis (table cells are pre-sized;
 *  --json carries the untruncated fields). */
export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** One aligned table: headers + rows, two-space gutters, no wrapping —
 *  callers truncate cells first. An empty row set renders headers only. */
export function renderTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map(r => (r[i] ?? '').length)));
  const line = (cells: string[]): string =>
    cells.map((c, i) => (i === widths.length - 1 ? c : c.padEnd(widths[i] ?? 0))).join('  ');
  return [line(headers), ...rows.map(line)].join('\n');
}
