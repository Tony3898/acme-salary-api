import { MAX_AMOUNT_MINOR } from './money';

/**
 * What a percentage raise comes to, exactly.
 *
 * Pure arithmetic on whole minor units, and the reason it is its own module is
 * that the preview and the apply must agree to the cent. A preview that says
 * "£412,900.00" and an apply that writes something a few pence different is worse
 * than no preview at all: the figure was signed off, and the table is append-only.
 * One function, called by both, makes that agreement structural rather than a
 * property of two pieces of code being written carefully on the same afternoon.
 *
 * Percentages are basis points — 3.5% is 350 — for the same reason money is cents.
 * A percentage held as 0.035 makes the multiplication a float, and a float times
 * ten thousand salaries drifts.
 */

/** 100% in basis points. */
export const BASIS_POINTS_PER_UNIT = 10_000;

/** Nobody is given a 10,000% raise; a figure that large is a typo or a decimal misplaced. */
const MAX_PERCENT = 100;
const MIN_PERCENT = -100;

/** Digits with an optional two-decimal fraction, and an optional minus sign. */
const PERCENT_PATTERN = /^(-?)(\d+)(?:\.(\d{1,2}))?$/;

/**
 * Parses a percentage as written into basis points: "3.5" becomes 350.
 *
 * A string rather than a number for the same reason amounts are strings — 3.5
 * survives JSON, but 0.1 + 0.2 does not, and a client computing a percentage
 * cannot always send exactly what it meant. Two decimal places, because a
 * percentage of a salary is already precise to a fraction of a cent and a third
 * decimal place is somebody expecting more than the arithmetic can give them.
 *
 * Throws `TypeError` for something that is not a percentage and `RangeError` for
 * one out of bounds, matching `parseAmountToMinor`, so the service that turns both
 * into a 400 has one rule.
 */
export function parsePercentToBasisPoints(input: string): number {
  const match = PERCENT_PATTERN.exec(input.trim());

  if (!match) {
    throw new TypeError(
      `"${input}" is not a percentage. Use plain digits with at most two decimal places, such as 3.5.`,
    );
  }

  const [, sign, whole = '0', fraction = ''] = match;
  const magnitude = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  const basisPoints = sign === '-' ? -magnitude : magnitude;

  if (basisPoints > MAX_PERCENT * 100 || basisPoints < MIN_PERCENT * 100) {
    throw new RangeError(
      `A change of ${input}% is outside the range this supports (${String(MIN_PERCENT)}% to ${String(MAX_PERCENT)}%).`,
    );
  }
  if (basisPoints === 0) {
    throw new RangeError('A change of 0% would record every salary again unchanged.');
  }

  return basisPoints;
}

/**
 * The new amount after a raise, in whole minor units.
 *
 * **Half a cent rounds up — always up, including on a cut.** Stated in that
 * direction on purpose, because "away from zero" and "up" are the same thing for a
 * raise and opposite things for a reduction, and the difference is a cent per
 * person across ten thousand people. Up in both directions means a rounding
 * decision never leaves somebody worse off: a 2.5-cent raise becomes 3, and a
 * 2.5-cent cut becomes 2.
 *
 * That is what `Math.round` does — it rounds halves toward positive infinity — and
 * the test holds it against an independent expression of the same rule rather than
 * against a second call to `Math.round`.
 *
 * The multiplication is exact: a salary is around 10^7 cents and basis points are
 * at most 10^6, so the product stays far inside the 2^53 exact integer range.
 */
export function raisedAmountMinor(amountMinor: number, basisPoints: number): number {
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    throw new TypeError(`${amountMinor} is not a payable amount in whole minor units.`);
  }

  const increase = Math.round((amountMinor * basisPoints) / BASIS_POINTS_PER_UNIT);
  const raised = amountMinor + increase;

  /* A cut that rounds to the whole salary would write a zero, which no check
     constraint or parse would allow through any other path. Refused here so the
     bulk operation reports it as a row it cannot apply rather than failing at the
     insert with the transaction half built. */
  if (raised <= 0) {
    throw new RangeError(
      `A change of ${String(basisPoints / 100)}% would leave a salary of nothing.`,
    );
  }
  if (raised > MAX_AMOUNT_MINOR) {
    throw new RangeError(
      `A change of ${String(basisPoints / 100)}% exceeds the largest exact amount.`,
    );
  }

  return raised;
}
