// logger.ts — winston-based operational logging for the server side
// (server/main.ts and the src/lib boundary modules; NEVER the Astro side —
// docs/CODE_STYLE.md §6 keeps winston out of the Vite bundle on purpose).
//
// Transports: a console transport ALWAYS (pretty, human-readable — the boot
// log and the e2e webServer stderr are read by humans), and a winston-loki
// transport ONLY when CYBERMOLE_LOKI_URL is configured (src/lib/env.ts,
// readLokiConfig). Unset, the logger is console-only and behaves exactly
// like the console.* calls it replaced: no network, no retries, no startup
// delay. Set, a down loki degrades silently: winston-loki batches on a 5 s
// interval, drops the failed batch (clearOnError — bounded memory), retries
// on its built-in 60 s circuit-breaker backoff, and never rejects into the
// process (verified: the batch loop catches its own sends; see
// tests/unit/logger.test.mjs).
//
// Levels (winston's npm set): error / warn / info for events, `http` for
// the access log (server/main.ts), `debug` for what would bury an open
// console — the 15 s /api/state poll line and hashed-asset hits. The
// console transport sits at `http` (debug stays console-silent); the loki
// transport at `debug` (everything is queryable there, where volume is
// cheap).
//
// Loki label scheme (low cardinality by design — labels index streams):
//   job       static, from CYBERMOLE_LOKI_JOB (default 'cybermole')
//   level     winston-loki adds it from the log level
//   component the module that emitted the line (componentLogger() below)
// Everything else (paths, durations, session names, usernames) rides in
// the JSON of the line itself, never in labels. Never logged at all:
// passwords, tokens, cookie values.
import winston from 'winston';
import LokiTransport from 'winston-loki';
import { readLokiConfig, type LokiConfig } from './env';

/** Console shows error/warn/info plus the `http` access log; `debug` lines
 *  (the /api/state poll, asset hits) stay console-silent but reach loki. */
export const CONSOLE_LEVEL = 'http';
export const LOKI_LEVEL = 'debug';
/** Batch window for the loki push (seconds — winston-loki's unit). */
const LOKI_INTERVAL_S = 5;
/** Per-push timeout: without one, a hung (not refused) loki stalls the
 *  batch loop forever — requests.js only aborts on its own timeout. */
const LOKI_TIMEOUT_MS = 5_000;
/** While loki is down, at most one warn line per window on the console —
 *  silent degradation, not a per-retry drumbeat. */
const LOKI_DOWN_WARN_EVERY_MS = 10 * 60 * 1000;

const consolePrintf = winston.format.printf(info => {
  const { level, message, timestamp, labels, ...rest } = info;
  const component = (labels as { component?: string } | undefined)?.component ?? 'server';
  const extra = Object.keys(rest).length > 0 ? ` ${JSON.stringify(rest)}` : '';
  return `${String(timestamp)} ${String(level).padEnd(5)} [${component}] ${String(message)}${extra}`;
});

/** Error-valued meta (the crash guards pass raw Errors) becomes its stack
 *  string here, at the logger level — so the console printf AND the loki
 *  line JSON (which stringifies meta itself) both show it; a bare Error
 *  stringifies to {} in JSON and the stack would be lost. */
const serializeErrors = winston.format(info => {
  for (const key of Object.keys(info)) {
    const v = info[key];
    if (v instanceof Error) info[key] = v.stack ?? v.message;
  }
  return info;
})();

/** The push-failure reporter handed to winston-loki: throttled to one line
 *  per LOKI_DOWN_WARN_EVERY_MS. Deliberately console.warn, not the logger —
 *  a transport failure logged through the failing transport would feed back
 *  into the very batch that just failed. */
function lokiDownWarner(): (err: unknown) => void {
  let lastWarn = 0;
  return (err: unknown): void => {
    const now = Date.now();
    if (now - lastWarn < LOKI_DOWN_WARN_EVERY_MS) return;
    lastWarn = now;
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`loki: push failed (${reason}) — logging continues, retrying in the background`);
  };
}

/** Build a logger: console transport always; the loki transport only for a
 *  non-null config (the module-level `logger` below reads the env — tests
 *  call this directly with both shapes). */
export function createLogger(loki: LokiConfig | null): winston.Logger {
  const transports: winston.transport[] = [
    new winston.transports.Console({ level: CONSOLE_LEVEL, format: consolePrintf }),
  ];
  if (loki) {
    transports.push(
      new LokiTransport({
        level: LOKI_LEVEL,
        host: loki.url,
        // static stream label; level + component join it per line
        labels: { job: loki.job },
        interval: LOKI_INTERVAL_S,
        timeout: LOKI_TIMEOUT_MS,
        json: true, // plain JSON push — pulls in no snappy build
        batching: true, // buffer and send per interval, not per line
        clearOnError: true, // a failed batch is dropped: bounded memory while loki is down
        replaceTimestamp: false, // keep the event time the format stamped below
        gracefulShutdown: false, // server/main.ts's own SIGTERM path closes the transport — no second exit hook
        onConnectionError: lokiDownWarner(),
      }) as winston.transport,
    );
  }
  return winston.createLogger({
    level: LOKI_LEVEL,
    // ISO timestamp: console prints it, loki keeps it as the entry time —
    // then Errors in meta become printable before any transport sees them.
    format: winston.format.combine(winston.format.timestamp(), serializeErrors),
    transports,
    exitOnError: false,
  });
}

/** The server's logger, configured once from the env at module load. A bad
 *  CYBERMOLE_LOKI_* value throws here — the boot stops, same contract as the
 *  S3 vars (src/lib/env.ts). */
export const logger: winston.Logger = createLogger(readLokiConfig());

/** Child logger tagged with a component: the [component] console prefix and
 *  the loki `component` stream label. */
export function componentLogger(component: string): winston.Logger {
  return logger.child({ labels: { component } });
}

/** Flush and close every transport (winston-loki's close() sends its last
 *  batch). Capped: a hanging loki must not stall the shutdown past its
 *  deadline — main.ts's process-exit backstop stays authoritative. */
export async function closeLogger(target: winston.Logger = logger): Promise<void> {
  const closed = Promise.allSettled(
    target.transports.map(t => Promise.resolve().then(() => t.close?.())),
  );
  const cap = new Promise<void>(resolve => {
    setTimeout(resolve, 1_500).unref();
  });
  await Promise.race([closed, cap]);
}
