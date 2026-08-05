import { sql, type SQL } from 'drizzle-orm';
import { rawRows, type Database } from '../db/database';
import {
  employeeFilterConditions,
  statusCondition,
  whereFrom,
  type StatusFilter,
} from './employeeFilters';

/**
 * How ACME pays people, answered by the database.
 *
 * Postgres computes medians, quartiles and histograms directly, so none of this
 * is loaded into Node to be summarised. That matters twice over: at 10,000
 * employees the arithmetic is trivial for the database and a hundred-fold more
 * bytes over the wire for the process, and pulling every salary into memory to
 * average them is how a statistics screen becomes a way to export the payroll.
 *
 * **One statement, one scan.** Everything below hangs off a single `pay` CTE,
 * and the aggregates are assembled into one row of JSON. The alternative — five
 * queries, each repeating the same lateral join over every employee — is five
 * scans and five copies of the filters to keep in step.
 */

/**
 * Bars in the salary histogram. Ten reads as a distribution; thirty reads as
 * noise, and five hides the shape.
 */
const DISTRIBUTION_BUCKETS = 10;

/**
 * Below this, a group's median is that group's salaries with one step of
 * arithmetic in front. The headcount and the total are still reported — those
 * are genuinely aggregate — but the middle of four people is not a statistic.
 */
export const MIN_GROUP_FOR_MEDIAN = 5;

export interface StatisticsQuery {
  /** Pay as it stood on this day. */
  asOf: string;
  /** Defaults to the people currently employed; see the note in the service. */
  status: StatusFilter;
  country?: string;
  departmentId?: number;
  jobLevelId?: number;
}

export interface OverallStatistics {
  /** Everybody matching the filters, whether or not they have pay recorded. */
  headcount: number;
  /** Of those, the ones with a salary in force on the date. */
  paidHeadcount: number;
  /** Records whose currency has no exchange rate. Must be zero; see below. */
  unconvertible: number;
  totalUsdMinor: number;
  /** Null rather than zero when nobody is paid: an average of nothing is not 0. */
  meanUsdMinor: number | null;
  medianUsdMinor: number | null;
  p25UsdMinor: number | null;
  p75UsdMinor: number | null;
  minUsdMinor: number | null;
  maxUsdMinor: number | null;
}

export interface GroupStatistics {
  id: number | null;
  label: string;
  headcount: number;
  paidHeadcount: number;
  totalUsdMinor: number;
  /** Null when the group is too small for a median to mean anything. */
  medianUsdMinor: number | null;
}

export interface DistributionBucket {
  bucket: number;
  fromUsdMinor: number;
  toUsdMinor: number;
  employees: number;
}

export interface StatisticsResult {
  overall: OverallStatistics;
  byDepartment: GroupStatistics[];
  byCountry: GroupStatistics[];
  byJobLevel: GroupStatistics[];
  distribution: DistributionBucket[];
}

interface RawOverall {
  headcount: number;
  paid_headcount: number;
  unconvertible: number;
  total_usd_minor: number | string;
  mean_usd_minor: number | string | null;
  median_usd_minor: number | string | null;
  p25_usd_minor: number | string | null;
  p75_usd_minor: number | string | null;
  min_usd_minor: number | string | null;
  max_usd_minor: number | string | null;
}

interface RawGroup {
  id: number | null;
  label: string;
  headcount: number;
  paid_headcount: number;
  total_usd_minor: number | string;
  median_usd_minor: number | string | null;
}

interface RawBucket {
  bucket: number;
  from_usd_minor: number | string;
  to_usd_minor: number | string;
  employees: number;
}

interface RawStatisticsRow {
  overall: RawOverall;
  by_department: RawGroup[];
  by_country: RawGroup[];
  by_job_level: RawGroup[];
  distribution: RawBucket[];
}

/**
 * There is no access scope here on purpose.
 *
 * These figures are HR-only, and the service refuses anybody whose scope is not
 * ALL before this runs. Narrowing statistics to a Manager's team would be worse
 * than refusing them: a median over three people discloses those three salaries,
 * and a company-wide-looking figure that is actually about four people is a
 * number somebody will quote.
 */
export async function computeStatistics(
  db: Database,
  query: StatisticsQuery,
): Promise<StatisticsResult> {
  const rows = await rawRows<RawStatisticsRow>(db, buildStatisticsQuery(query));

  const [row] = rows;
  if (row === undefined) {
    throw new Error('The statistics query returned no row, which should be impossible.');
  }

  return {
    overall: toOverall(row.overall),
    byDepartment: row.by_department.map(toGroup),
    byCountry: row.by_country.map(toGroup),
    byJobLevel: row.by_job_level.map(toGroup),
    distribution: row.distribution.map(toBucket),
  };
}

/**
 * The statistics statement, built but not run.
 *
 * Separated from execution so scripts/verify-injection.ts can inspect the SQL
 * text and the bound parameters separately. Every value from the caller —
 * the date, the country, the ids — is a parameter. The only two literals pasted
 * into the text are the bucket count and the group threshold, both module
 * constants: a bound parameter would leave their type ambiguous inside
 * `generate_series` and the bucket arithmetic, and neither can be influenced
 * from outside this file.
 */
export function buildStatisticsQuery(query: StatisticsQuery): SQL {
  const where = whereFrom([...statusCondition(query.status), ...employeeFilterConditions(query)]);
  const buckets = sql.raw(String(DISTRIBUTION_BUCKETS));

  /**
   * What every group reports, written once.
   *
   * The three breakdowns below differ only in what they group *by*. They had a
   * copy each of these five expressions, including the small-group suppression
   * — the rule with a disclosure argument behind it, pasted three times and
   * therefore three places to forget it.
   */
  const groupAggregates = sql`
    count(*)::int AS headcount,
    count(usd)::int AS paid_headcount,
    coalesce(sum(usd), 0)::bigint AS total_usd_minor,
    CASE WHEN count(usd) >= ${sql.raw(String(MIN_GROUP_FOR_MEDIAN))}
      THEN percentile_cont(0.5) WITHIN GROUP (ORDER BY usd)::bigint
    END AS median_usd_minor
  `;

  return sql`
      WITH pay AS MATERIALIZED (
        SELECT
          e.department_id,
          d.name AS department_name,
          e.job_level_id,
          jl.name AS job_level_name,
          jl.rank AS level_rank,
          e.country,
          round(cp.amount_minor * fx.rate_to_usd)::bigint AS usd,
          /* A salary whose currency has no rate. Counted rather than ignored:
             dropping it would make every total quietly too small, which is the
             one kind of wrong that nobody spots. */
          (cp.amount_minor IS NOT NULL AND fx.rate_to_usd IS NULL) AS unconvertible
        FROM employees e
        JOIN departments d ON d.id = e.department_id
        JOIN job_levels jl ON jl.id = e.job_level_id
        LEFT JOIN LATERAL (
          SELECT c.amount_minor, c.currency
          FROM compensation_records c
          WHERE c.employee_id = e.id AND c.effective_from <= ${query.asOf}
          ORDER BY c.effective_from DESC, c.id DESC
          LIMIT 1
        ) cp ON true
        LEFT JOIN fx_rates fx ON fx.currency = cp.currency
        WHERE ${where}
      ),
      overall AS (
        SELECT
          count(*)::int AS headcount,
          /* count(column) skips nulls, so this is "how many have pay" without a
             second pass over the same rows. */
          count(usd)::int AS paid_headcount,
          count(*) FILTER (WHERE unconvertible)::int AS unconvertible,
          coalesce(sum(usd), 0)::bigint AS total_usd_minor,
          round(avg(usd))::bigint AS mean_usd_minor,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY usd)::bigint AS median_usd_minor,
          percentile_cont(0.25) WITHIN GROUP (ORDER BY usd)::bigint AS p25_usd_minor,
          percentile_cont(0.75) WITHIN GROUP (ORDER BY usd)::bigint AS p75_usd_minor,
          min(usd)::bigint AS min_usd_minor,
          max(usd)::bigint AS max_usd_minor
        FROM pay
      ),
      by_department AS (
        SELECT department_id AS id, department_name AS label, ${groupAggregates}
        FROM pay
        GROUP BY department_id, department_name
      ),
      by_country AS (
        /* No id: a country is its own name here, and inventing one would imply a
           table this schema does not have. */
        SELECT NULL::int AS id, country AS label, ${groupAggregates}
        FROM pay
        GROUP BY country
      ),
      by_job_level AS (
        /* level_rank rides along so the levels can be ordered by seniority
           rather than alphabetically. */
        SELECT job_level_id AS id, job_level_name AS label, level_rank, ${groupAggregates}
        FROM pay
        GROUP BY job_level_id, job_level_name, level_rank
      ),
      bounds AS (
        /* A single distinct salary would make the lower and upper bound equal,
           which width_bucket refuses outright. Widened by one cent so one
           person still produces a histogram instead of an error. */
        SELECT
          min(usd) AS lo,
          CASE WHEN max(usd) = min(usd) THEN min(usd) + 1 ELSE max(usd) END AS hi
        FROM pay
        WHERE usd IS NOT NULL
      ),
      bucketed AS (
        /* The top value lands in bucket 11 by definition; folded back into the
           last real bucket rather than shown as an eleventh bar of one. */
        SELECT least(width_bucket(p.usd, b.lo, b.hi, ${buckets}), ${buckets}) AS bucket
        FROM pay p
        CROSS JOIN bounds b
        WHERE p.usd IS NOT NULL AND b.lo IS NOT NULL
      ),
      distribution AS (
        /* From generate_series, so an empty range in the middle is a bar of
           zero rather than a missing bar — the gap is the interesting part. */
        SELECT
          s.bucket,
          (b.lo + (b.hi - b.lo) * (s.bucket - 1) / ${buckets})::bigint AS from_usd_minor,
          (b.lo + (b.hi - b.lo) * s.bucket / ${buckets})::bigint AS to_usd_minor,
          count(k.bucket)::int AS employees
        FROM generate_series(1, ${buckets}) AS s(bucket)
        CROSS JOIN bounds b
        LEFT JOIN bucketed k ON k.bucket = s.bucket
        WHERE b.lo IS NOT NULL
        GROUP BY s.bucket, b.lo, b.hi
      )
      SELECT
        (SELECT row_to_json(o) FROM overall o) AS overall,
        (SELECT coalesce(json_agg(t ORDER BY t.total_usd_minor DESC), '[]'::json)
           FROM by_department t) AS by_department,
        (SELECT coalesce(json_agg(t ORDER BY t.total_usd_minor DESC), '[]'::json)
           FROM by_country t) AS by_country,
        (SELECT coalesce(json_agg(t ORDER BY t.level_rank ASC), '[]'::json)
           FROM by_job_level t) AS by_job_level,
        (SELECT coalesce(json_agg(t ORDER BY t.bucket ASC), '[]'::json)
           FROM distribution t) AS distribution
  `;
}

/**
 * `bigint` arrives as a string from some drivers and a number from others, and
 * `numeric` always as a string. Every figure here is in cents and well inside
 * the exact integer range, which the parse asserts rather than assumes.
 */
function toInteger(value: number | string): number {
  const parsed = typeof value === 'number' ? value : Number(value);

  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${String(value)} is not an exact whole number of minor units.`);
  }
  return parsed;
}

function toNullableInteger(value: number | string | null): number | null {
  return value === null ? null : toInteger(value);
}

function toOverall(raw: RawOverall): OverallStatistics {
  return {
    headcount: raw.headcount,
    paidHeadcount: raw.paid_headcount,
    unconvertible: raw.unconvertible,
    totalUsdMinor: toInteger(raw.total_usd_minor),
    meanUsdMinor: toNullableInteger(raw.mean_usd_minor),
    medianUsdMinor: toNullableInteger(raw.median_usd_minor),
    p25UsdMinor: toNullableInteger(raw.p25_usd_minor),
    p75UsdMinor: toNullableInteger(raw.p75_usd_minor),
    minUsdMinor: toNullableInteger(raw.min_usd_minor),
    maxUsdMinor: toNullableInteger(raw.max_usd_minor),
  };
}

function toGroup(raw: RawGroup): GroupStatistics {
  return {
    id: raw.id,
    label: raw.label,
    headcount: raw.headcount,
    paidHeadcount: raw.paid_headcount,
    totalUsdMinor: toInteger(raw.total_usd_minor),
    medianUsdMinor: toNullableInteger(raw.median_usd_minor),
  };
}

function toBucket(raw: RawBucket): DistributionBucket {
  return {
    bucket: raw.bucket,
    fromUsdMinor: toInteger(raw.from_usd_minor),
    toUsdMinor: toInteger(raw.to_usd_minor),
    employees: raw.employees,
  };
}
