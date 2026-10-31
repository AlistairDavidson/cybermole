/** wa-format-date's attributes for a local date and time to the second
 *  (spread onto the element, or set one by one when stamping a template). */
export const DATE_TIME_ATTRS = {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit',
  'hour-format': '24',
} as const;

/** The ISO string wa-format-date's `date` attribute takes. */
export const isoOf = (ms: number): string => new Date(ms).toISOString();
