import { sql, type SQL } from 'drizzle-orm';
import { rawRows, type Database } from '../db/database';

/**
 * What payroll has cost month by month, and what it is already committed to.
 *
 * The forecast half is not a projection or a trend line. Every figure after
 * today is the sum of pay changes that have **already been signed off** and
 * carry a future date — a promotion agreed in August that starts in October is
 * a cost the company has taken on, and it is invisible on any screen that only
 * shows what is in force today. Guessing at attrition or at next year's review
 * budget would be a different kind of number, and this deliberately does not
 * make one up.
 *
 * **One pass, not one per month.** The obvious shape is a lateral "salary in
 * force" lookup for every employee for every month, which at eighteen months and
 * ten thousand people is 180,000 index lookups. Instead each compensation record
 * is given the window it applies to, with `lead()` over the person's own
 * records, and a month matches the one window that contains it. That is a single
 * scan of the salary history whatever the range asked for.
 *
 * **Who counts in a month.** Somebody hired in June and gone in September is on
 * the payroll for exactly those months, which is why `employees.left_on` exists:
 * with only a status flag the choice was between counting every leaver in every
 * month they were never there, or in none of the months they were. Both make a
 * historic total wrong, and the second makes it wrong in the direction that looks
 * like the company is getting cheaper.
 */

/** A year of history reads as a trend; three months reads as noise. */
export const DEFAULT_HISTORY_MONTHS = 12;
/** Far enough to cover the raises already signed off, which are rarely a year out. */
export const DEFAULT_HORIZON_MONTHS = 6;
export const MAX_HISTORY_MONTHS = 36;
export const MAX_HORIZON_MONTHS = 24;

export interface PayrollTrendQuery {
  /** The month containing this date is the last actual one. */
  asOf: string;
  historyMonths: number;
  horizonMonths: number;
}

export interface PayrollTrendPoint {
  /** The first of the month, as YYYY-MM-DD. */
  month: string;
  payrollUsdMinor: number;
  paidHeadcount: number;
  /**
   * Whether this month has happened. `COMMITTED` months are the same
   * arithmetic over changes already recorded, not a forecast of unknown ones.
   */
  kind: 'ACTUAL' | 'COMMITTED';
}

interface RawPoint {
  month: string;
  payroll_usd_minor: number | string;
  paid_headcount: number;
  kind: 'ACTUAL' | 'COMMITTED';
}

/**
 * The statement, built but not run — so scripts/verify-injection.ts can read the
 * SQL text and the bound parameters as two separate things.
 *
 * Every value is a bound parameter. The interval arithmetic is done in SQL from
 * those parameters rather than by building date strings in Node, so a month
 * boundary is Postgres's idea of one in both the query and the comparison.
 */
export function buildPayrollTrendQuery(query: PayrollTrendQuery): SQL {
  return sql`
    WITH months AS (
      SELECT generate_series(
        date_trunc('month', ${query.asOf}::date) - make_interval(months => ${query.historyMonths}),
        date_trunc('month', ${query.asOf}::date) + make_interval(months => ${query.horizonMonths}),
        interval '1 month'
      )::date AS month
    ),
    /* Each record with the window it is in force for: from its own start until
       the next one begins. A same-day correction closes the earlier record's
       window immediately, which is the same tie-break the current-salary join
       makes with id DESC. */
    windows AS (
      SELECT
        c.employee_id,
        c.amount_minor,
        c.currency,
        c.effective_from,
        lead(c.effective_from) OVER (
          PARTITION BY c.employee_id ORDER BY c.effective_from, c.id
        ) AS next_from
      FROM compensation_records c
    )
    SELECT
      m.month::text AS month,
      coalesce(sum(round(w.amount_minor * fx.rate_to_usd)), 0)::bigint AS payroll_usd_minor,
      count(w.employee_id)::int AS paid_headcount,
      CASE
        WHEN m.month <= date_trunc('month', ${query.asOf}::date) THEN 'ACTUAL'
        ELSE 'COMMITTED'
      END AS kind
    FROM months m
    /* LEFT, so a month nobody was paid in is a zero on the chart rather than a
       gap in the line. */
    LEFT JOIN windows w
      ON w.effective_from <= m.month
     AND (w.next_from IS NULL OR w.next_from > m.month)
    LEFT JOIN employees e
      ON e.id = w.employee_id
     /* Employed in that month: hired by then, and not yet gone. The leaving date
        is what makes the historic half of this chart true — before the column
        existed the only options were to count leavers in every month or in none,
        and both answers are wrong for a question about what payroll cost. */
     AND e.hire_date <= m.month
     AND (e.left_on IS NULL OR e.left_on >= m.month)
    LEFT JOIN fx_rates fx ON fx.currency = w.currency
    WHERE w.employee_id IS NULL OR e.id IS NOT NULL
    GROUP BY m.month
    ORDER BY m.month ASC
  `;
}

export async function computePayrollTrend(
  db: Database,
  query: PayrollTrendQuery,
): Promise<PayrollTrendPoint[]> {
  const rows = await rawRows<RawPoint>(db, buildPayrollTrendQuery(query));

  return rows.map((row) => ({
    month: row.month,
    payrollUsdMinor: toInteger(row.payroll_usd_minor),
    paidHeadcount: row.paid_headcount,
    kind: row.kind,
  }));
}

/** `bigint` arrives as a string from some drivers and a number from others. */
function toInteger(value: number | string): number {
  const parsed = typeof value === 'number' ? value : Number(value);

  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${String(value)} is not an exact whole number of minor units.`);
  }
  return parsed;
}
