// Shared by the server-rendered and client-side run history.

/** Local "YYYY-MM-DD HH:mm:ss". */
export const fmtRunTime = (ms: number): string => {
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
};

/** Observed finish minus fire time, so tick granularity. */
export const fmtDuration = (from: number, to: number): string => {
  const s = Math.max(0, (to - from) / 1000);
  return s < 60
    ? `${s.toFixed(1)}s`
    : `${Math.floor(s / 60)}m ${String(Math.round(s % 60)).padStart(2, '0')}s`;
};
