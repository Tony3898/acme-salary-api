import { sql, type SQL } from 'drizzle-orm';
import type { Currency } from '../domain/money';
import type { PayBand } from '../domain/payBand';

/**
 * The band a person is judged against, as SQL.
 *
 * Kept here rather than inline in two queries because the employee list and the
 * needs-attention list must agree on three things exactly: which band applies,
 * what "below it" means, and how far below. If those drift, a person appears as
 * under-banded on one screen and fine on the next, and there is no way to tell
 * which screen is lying.
 *
 * The comparison itself is not here — that is src/domain/payBand.ts, which is
 * pure and tested without a database. What SQL needs is the *predicate*, because
 * a list of thousands cannot be filtered and sorted in Node.
 */

/**
 * The band for this person's level in this person's country.
 *
 * LEFT, so a level with no band in some country does not delete those people from
 * the list they should appear in. `salary_bands` is unique on (job_level_id,
 * country), so this cannot multiply rows.
 */
export const BAND_JOIN = sql`
  LEFT JOIN salary_bands b ON b.job_level_id = e.job_level_id AND b.country = e.country
`;

export const BAND_COLUMNS = sql`
  b.currency AS band_currency,
  b.min_minor AS band_min_minor,
  b.mid_minor AS band_mid_minor,
  b.max_minor AS band_max_minor
`;

/** What `BAND_COLUMNS` selects. All four are null together, or none is. */
export interface RawBandColumns {
  band_currency: Currency | null;
  band_min_minor: number | null;
  band_mid_minor: number | null;
  band_max_minor: number | null;
}

export function toPayBand(row: RawBandColumns): PayBand | null {
  if (
    row.band_currency === null ||
    row.band_min_minor === null ||
    row.band_mid_minor === null ||
    row.band_max_minor === null
  ) {
    return null;
  }

  return {
    currency: row.band_currency,
    minMinor: row.band_min_minor,
    midMinor: row.band_mid_minor,
    maxMinor: row.band_max_minor,
  };
}

/**
 * Which of the six band outcomes to keep.
 *
 * The same six as `BandFit` in src/domain/payBand.ts, and deliberately the same
 * names: a filter called BELOW has to mean what the chip on a person's row means, or
 * clicking "22 below" on the pay-bands screen would show a different 22 people.
 */
export type BandFitFilter = 'BELOW' | 'WITHIN' | 'ABOVE' | 'NO_BAND' | 'NO_PAY' | 'OTHER_CURRENCY';

/**
 * One band outcome, as a condition on `current_pay` and the `b` alias from BAND_JOIN.
 *
 * This is the SQL half of `bandStanding()`, and the two have to agree exactly. They
 * are not derived from one another, because thousands of rows cannot be classified in
 * Node and one row should not need a query — so instead they are kept side by side
 * here and held against each other over every seeded employee by
 * tests/http/attention.test.ts.
 *
 * The currency equality in the three comparable cases is not defensive noise, it is
 * the rule: a salary is only comparable to a band in the same currency, so somebody
 * paid in dollars against a sterling band is not below it. They are `OTHER_CURRENCY`,
 * which is its own filter rather than a silent exclusion.
 *
 * The ordering of the two "cannot compare" cases matches the domain function: no band
 * at all wins over no salary, because a level with no band in a country is a
 * reference-data gap affecting everybody in it.
 */
export function bandFitCondition(fit: BandFitFilter): SQL {
  const comparable = sql`
    current_pay.amount_minor IS NOT NULL
    AND b.min_minor IS NOT NULL
    AND current_pay.currency = b.currency
  `;

  switch (fit) {
    case 'BELOW':
      return sql`(${comparable} AND current_pay.amount_minor < b.min_minor)`;
    case 'WITHIN':
      return sql`(
        ${comparable}
        AND current_pay.amount_minor >= b.min_minor
        AND current_pay.amount_minor <= b.max_minor
      )`;
    case 'ABOVE':
      return sql`(${comparable} AND current_pay.amount_minor > b.max_minor)`;
    case 'NO_BAND':
      return sql`(b.min_minor IS NULL)`;
    case 'NO_PAY':
      return sql`(b.min_minor IS NOT NULL AND current_pay.amount_minor IS NULL)`;
    case 'OTHER_CURRENCY':
      return sql`(
        current_pay.amount_minor IS NOT NULL
        AND b.currency IS NOT NULL
        AND current_pay.currency <> b.currency
      )`;
  }
}

/**
 * Paid less than the bottom of their own band.
 *
 * The needs-attention list's whole premise, and the same expression the BELOW filter
 * uses — one definition, so the to-do list and the filtered People page cannot
 * disagree about who is short.
 */
export const BELOW_BAND_CONDITION = bandFitCondition('BELOW');

/** The gap to the bottom of the band, in the band's own currency. */
export const SHORTFALL_MINOR = sql`(b.min_minor - current_pay.amount_minor)`;

/**
 * The same gap in USD, for ordering only.
 *
 * A cost question is the one place a converted figure is the right answer: "fix
 * the expensive ones first" has to weigh a rupee gap against a sterling one, and
 * without a common unit the list would simply be sorted by which currency has the
 * larger numbers. The figure a person *sees* stays local; only the ordering and
 * the company-wide total are converted, and the response says so.
 */
export function shortfallUsdMinor(): SQL {
  return sql`round(${SHORTFALL_MINOR} * fx.rate_to_usd)::bigint`;
}
