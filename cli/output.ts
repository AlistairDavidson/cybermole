// Injected writers (so unit tests capture output in-process) and shared
// presentation helpers. Plain stdout/stderr, not winston: scripts parse this.
import type { IncomingHttpHeaders } from 'node:http';

/** Adds a final newline only if missing, so a raw log tail stays verbatim. */
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

/** Headers included: the log tail's truncation flag rides X-Run-Log-Truncated. */
export interface ApiResponse {
  status: number;
  headers: IncomingHttpHeaders;
  text: string;
}

/** Local "YYYY-MM-DD HH:mm", like the /jobs page. Run rows carry epoch ms. */
export function formatLocalMs(ms: number): string {
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}`
  );
}

/** --json carries the untruncated fields. */
export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** Two-space gutters, no wrapping; truncate cells first. */
export function renderTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map(r => (r[i] ?? '').length)));
  const line = (cells: string[]): string =>
    cells.map((c, i) => (i === widths.length - 1 ? c : c.padEnd(widths[i] ?? 0))).join('  ');
  return [line(headers), ...rows.map(line)].join('\n');
}
