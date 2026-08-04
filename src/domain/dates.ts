/**
 * Calendar dates, as plain YYYY-MM-DD.
 *
 * A salary starts on a date, not at an instant: a raise effective 1 April is
 * effective on the first of April wherever the person reading the screen happens
 * to be. Storing a timestamp instead would make the same raise pending in Sydney
 * and active in London for several hours each day.
 *
 * "Today" is decided in one place — here — and passed in, so a test does not
 * depend on the day it runs.
 */

export const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** UTC, so the server's own time zone never shifts the date it thinks it is. */
export function toIsoDate(instant: Date): string {
  return instant.toISOString().slice(0, 10);
}

/**
 * A real calendar date, not merely the right shape. `2026-02-31` matches the
 * pattern and is not a day; JavaScript would silently read it as 3 March.
 */
export function isValidIsoDate(value: string): boolean {
  if (!ISO_DATE_PATTERN.test(value)) {
    return false;
  }

  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && toIsoDate(parsed) === value;
}
