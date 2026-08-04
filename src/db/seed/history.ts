import type { compensationRecords } from '../schema';
import { RAISE_REASONS } from './data';
import type { PayProfile } from './people';
import type { SeededRandom } from './random';

export type CompensationRow = typeof compensationRecords.$inferInsert;

/** Nobody gets a raise more often than yearly here, and four is plenty of history. */
const MAX_RAISES = 4;
const RAISE_MIN = 1.04;
const RAISE_MAX = 1.09;

/**
 * Builds each person's salary history: a record on their hire date, then a raise
 * on some of their anniversaries.
 *
 * Dates are counted *forwards* from the hire date, so they can only ascend, and
 * the amount is compounded in the same order — which is what makes pay rise over
 * time rather than a property that has to be asserted afterwards.
 *
 * The starting amount is derived by dividing the intended current salary by the
 * compounded raises, so the most recent record lands on the figure the person is
 * meant to be earning. Compounding forwards from an arbitrary starting salary
 * would instead make today's pay a side effect of how long they have been here.
 */
export function buildSalaryHistory(
  profiles: readonly PayProfile[],
  today: string,
  random: SeededRandom,
): CompensationRow[] {
  const records: CompensationRow[] = [];

  for (const profile of profiles) {
    const raiseDates = anniversariesBefore(profile.hireDate, today);
    const raises = raiseDates.map(() => random.float(RAISE_MIN, RAISE_MAX));
    const compounded = raises.reduce((total, raise) => total * raise, 1);

    let amountMinor = Math.max(1, Math.round(profile.currentAmountMinor / compounded));
    records.push({
      employeeId: profile.employeeId,
      amountMinor,
      currency: profile.currency,
      effectiveFrom: profile.hireDate,
      reason: 'Hired',
    });

    for (const [index, effectiveFrom] of raiseDates.entries()) {
      amountMinor = Math.round(amountMinor * (raises[index] ?? 1));
      records.push({
        employeeId: profile.employeeId,
        amountMinor,
        currency: profile.currency,
        effectiveFrom,
        reason: random.pick(RAISE_REASONS),
      });
    }
  }

  return records;
}

/**
 * The most recent anniversaries of the hire date that have already passed, oldest
 * first. Capped, and by taking the *latest* ones a long-serving employee has
 * recent history rather than a flurry of raises years ago.
 */
function anniversariesBefore(hireDate: string, today: string): string[] {
  const dates: string[] = [];

  for (let year = 1; ; year += 1) {
    const anniversary = addYears(hireDate, year);
    if (anniversary >= today) break;
    dates.push(anniversary);
  }

  return dates.slice(-MAX_RAISES);
}

/**
 * Calendar arithmetic on plain YYYY-MM-DD strings. A 29 February hire date lands
 * on 1 March in non-leap years, which is the ordinary way to handle it.
 */
function addYears(from: string, years: number): string {
  const date = new Date(`${from}T00:00:00Z`);
  date.setUTCFullYear(date.getUTCFullYear() + years);
  return date.toISOString().slice(0, 10);
}
