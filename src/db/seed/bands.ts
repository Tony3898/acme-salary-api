import { MINOR_UNITS_PER_MAJOR } from '../../domain/money';
import type { salaryBands } from '../schema';
import { COUNTRIES, JOB_LEVELS, type SeedCountry } from './data';

/** Band edges as a fraction of the midpoint. */
const BAND_MIN_FACTOR = 0.8;
const BAND_MAX_FACTOR = 1.25;

export type BandRow = typeof salaryBands.$inferInsert;

export interface SalaryBands {
  rows: BandRow[];
  /** The band a person is judged against, by level and country. */
  find: (jobLevelId: number, country: string) => BandRow;
}

/**
 * One band per level per country, in that country's own currency.
 *
 * The lookup is returned alongside the rows so employee salaries are generated
 * *from* the band rather than from a second calculation of the same midpoint —
 * two derivations would eventually disagree, and "paid fairly for their band"
 * would quietly stop meaning anything.
 */
export function createSalaryBands(): SalaryBands {
  const rows: BandRow[] = [];
  const byLevelAndCountry = new Map<string, BandRow>();

  for (const level of JOB_LEVELS) {
    for (const country of COUNTRIES) {
      const midMinor = localMinorUnits(level.usdMidpoint * country.payMultiplier, country);
      const row: BandRow = {
        id: rows.length + 1,
        jobLevelId: level.id,
        country: country.code,
        currency: country.currency,
        minMinor: Math.round(midMinor * BAND_MIN_FACTOR),
        midMinor,
        maxMinor: Math.round(midMinor * BAND_MAX_FACTOR),
      };
      rows.push(row);
      byLevelAndCountry.set(key(level.id, country.code), row);
    }
  }

  return {
    rows,
    find: (jobLevelId, country) => {
      const band = byLevelAndCountry.get(key(jobLevelId, country));
      if (!band) {
        // Every level/country pair is generated above, so this is a data mistake.
        throw new Error(`No salary band for level ${jobLevelId} in ${country}.`);
      }
      return band;
    },
  };
}

function key(jobLevelId: number, country: string): string {
  return `${jobLevelId}:${country}`;
}

/**
 * Converts a US-dollar figure into the country's own currency, in minor units.
 * Bands are held locally because fairness is judged against the local band, never
 * against a converted amount.
 */
function localMinorUnits(usdAmount: number, country: SeedCountry): number {
  const localAmount = usdAmount / Number(country.rateToUsd);
  // Rounded to a whole local unit first, so bands read like figures a person set.
  return Math.round(localAmount) * MINOR_UNITS_PER_MAJOR;
}
