import { asc, sql } from 'drizzle-orm';
import { rawRows, type Database } from '../db/database';
import { departments, fxRates, jobLevels, salaryBands } from '../db/schema';
import type { Currency } from '../domain/money';

/**
 * The small, slow-moving reference data every screen needs: the filter
 * dropdowns, the exchange rates, the pay bands.
 *
 * Fetched as one set rather than one endpoint each, because the UI needs all of
 * it before it can render a filter bar, and five round trips to fetch 10 KB is
 * the wrong shape.
 */

export interface LookupData {
  departments: { id: number; name: string }[];
  jobLevels: { id: number; name: string; rank: number }[];
  /** Where people actually are, so a filter cannot offer an empty country. */
  countries: string[];
  fxRates: { currency: Currency; rateToUsd: string; asOf: string }[];
  salaryBands: {
    jobLevelId: number;
    country: string;
    currency: Currency;
    minMinor: number;
    midMinor: number;
    maxMinor: number;
  }[];
}

export async function loadLookupData(db: Database): Promise<LookupData> {
  /* In parallel: they are independent, and the whole point of loading them
     together is that it happens once. */
  const [departmentRows, jobLevelRows, countryRows, fxRows, bandRows] = await Promise.all([
    db
      .select({ id: departments.id, name: departments.name })
      .from(departments)
      .orderBy(asc(departments.name)),
    db
      .select({ id: jobLevels.id, name: jobLevels.name, rank: jobLevels.rank })
      .from(jobLevels)
      .orderBy(asc(jobLevels.rank)),
    rawRows<{ country: string }>(db, sql`SELECT DISTINCT country FROM employees ORDER BY country`),
    db
      .select({ currency: fxRates.currency, rateToUsd: fxRates.rateToUsd, asOf: fxRates.asOf })
      .from(fxRates)
      .orderBy(asc(fxRates.currency)),
    db
      .select({
        jobLevelId: salaryBands.jobLevelId,
        country: salaryBands.country,
        currency: salaryBands.currency,
        minMinor: salaryBands.minMinor,
        midMinor: salaryBands.midMinor,
        maxMinor: salaryBands.maxMinor,
      })
      .from(salaryBands)
      .orderBy(asc(salaryBands.jobLevelId), asc(salaryBands.country)),
  ]);

  return {
    departments: departmentRows,
    jobLevels: jobLevelRows,
    countries: countryRows.map((row) => row.country),
    /* `rateToUsd` stays a string all the way to the client. It is `numeric` in the
       database and reading it into a float is how a rate loses precision — the
       conversion itself is done by Postgres. */
    fxRates: fxRows,
    salaryBands: bandRows,
  };
}
