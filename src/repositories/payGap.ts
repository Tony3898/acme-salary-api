import { sql, type SQL } from 'drizzle-orm';
import { rawRows, type Database } from '../db/database';
import { MIN_GROUP_FOR_MEDIAN } from '../domain/disclosure';
import type { Currency } from '../domain/money';
import {
  employeeFilterConditions,
  statusCondition,
  whereFrom,
  type EmployeeFilters,
} from './employeeFilters';

/**
 * Whether men and women at the same job in the same country are paid the same.
 *
 * Three rules shape this, and each one is there because the obvious version of
 * this feature produces a number that is wrong in a way people quote.
 *
 * **Compare like with like.** A single company-wide figure mostly measures who
 * sits at which level in which country, not what anybody is paid for their job.
 * So every comparison is inside one country at one level — a cell — and there is
 * deliberately no company-wide total anywhere in this response. Somebody who wants
 * one can add up the cells and will have to decide how to weight them, which is
 * the argument they should be having.
 *
 * **Never across currencies.** Because a cell is one country, everybody in it is
 * normally paid in one currency and the medians are directly comparable. Where
 * that is not true the cell is dropped and counted, rather than converted: a
 * gender gap computed through an exchange rate is measuring the exchange rate.
 *
 * **Suppress small groups.** See src/domain/disclosure.ts. Splitting 10,000 people
 * three ways leaves cells with three or four people in them, where a "gap" is one
 * person's salary.
 *
 * The data is synthetic and the gap in it was introduced on purpose — random data
 * has none, and a screen that always reads 0% proves nothing. Both READMEs say so,
 * and so does the UI.
 */

/**
 * Men are the comparator, which is the convention in every statutory gender
 * pay-gap report. Named in the response rather than assumed, so a reader knows
 * which way a negative number points.
 */
export const REFERENCE_GENDER = 'MALE';

export type ComparableGender = 'FEMALE' | 'MALE' | 'OTHER';

export interface PayGapQuery extends EmployeeFilters {
  /** Pay as it stood on this day. */
  asOf: string;
}

export interface PayGapGroup {
  gender: ComparableGender;
  /** People in this cell with this gender and a salary recorded. */
  headcount: number;
  /** Null when the group is below the disclosure threshold. */
  medianMinor: number | null;
  /**
   * This group's median less the reference median, in the cell's currency.
   * Negative means paid less. Null when either median is suppressed.
   */
  gapMinor: number | null;
}

export interface PayGapCell {
  country: string;
  jobLevelId: number;
  jobLevelName: string;
  /** The one currency everybody in this cell is paid in. Never converted. */
  currency: Currency;
  /** Everybody in the cell with a salary, whatever their gender. */
  headcount: number;
  /** The reference gender's median. Cells reach the response only when this exists. */
  referenceMedianMinor: number;
  /** Ordered with the reference gender first, then by headcount. */
  groups: PayGapGroup[];
}

export interface PayGapResult {
  cells: PayGapCell[];
  minimumGroupSize: number;
  referenceGender: ComparableGender;
  /** Cells with no publishable comparison, because one of the two groups is too small. */
  suppressedCells: number;
  /** Cells dropped because the people in them are paid in more than one currency. */
  mixedCurrencyCells: number;
  /** People with no gender recorded. Counted, because an unexplained shortfall in a total invites guesses. */
  unrecordedGender: number;
}

interface RawGroup {
  gender: ComparableGender;
  headcount: number;
  median_minor: number | string | null;
}

interface RawCell {
  country: string;
  job_level_id: number;
  job_level_name: string;
  currency: Currency;
  headcount: number;
  currencies: number;
  groups: RawGroup[];
}

interface RawPayGapRow {
  cells: RawCell[];
  unrecorded_gender: number;
}

/**
 * There is no access scope here, on purpose.
 *
 * A pay-gap analysis is HR-only and the service refuses anybody else before this
 * runs. Narrowing it to a Manager's team would be worse than refusing: every cell
 * would fall under the disclosure threshold, and the few that did not would be a
 * comparison between two named people.
 */
export async function computePayGap(db: Database, query: PayGapQuery): Promise<PayGapResult> {
  const [row] = await rawRows<RawPayGapRow>(db, buildPayGapQuery(query));

  if (row === undefined) {
    throw new Error('The pay-gap query returned no row, which should be impossible.');
  }

  const mixed = row.cells.filter((cell) => cell.currencies > 1);
  const comparable = row.cells
    .filter((cell) => cell.currencies === 1)
    .map(toCell)
    .filter((cell): cell is PayGapCell => cell !== null);

  return {
    cells: comparable,
    minimumGroupSize: MIN_GROUP_FOR_MEDIAN,
    referenceGender: REFERENCE_GENDER,
    /* Everything that had people in it but no publishable pair. Reported as a
       count so the screen can say why it is showing eleven cells out of forty
       rather than leaving the reader to wonder. */
    suppressedCells: row.cells.length - mixed.length - comparable.length,
    mixedCurrencyCells: mixed.length,
    unrecordedGender: row.unrecorded_gender,
  };
}

/**
 * The statement, built but not run — so scripts/verify-injection.ts can hold the
 * SQL text and the bound parameters apart. The only literal pasted into the text
 * is the disclosure threshold, a module constant nothing outside this process can
 * influence; a bound parameter there would leave its type ambiguous inside the
 * comparison.
 */
export function buildPayGapQuery(query: PayGapQuery): SQL {
  const where = whereFrom([
    /* Currently employed only. A gap is a statement about how the company pays
       people now, and leavers would answer it with salaries nobody is paying. */
    ...statusCondition('ACTIVE'),
    ...employeeFilterConditions(query),
  ]);
  const threshold = sql.raw(String(MIN_GROUP_FOR_MEDIAN));

  return sql`
    WITH pay AS MATERIALIZED (
      SELECT
        e.country,
        e.job_level_id,
        jl.name AS job_level_name,
        jl.rank AS level_rank,
        e.gender,
        cp.amount_minor,
        cp.currency
      FROM employees e
      JOIN job_levels jl ON jl.id = e.job_level_id
      LEFT JOIN LATERAL (
        SELECT c.amount_minor, c.currency
        FROM compensation_records c
        WHERE c.employee_id = e.id AND c.effective_from <= ${query.asOf}
        ORDER BY c.effective_from DESC, c.id DESC
        LIMIT 1
      ) cp ON true
      WHERE ${where}
    ),
    /* Only people who can be compared: a salary to compare, and a gender recorded
       to compare it by. NULL gender is not a fourth category — it is an absence,
       and treating it as a group would invent a finding out of missing data. */
    comparable AS (
      SELECT * FROM pay WHERE amount_minor IS NOT NULL AND gender IS NOT NULL
    ),
    by_gender AS (
      SELECT
        country,
        job_level_id,
        gender,
        count(*)::int AS headcount,
        CASE WHEN count(*) >= ${threshold}
          THEN percentile_cont(0.5) WITHIN GROUP (ORDER BY amount_minor)::bigint
        END AS median_minor
      FROM comparable
      GROUP BY country, job_level_id, gender
    ),
    cells AS (
      SELECT
        c.country,
        c.job_level_id,
        c.job_level_name,
        c.level_rank,
        count(*)::int AS headcount,
        /* More than one and the cell is not comparable at all. min() names the
           currency in the ordinary case where there is exactly one. */
        count(DISTINCT c.currency)::int AS currencies,
        min(c.currency) AS currency
      FROM comparable c
      GROUP BY c.country, c.job_level_id, c.job_level_name, c.level_rank
    )
    SELECT
      (
        SELECT coalesce(
          json_agg(
            json_build_object(
              'country', cell.country,
              'job_level_id', cell.job_level_id,
              'job_level_name', cell.job_level_name,
              'currency', cell.currency,
              'headcount', cell.headcount,
              'currencies', cell.currencies,
              'groups', (
                SELECT coalesce(json_agg(
                  json_build_object(
                    'gender', g.gender,
                    'headcount', g.headcount,
                    'median_minor', g.median_minor
                  )
                  /* Largest group first, and gender last as a tie-break: two
                     groups of equal size must not swap places between requests. */
                  ORDER BY g.headcount DESC, g.gender ASC
                ), '[]'::json)
                FROM by_gender g
                WHERE g.country = cell.country AND g.job_level_id = cell.job_level_id
              )
            )
            ORDER BY cell.country ASC, cell.level_rank ASC
          ),
          '[]'::json
        )
        FROM cells cell
      ) AS cells,
      (SELECT count(*)::int FROM pay WHERE amount_minor IS NOT NULL AND gender IS NULL)
        AS unrecorded_gender
  `;
}

/**
 * A cell, or null when no gap can be published for it.
 *
 * Two ways that happens: the reference group is too small to have a median, or
 * every other group is. Either way there is nothing to compare, and a cell
 * showing one median on its own is an invitation to compare it with a cell from
 * somewhere else — which is the comparison this whole module exists to prevent.
 */
function toCell(raw: RawCell): PayGapCell | null {
  const groups = raw.groups.map(toGroup);
  const reference = groups.find((group) => group.gender === REFERENCE_GENDER);

  if (reference?.medianMinor == null) {
    return null;
  }
  const referenceMedianMinor = reference.medianMinor;

  const withGaps = groups.map((group) => ({
    ...group,
    /* Integer subtraction in the cell's own currency. The percentage is left to
       the UI, which is where a ratio becomes a display decision rather than a
       figure the API asserts. */
    gapMinor: group.medianMinor === null ? null : group.medianMinor - referenceMedianMinor,
  }));

  if (!withGaps.some((group) => group.gender !== REFERENCE_GENDER && group.gapMinor !== null)) {
    return null;
  }

  return {
    country: raw.country,
    jobLevelId: raw.job_level_id,
    jobLevelName: raw.job_level_name,
    currency: raw.currency,
    headcount: raw.headcount,
    referenceMedianMinor,
    // The comparator first, so a reader sees what everything else is measured against.
    groups: withGaps.toSorted(
      (left, right) =>
        Number(right.gender === REFERENCE_GENDER) - Number(left.gender === REFERENCE_GENDER),
    ),
  };
}

function toGroup(raw: RawGroup): Omit<PayGapGroup, 'gapMinor'> {
  return {
    gender: raw.gender,
    headcount: raw.headcount,
    medianMinor: raw.median_minor === null ? null : toInteger(raw.median_minor),
  };
}

/** `bigint` arrives as a string from some drivers and a number from others. */
function toInteger(value: number | string): number {
  const parsed = typeof value === 'number' ? value : Number(value);

  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${String(value)} is not an exact whole number of minor units.`);
  }
  return parsed;
}
