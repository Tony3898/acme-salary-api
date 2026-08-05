import { sql, type SQL } from 'drizzle-orm';
import { rawRows, type Database } from '../db/database';
import type { AccessScope } from '../domain/accessScope';
import {
  employeeFilterConditions,
  scopeCondition,
  statusCondition,
  teamCte,
  whereFrom,
  type EmployeeFilters,
} from './employeeFilters';
import {
  EMPLOYEE_COLUMNS,
  employeeFrom,
  toEmployeeListRow,
  type EmployeeListRow,
  type RawEmployeeColumns,
} from './employeeRow';
import { BELOW_BAND_CONDITION, SHORTFALL_MINOR, shortfallUsdMinor } from './payBands';

/**
 * Everybody paid below the bottom of their band, dearest first.
 *
 * A to-do list rather than a report: the ordering is by what it would cost to
 * fix, so the top of the list is where the money is. That ordering is the one
 * place in this feature where a converted figure is the right answer — a rupee
 * shortfall has to be weighed against a sterling one, and without a common unit
 * the list would simply be sorted by which currency has the larger numbers. Every
 * figure a person *reads* stays in their own currency.
 */

export interface AttentionQuery extends EmployeeFilters {
  scope: AccessScope;
  /** Pay as it stood on this day. */
  asOf: string;
  page: number;
  pageSize: number;
}

export interface AttentionRow {
  employee: EmployeeListRow;
  /** The gap to the bottom of the band, in USD cents. What the list is ordered by. */
  shortfallUsdMinor: number;
}

export interface AttentionResult {
  rows: AttentionRow[];
  total: number;
  /**
   * What it would cost to bring everybody matching the filters — not just this
   * page — to the bottom of their band, in USD cents.
   */
  totalShortfallUsdMinor: number;
}

interface RawAttentionRow extends RawEmployeeColumns {
  shortfall_minor: number;
  shortfall_usd_minor: number | null;
  total_count: number;
  total_shortfall_usd_minor: number | string | null;
  unconvertible: number;
}

/**
 * Who the list is about.
 *
 * Status is fixed to ACTIVE and is deliberately not a parameter. This is a list
 * of people to do something about, and there is nothing to do about somebody who
 * has left — their pay is history, and putting them on a to-do list beside people
 * who are still here would make the cost-to-fix total money nobody will spend.
 */
function attentionConditions(query: AttentionQuery): SQL[] {
  return [
    scopeCondition(query.scope),
    ...employeeFilterConditions(query),
    ...statusCondition('ACTIVE'),
    BELOW_BAND_CONDITION,
  ];
}

/**
 * The statement, built but not run — so scripts/verify-injection.ts can hold the
 * SQL text and the bound parameters apart and check that no caller value is in
 * the first of them.
 */
export function buildAttentionQuery(query: AttentionQuery): SQL {
  const offset = (query.page - 1) * query.pageSize;
  const where = whereFrom(attentionConditions(query));
  const shortfallUsd = shortfallUsdMinor();

  return sql`
    ${teamCte(query.scope)}
    SELECT
      ${EMPLOYEE_COLUMNS},
      ${SHORTFALL_MINOR} AS shortfall_minor,
      ${shortfallUsd} AS shortfall_usd_minor,
      count(*) OVER ()::int AS total_count,
      /* The whole cost, not this page's. A footer that totals only what is on
         screen answers a question nobody asked. */
      sum(${shortfallUsd}) OVER ()::bigint AS total_shortfall_usd_minor,
      /* Salaries whose currency has no rate. Counted rather than ignored: the
         sum above would skip them and the total would be quietly too small,
         which is the one kind of wrong nobody spots. */
      count(*) FILTER (WHERE fx.rate_to_usd IS NULL) OVER ()::int AS unconvertible
    ${employeeFrom(query.asOf)}
    WHERE ${where}
    /* id last, as everywhere: two people short by the same amount must not swap
       places between requests, or page 2 repeats somebody from page 1. */
    ORDER BY ${shortfallUsd} DESC, e.id ASC
    LIMIT ${query.pageSize} OFFSET ${offset}
  `;
}

/** The count and the cost on their own, for a page past the end of the list. */
export function buildAttentionTotalsQuery(query: AttentionQuery): SQL {
  return sql`
    ${teamCte(query.scope)}
    SELECT
      count(*)::int AS total,
      coalesce(sum(${shortfallUsdMinor()}), 0)::bigint AS total_shortfall_usd_minor,
      count(*) FILTER (WHERE fx.rate_to_usd IS NULL)::int AS unconvertible
    ${employeeFrom(query.asOf)}
    WHERE ${whereFrom(attentionConditions(query))}
  `;
}

export async function listNeedsAttention(
  db: Database,
  query: AttentionQuery,
): Promise<AttentionResult> {
  const rows = await rawRows<RawAttentionRow>(db, buildAttentionQuery(query));
  const [first] = rows;

  if (first === undefined) {
    /* No rows, so the window functions produced no totals either — and "nobody is
       below their band" is indistinguishable from "page 9 of 3" from here. The
       second still has to report the real total or the pager loses its way back.
       Reuses the same conditions and the same team walk, so there is one
       definition of who is being counted. */
    return totalsOnly(db, query);
  }

  requireConvertible(first.unconvertible);

  return {
    rows: rows.map(toAttentionRow),
    total: first.total_count,
    totalShortfallUsdMinor: toInteger(first.total_shortfall_usd_minor ?? 0),
  };
}

async function totalsOnly(db: Database, query: AttentionQuery): Promise<AttentionResult> {
  const [totals] = await rawRows<{
    total: number;
    total_shortfall_usd_minor: number | string;
    unconvertible: number;
  }>(db, buildAttentionTotalsQuery(query));

  if (totals === undefined) {
    throw new Error('The attention totals query returned no row, which should be impossible.');
  }
  requireConvertible(totals.unconvertible);

  return {
    rows: [],
    total: totals.total,
    totalShortfallUsdMinor: toInteger(totals.total_shortfall_usd_minor),
  };
}

function toAttentionRow(row: RawAttentionRow): AttentionRow {
  if (row.shortfall_usd_minor === null) {
    // Unreachable: `requireConvertible` has already refused the whole result.
    throw new Error(`No exchange rate for employee ${String(row.id)}; cannot cost the shortfall.`);
  }

  return { employee: toEmployeeListRow(row), shortfallUsdMinor: row.shortfall_usd_minor };
}

/**
 * Refusing is the point. The list's whole purpose is a cost, and quietly omitting
 * the people whose currency has no rate would make that cost too small in a way
 * nobody would notice.
 */
function requireConvertible(unconvertible: number): void {
  if (unconvertible > 0) {
    throw new Error(
      `${String(unconvertible)} salaries below their band are in a currency with no exchange rate.`,
    );
  }
}

/** `bigint` and `numeric` arrive as strings from some drivers, numbers from others. */
function toInteger(value: number | string): number {
  const parsed = typeof value === 'number' ? value : Number(value);

  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${String(value)} is not an exact whole number of minor units.`);
  }
  return parsed;
}
