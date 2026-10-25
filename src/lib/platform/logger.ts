// Server-side logging (never the Astro side: winston stays out of the Vite
// bundle). Console always; winston-loki only when CYBERMOLE_LOKI_URL is set.
// A down loki degrades silently: failed batches are dropped and retried in
// the background, never rejecting into the process.
//
// Console sits at `http` so `debug` (the 15 s poll, asset hits) stays quiet
// there; loki takes everything. Loki labels are kept low-cardinality (job,
// level, component); everything else goes in the line's JSON. Never log
// passwords, tokens or cookie values.
import winston from 'winston';
import LokiTransport from 'winston-loki';
import { readLokiConfig, type LokiConfig } from './env';

export const CONSOLE_LEVEL = 'http';
export const LOKI_LEVEL = 'debug';
/** seconds (winston-loki's unit) */
const LOKI_INTERVAL_S = 5;
/** Without one, a hung (not refused) loki stalls the batch loop forever. */
const LOKI_TIMEOUT_MS = 5_000;
/** At most one console warning per window while loki is down. */
const LOKI_DOWN_WARN_EVERY_MS = 10 * 60 * 1000;

const consolePrintf = winston.format.printf(info => {
  const { level, message, timestamp, labels, ...rest } = info;
  const component = (labels as { component?: string } | undefined)?.component ?? 'server';
  const extra = Object.keys(rest).length > 0 ? ` ${JSON.stringify(rest)}` : '';
  return `${String(timestamp)} ${String(level).padEnd(5)} [${component}] ${String(message)}${extra}`;
});

/** A bare Error JSON-stringifies to {}, losing the stack. */
const serializeErrors = winston.format(info => {
  for (const key of Object.keys(info)) {
    const v = info[key];
    if (v instanceof Error) info[key] = v.stack ?? v.message;
  }
  return info;
})();

/** console.warn, not the logger: logging through the failing transport
 *  would feed the batch that just failed. */
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

export function createLogger(loki: LokiConfig | null): winston.Logger {
  const transports: winston.transport[] = [
    new winston.transports.Console({ level: CONSOLE_LEVEL, format: consolePrintf }),
  ];
  if (loki) {
    transports.push(
      new LokiTransport({
        level: LOKI_LEVEL,
        host: loki.url,
        labels: { job: loki.job },
        interval: LOKI_INTERVAL_S,
        timeout: LOKI_TIMEOUT_MS,
        json: true, // avoids the snappy build
        batching: true,
        clearOnError: true, // bounded memory while loki is down
        replaceTimestamp: false,
        gracefulShutdown: false, // main.ts's SIGTERM path closes the transport
        onConnectionError: lokiDownWarner(),
      }) as winston.transport,
    );
  }
  return winston.createLogger({
    level: LOKI_LEVEL,
    format: winston.format.combine(winston.format.timestamp(), serializeErrors),
    transports,
    exitOnError: false,
  });
}

/** A bad CYBERMOLE_LOKI_* value throws here and stops the boot. */
export const logger: winston.Logger = createLogger(readLokiConfig());

/** Sets the [component] console prefix and the loki `component` label. */
export function componentLogger(component: string): winston.Logger {
  return logger.child({ labels: { component } });
}

/** Capped so a hanging loki can't stall shutdown. */
export async function closeLogger(target: winston.Logger = logger): Promise<void> {
  const closed = Promise.allSettled(
    target.transports.map(t => Promise.resolve().then(() => t.close?.())),
  );
  const cap = new Promise<void>(resolve => {
    setTimeout(resolve, 1_500).unref();
  });
  await Promise.race([closed, cap]);
}
