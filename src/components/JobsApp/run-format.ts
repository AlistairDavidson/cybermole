// run-format.ts — run-history display formatters, shared by the
// server-rendered history rows (JobDetailBody.astro frontmatter) and the
// client-side ones (jobs-app.ts's runs dialog). Pure date/string math.

/** Local "YYYY-MM-DD HH:mm:ss" — the run's identity on every surface. */
export const fmtRunTime = (ms: number): string => {
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
};

/** A run's duration, finish-observed minus fired (tick granularity). */
export const fmtDuration = (from: number, to: number): string => {
  const s = Math.max(0, (to - from) / 1000);
  return s < 60
    ? `${s.toFixed(1)}s`
    : `${Math.floor(s / 60)}m ${String(Math.round(s % 60)).padStart(2, '0')}s`;
};
