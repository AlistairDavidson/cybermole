// debounce.ts — shared trailing-edge debounce. One implementation for
// the jobs pages' /ws/events subscription (several bus events in quick
// succession → one partial refresh — plan §7's "one rendering path") and
// anything else that wants the same shape. Pure: no DOM, no timers
// beyond setTimeout — compiled for the server (unit-tested against
// dist-server) and bundled for the browser alike.

/** Debounce `fn` to its trailing edge: calls within `waitMs` coalesce
 *  into one invocation with the LAST arguments. The returned function
 *  carries cancel() (drop a pending invocation) — enough for the pages'
 *  refresh paths; no leading edge, no flush-on-demand needed yet. */
export function debounceTrailing<A extends unknown[]>(
  fn: (...args: A) => void,
  waitMs: number,
): ((...args: A) => void) & { cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const debounced = (...args: A): void => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, waitMs);
  };
  debounced.cancel = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
  return debounced;
}
