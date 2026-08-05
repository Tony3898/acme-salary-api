/**
 * Reading a pay history as a sequence of changes rather than a list of amounts.
 *
 * Pure functions over records that are already in memory. No database and no
 * SQL: "how much was this raise" is arithmetic, and arithmetic that decides what
 * a person is told about their own pay is worth testing without a server.
 */

/** Enough of a compensation record to compare it with the one before it. */
export interface PayPoint {
  amountMinor: number;
  currency: string;
  effectiveFrom: string;
}

export interface PayChange {
  /** In the same currency as both records, or null when they cannot be compared. */
  amountMinor: number | null;
  /** Rounded to two places; a raise is not reported to eight decimal digits. */
  percentage: number | null;
  /** Why there is no comparison, for a caller that wants to say so. */
  reason: 'FIRST_RECORD' | 'CURRENCY_CHANGED' | null;
}

const PERCENTAGE_DECIMALS = 2;

/**
 * The change from one pay point to the next.
 *
 * Two cases have no answer, and both matter:
 *
 * - **The first record.** A starting salary is not a raise from zero, and
 *   reporting it as an infinite increase is worse than reporting nothing.
 * - **A currency change.** Somebody relocating from London to Bangalore goes
 *   from 120,000 to 5,000,000, which is not a 4,000% raise. Converting both to
 *   USD would give a number, and it would be a number about exchange rates
 *   rather than about their pay.
 */
export function changeBetween(previous: PayPoint | null, current: PayPoint): PayChange {
  if (previous === null) {
    return { amountMinor: null, percentage: null, reason: 'FIRST_RECORD' };
  }

  if (previous.currency !== current.currency) {
    return { amountMinor: null, percentage: null, reason: 'CURRENCY_CHANGED' };
  }

  const amountMinor = current.amountMinor - previous.amountMinor;

  /* A previous amount of zero cannot happen — the database refuses a
     non-positive salary — but dividing by it would produce Infinity in a JSON
     response rather than an error anybody notices. */
  const percentage =
    previous.amountMinor === 0
      ? null
      : round((amountMinor / previous.amountMinor) * 100, PERCENTAGE_DECIMALS);

  return { amountMinor, percentage, reason: null };
}

/**
 * Every record with the change that produced it, in the order given.
 *
 * Expects oldest first, which is how the repository returns them: the change on
 * a row is the change *into* that row, so reading down the page follows the
 * order the changes happened.
 */
export function withChanges<T extends PayPoint>(
  entries: readonly T[],
): (T & { change: PayChange })[] {
  return entries.map((entry, index) => ({
    ...entry,
    change: changeBetween(index === 0 ? null : (entries[index - 1] ?? null), entry),
  }));
}

/**
 * Which record is in force on a given day, and which have not started yet.
 *
 * The same rule as the SQL that computes a current salary — the latest record
 * that has already begun, with the later id winning a same-day tie — so a page
 * that annotates a history agrees with the list that summarises it.
 */
export function currentRecordIndex(entries: readonly PayPoint[], asOf: string): number | null {
  let found: number | null = null;

  for (const [index, entry] of entries.entries()) {
    if (entry.effectiveFrom <= asOf) {
      found = index;
    }
  }

  return found;
}

/** Half-up on the absolute value, so -12.345 and 12.345 round by the same rule. */
function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.sign(value) * (Math.round(Math.abs(value) * factor) / factor);
}
