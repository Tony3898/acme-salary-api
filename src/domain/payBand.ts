import type { Currency } from './money';

/**
 * Whether somebody is paid what the company says their job is worth.
 *
 * The whole point of this module is the rule it refuses to break: **a salary is
 * only ever compared to a band in the same currency.** Converting to USD to make
 * the comparison would produce a number, and the number would be wrong — a
 * Bangalore engineer beside a San Francisco one looks underpaid and is not,
 * because the two are paid against different local markets. So a currency
 * mismatch is reported as "not comparable" rather than converted, and there is
 * deliberately no exchange rate anywhere in this file.
 *
 * Pure functions, no database. The band a person is judged against is chosen by
 * their level and their country; finding it is a query, and comparing to it is
 * arithmetic, and those are separate jobs.
 */

/** One band, in the currency of the country it belongs to. */
export interface PayBand {
  currency: Currency;
  minMinor: number;
  midMinor: number;
  maxMinor: number;
}

/**
 * How a salary sits against its band, including the three ways it cannot be
 * answered.
 *
 * The unanswerable cases are part of the same enum rather than a null, because
 * every one of them is something the screen has to say out loud. "No band for
 * this level in Canada" is a gap in the reference data somebody should fill;
 * silently showing nothing is how it stays unfilled.
 */
export type BandFit =
  /** Under the minimum. The one that costs money to fix. */
  | 'BELOW'
  | 'WITHIN'
  /** Over the maximum. Not necessarily wrong — a retention case, or a band gone stale. */
  | 'ABOVE'
  /** No band exists for this level in this country. */
  | 'NO_BAND'
  /** Nothing recorded to compare. A new joiner before their offer is entered. */
  | 'NO_PAY'
  /** Paid in a currency the band is not in. Never converted; see above. */
  | 'OTHER_CURRENCY';

/**
 * One flat shape for every outcome, so a caller switches on `fit` and reads the
 * fields that case defines. The alternative — a variant type per outcome — spread
 * the same six-way switch across every screen that draws a band.
 */
export interface BandStanding {
  fit: BandFit;
  /** The band that applies, or null when there is none to apply. */
  band: PayBand | null;
  /** What it would cost to bring them to the minimum. Positive only when BELOW. */
  shortfallMinor: number;
  /** How far past the maximum they are. Positive only when ABOVE. */
  excessMinor: number;
  /**
   * Where they sit from the band's minimum to its maximum, in basis points of its
   * width: 0 is exactly the minimum, 10000 exactly the maximum, and a value
   * outside that range means outside the band. Null when no comparison was made.
   *
   * Basis points rather than a fraction so nothing on the wire is a float — the
   * same reason money is minor units.
   */
  positionBasisPoints: number | null;
}

/** One whole band's width, in basis points. */
export const BAND_WIDTH_BASIS_POINTS = 10_000;

export interface PayForComparison {
  amountMinor: number;
  currency: Currency;
}

/**
 * Compares a salary to its band, or explains why it did not.
 *
 * The order of the refusals matters: no band at all is reported before a missing
 * salary, because a level with no band in a country is a reference-data problem
 * affecting everybody in it, where a missing salary is about one person.
 */
export function bandStanding(pay: PayForComparison | null, band: PayBand | null): BandStanding {
  if (band === null) {
    return notCompared('NO_BAND', null);
  }
  if (pay === null) {
    return notCompared('NO_PAY', band);
  }
  if (pay.currency !== band.currency) {
    return notCompared('OTHER_CURRENCY', band);
  }

  return {
    fit: fitOf(pay.amountMinor, band),
    band,
    shortfallMinor: Math.max(band.minMinor - pay.amountMinor, 0),
    excessMinor: Math.max(pay.amountMinor - band.maxMinor, 0),
    positionBasisPoints: positionIn(pay.amountMinor, band),
  };
}

function fitOf(amountMinor: number, band: PayBand): BandFit {
  if (amountMinor < band.minMinor) {
    return 'BELOW';
  }
  return amountMinor > band.maxMinor ? 'ABOVE' : 'WITHIN';
}

/**
 * Position across the band, in basis points, by integer arithmetic.
 *
 * A band whose edges are equal has no width to sit across — the schema permits
 * it, since min <= mid <= max — so the answer there is one of the two ends rather
 * than a division by zero.
 */
function positionIn(amountMinor: number, band: PayBand): number {
  const width = band.maxMinor - band.minMinor;

  if (width === 0) {
    return amountMinor > band.maxMinor ? BAND_WIDTH_BASIS_POINTS : 0;
  }
  return Math.round(((amountMinor - band.minMinor) * BAND_WIDTH_BASIS_POINTS) / width);
}

function notCompared(fit: BandFit, band: PayBand | null): BandStanding {
  return { fit, band, shortfallMinor: 0, excessMinor: 0, positionBasisPoints: null };
}
