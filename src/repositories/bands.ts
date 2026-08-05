import { and, eq, sql, type SQL } from 'drizzle-orm';
import { rawRows, type Database } from '../db/database';
import { salaryBands } from '../db/schema';
import type { Currency } from '../domain/money';

/**
 * The pay bands themselves: reading them with the coverage they actually have, and
 * writing them.
 *
 * The read is not simply `SELECT * FROM salary_bands`, and the reason is the whole
 * point of the screen. What HR needs to see is not the bands that exist — it is the
 * level-and-country pairs that **have people in them**, whether or not a band has
 * been set. A missing band is invisible on every other screen: those people just
 * quietly report "no band set" one at a time, and nobody adds up how many.
 *
 * So the rows come from the union of "pairs with a band" and "pairs with employees",
 * and each carries how many people sit below, within and above it. A band edited
 * without that in view is a number changed in the dark.
 */

export interface BandCoverageRow {
  jobLevelId: number;
  jobLevelName: string;
  jobLevelRank: number;
  country: string;
  /** Null when no band has been set for this pair — which is the case worth seeing. */
  band: {
    currency: Currency;
    minMinor: number;
    midMinor: number;
    maxMinor: number;
  } | null;
  /** Everybody currently employed at this level in this country. */
  headcount: number;
  /** Of those, the ones with a salary recorded. */
  paidHeadcount: number;
  /**
   * The currency these people are actually paid in, when they all share one.
   *
   * Surfaced because a band in the wrong currency compares to nobody: every person
   * in it reads as "not comparable", and the band looks set when it is useless.
   */
  payCurrency: Currency | null;
  /** More than one and no single band currency can serve them. */
  payCurrencies: number;
  below: number;
  within: number;
  above: number;
  /** Paid in a currency the band is not in, so not compared. Should be zero. */
  otherCurrency: number;
}

interface RawCoverageRow {
  job_level_id: number;
  job_level_name: string;
  job_level_rank: number;
  country: string;
  band_currency: Currency | null;
  min_minor: number | null;
  mid_minor: number | null;
  max_minor: number | null;
  headcount: number;
  paid_headcount: number;
  pay_currency: Currency | null;
  pay_currencies: number;
  below: number;
  within: number;
  above: number;
  other_currency: number;
}

/**
 * The statement, built but not run — so scripts/verify-injection.ts can hold the SQL
 * text and the bound parameters apart. There are no caller values in it at all,
 * which is itself worth proving rather than assuming.
 */
export function buildBandCoverageQuery(asOf: string): SQL {
  return sql`
    WITH pay AS MATERIALIZED (
      SELECT e.job_level_id, e.country, cp.amount_minor, cp.currency
      FROM employees e
      LEFT JOIN LATERAL (
        SELECT c.amount_minor, c.currency
        FROM compensation_records c
        WHERE c.employee_id = e.id AND c.effective_from <= ${asOf}
        ORDER BY c.effective_from DESC, c.id DESC
        LIMIT 1
      ) cp ON true
      /* Currently employed only. A band is a statement about what the company pays
         now, and a leaver's salary cannot be brought into range. */
      WHERE e.status = 'ACTIVE'
    ),
    groups AS (
      SELECT
        p.job_level_id,
        p.country,
        count(*)::int AS headcount,
        count(p.amount_minor)::int AS paid_headcount,
        /* min() names the currency in the ordinary case of exactly one; the count
           beside it is what says whether that answer means anything. */
        min(p.currency) AS pay_currency,
        count(DISTINCT p.currency)::int AS pay_currencies,
        count(*) FILTER (
          WHERE p.amount_minor IS NOT NULL AND b.min_minor IS NOT NULL
            AND p.currency = b.currency AND p.amount_minor < b.min_minor
        )::int AS below,
        count(*) FILTER (
          WHERE p.amount_minor IS NOT NULL AND b.min_minor IS NOT NULL
            AND p.currency = b.currency
            AND p.amount_minor >= b.min_minor AND p.amount_minor <= b.max_minor
        )::int AS within,
        count(*) FILTER (
          WHERE p.amount_minor IS NOT NULL AND b.max_minor IS NOT NULL
            AND p.currency = b.currency AND p.amount_minor > b.max_minor
        )::int AS above,
        /* The same currency rule as bandStanding(): never compared, and counted so
           the mismatch is visible rather than showing as an empty band. */
        count(*) FILTER (
          WHERE p.amount_minor IS NOT NULL AND b.currency IS NOT NULL
            AND p.currency <> b.currency
        )::int AS other_currency
      FROM pay p
      LEFT JOIN salary_bands b ON b.job_level_id = p.job_level_id AND b.country = p.country
      GROUP BY p.job_level_id, p.country
    ),
    /* Every pair worth a row: one that has people, or one that has a band. UNION
       rather than UNION ALL, so a pair with both appears once. */
    pairs AS (
      SELECT job_level_id, country FROM groups
      UNION
      SELECT job_level_id, country FROM salary_bands
    )
    SELECT
      pr.job_level_id,
      jl.name AS job_level_name,
      jl.rank AS job_level_rank,
      pr.country,
      b.currency AS band_currency,
      b.min_minor,
      b.mid_minor,
      b.max_minor,
      coalesce(g.headcount, 0) AS headcount,
      coalesce(g.paid_headcount, 0) AS paid_headcount,
      g.pay_currency,
      coalesce(g.pay_currencies, 0) AS pay_currencies,
      coalesce(g.below, 0) AS below,
      coalesce(g.within, 0) AS within,
      coalesce(g.above, 0) AS above,
      coalesce(g.other_currency, 0) AS other_currency
    FROM pairs pr
    JOIN job_levels jl ON jl.id = pr.job_level_id
    LEFT JOIN groups g ON g.job_level_id = pr.job_level_id AND g.country = pr.country
    LEFT JOIN salary_bands b ON b.job_level_id = pr.job_level_id AND b.country = pr.country
    /* Country then seniority, which is how somebody reviewing a country's bands
       reads them. Alphabetical by level name would put Associate above Director. */
    ORDER BY pr.country ASC, jl.rank ASC
  `;
}

export async function listBandCoverage(db: Database, asOf: string): Promise<BandCoverageRow[]> {
  const rows = await rawRows<RawCoverageRow>(db, buildBandCoverageQuery(asOf));

  return rows.map((row) => ({
    jobLevelId: row.job_level_id,
    jobLevelName: row.job_level_name,
    jobLevelRank: row.job_level_rank,
    country: row.country,
    band:
      row.band_currency === null ||
      row.min_minor === null ||
      row.mid_minor === null ||
      row.max_minor === null
        ? null
        : {
            currency: row.band_currency,
            minMinor: row.min_minor,
            midMinor: row.mid_minor,
            maxMinor: row.max_minor,
          },
    headcount: row.headcount,
    paidHeadcount: row.paid_headcount,
    payCurrency: row.pay_currency,
    payCurrencies: row.pay_currencies,
    below: row.below,
    within: row.within,
    above: row.above,
    otherCurrency: row.other_currency,
  }));
}

export interface BandKey {
  jobLevelId: number;
  country: string;
}

export interface NewBand extends BandKey {
  currency: Currency;
  minMinor: number;
  midMinor: number;
  maxMinor: number;
}

/**
 * Sets the band for a level in a country, replacing whatever was there.
 *
 * An upsert on the natural key rather than a create and an update, because
 * (job_level_id, country) *is* the identity of a band — the table is unique on it.
 * Two operations would mean the client had to know which one applied, and would race
 * with anybody else editing the same pair.
 *
 * There is deliberately no history. A band is current policy, not a record of what
 * anybody was paid; the salary history is where the audit trail lives, and a band
 * changing does not change what anyone earned.
 */
export async function upsertBand(db: Database, band: NewBand): Promise<void> {
  await db
    .insert(salaryBands)
    .values(band)
    .onConflictDoUpdate({
      target: [salaryBands.jobLevelId, salaryBands.country],
      set: {
        currency: band.currency,
        minMinor: band.minMinor,
        midMinor: band.midMinor,
        maxMinor: band.maxMinor,
      },
    });
}

/** Removes a band. Returns whether there was one, so the route can answer 404. */
export async function deleteBand(db: Database, key: BandKey): Promise<boolean> {
  const removed = await db
    .delete(salaryBands)
    .where(and(eq(salaryBands.jobLevelId, key.jobLevelId), eq(salaryBands.country, key.country)))
    .returning({ id: salaryBands.id });

  return removed.length > 0;
}

/** Whether a job level exists, so a stale dropdown is a 400 rather than a 500. */
export async function jobLevelExists(db: Database, jobLevelId: number): Promise<boolean> {
  const [found] = await rawRows<{ id: number }>(
    db,
    sql`SELECT id FROM job_levels WHERE id = ${jobLevelId} LIMIT 1`,
  );

  return found !== undefined;
}
