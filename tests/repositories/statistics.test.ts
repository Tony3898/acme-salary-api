import {
  compensationRecords,
  departments,
  employees,
  fxRates,
  jobLevels,
} from '../../src/db/schema';
import { computeStatistics, MIN_GROUP_FOR_MEDIAN } from '../../src/repositories/statistics';
import { percentileCents } from '../helpers/percentile';
import { useTestDatabases, type TestDb } from '../helpers/testDb';

/**
 * The dashboard's arithmetic, checked against a second implementation.
 *
 * Percentiles are the part most likely to be quietly wrong: `percentile_cont`
 * interpolates rather than picking a middle value, so an even-sized group has a
 * median that is in the data nowhere. Every figure below is cross-checked
 * against tests/helpers/percentile.ts, which was written from the definition
 * rather than from this query.
 */
describe('computeStatistics', () => {
  const databases = useTestDatabases();
  let db: TestDb;

  const asOf = '2026-08-04';
  const baseQuery = { asOf, status: 'ACTIVE' as const };

  /** Ids for the lookup rows, filled in by `setUp`. */
  let engineering: number;
  let sales: number;
  let junior: number;
  let senior: number;

  interface PersonSpec {
    name: string;
    /** In whole minor units of the currency below; omitted means never paid. */
    amountMinor?: number;
    currency?: 'USD' | 'GBP' | 'INR';
    effectiveFrom?: string;
    country?: string;
    department?: 'engineering' | 'sales';
    level?: 'junior' | 'senior';
    status?: 'ACTIVE' | 'LEFT';
  }

  async function setUp(people: PersonSpec[], options: { rates?: boolean } = {}): Promise<void> {
    db = await databases.create();

    const [eng] = await db.insert(departments).values({ name: 'Engineering' }).returning();
    const [sal] = await db.insert(departments).values({ name: 'Sales' }).returning();
    const [jun] = await db.insert(jobLevels).values({ name: 'Junior', rank: 1 }).returning();
    const [sen] = await db.insert(jobLevels).values({ name: 'Senior', rank: 3 }).returning();

    if (!eng || !sal || !jun || !sen) {
      throw new Error('Failed to seed the lookup rows.');
    }
    engineering = eng.id;
    sales = sal.id;
    junior = jun.id;
    senior = sen.id;

    if (options.rates !== false) {
      await db.insert(fxRates).values([
        { currency: 'USD', rateToUsd: '1.00000000', asOf: '2026-08-01' },
        { currency: 'GBP', rateToUsd: '1.27000000', asOf: '2026-08-01' },
        { currency: 'INR', rateToUsd: '0.01204000', asOf: '2026-08-01' },
      ]);
    }

    for (const [index, person] of people.entries()) {
      const [inserted] = await db
        .insert(employees)
        .values({
          fullName: person.name,
          email: `person${String(index)}@acme.test`,
          country: person.country ?? 'US',
          departmentId: person.department === 'sales' ? sales : engineering,
          jobLevelId: person.level === 'senior' ? senior : junior,
          hireDate: '2020-01-01',
          status: person.status ?? 'ACTIVE',
        })
        .returning({ id: employees.id });

      if (!inserted) {
        throw new Error(`Failed to insert ${person.name}.`);
      }

      if (person.amountMinor !== undefined) {
        await db.insert(compensationRecords).values({
          employeeId: inserted.id,
          amountMinor: person.amountMinor,
          currency: person.currency ?? 'USD',
          effectiveFrom: person.effectiveFrom ?? '2024-01-01',
        });
      }
    }
  }

  /** Salaries in whole dollars, as cents. */
  const dollars = (major: number): number => major * 100;

  afterEach(databases.closeAll);

  describe('percentiles', () => {
    it('given an odd-sized group, when summarised, then the median is the middle value', async () => {
      const amounts = [dollars(50_000), dollars(70_000), dollars(90_000)];
      await setUp(
        amounts.map((amountMinor, index) => ({ name: `P${String(index)}`, amountMinor })),
      );

      const { overall } = await computeStatistics(db, baseQuery);

      expect(overall.medianUsdMinor).toBe(dollars(70_000));
      expect(overall.medianUsdMinor).toBe(percentileCents(amounts, 0.5));
    });

    it('given an even-sized group, when summarised, then the median is interpolated', async () => {
      /* The case a "pick the middle element" implementation gets wrong: the
         answer is 60,000, which is nobody's salary. */
      const amounts = [dollars(50_000), dollars(70_000)];
      await setUp(
        amounts.map((amountMinor, index) => ({ name: `P${String(index)}`, amountMinor })),
      );

      const { overall } = await computeStatistics(db, baseQuery);

      expect(overall.medianUsdMinor).toBe(dollars(60_000));
      expect(overall.medianUsdMinor).toBe(percentileCents(amounts, 0.5));
    });

    it('given one person, when summarised, then every percentile is their salary', async () => {
      await setUp([{ name: 'Only', amountMinor: dollars(80_000) }]);

      const { overall } = await computeStatistics(db, baseQuery);

      expect(overall.medianUsdMinor).toBe(dollars(80_000));
      expect(overall.p25UsdMinor).toBe(dollars(80_000));
      expect(overall.p75UsdMinor).toBe(dollars(80_000));
    });

    it('given everybody paid the same, when summarised, then the spread is nil', async () => {
      const amounts = Array.from({ length: 7 }, () => dollars(60_000));
      await setUp(
        amounts.map((amountMinor, index) => ({ name: `P${String(index)}`, amountMinor })),
      );

      const { overall } = await computeStatistics(db, baseQuery);

      expect(overall.p25UsdMinor).toBe(dollars(60_000));
      expect(overall.p75UsdMinor).toBe(dollars(60_000));
      expect(overall.minUsdMinor).toBe(overall.maxUsdMinor);
    });

    it('given an awkward set, when summarised, then every quartile matches the reference', async () => {
      const amounts = [
        dollars(41_000),
        dollars(52_500),
        dollars(63_250),
        dollars(88_100),
        dollars(91_000),
        dollars(120_000),
      ];
      await setUp(
        amounts.map((amountMinor, index) => ({ name: `P${String(index)}`, amountMinor })),
      );

      const { overall } = await computeStatistics(db, baseQuery);

      expect(overall.p25UsdMinor).toBe(percentileCents(amounts, 0.25));
      expect(overall.medianUsdMinor).toBe(percentileCents(amounts, 0.5));
      expect(overall.p75UsdMinor).toBe(percentileCents(amounts, 0.75));
    });

    it('given nobody at all, when summarised, then there is no data rather than zero', async () => {
      /* A median of $0 caused by a filter matching nobody is worse than showing
         nothing: it is a plausible-looking figure that is entirely made up. */
      await setUp([]);

      const { overall } = await computeStatistics(db, baseQuery);

      expect(overall.headcount).toBe(0);
      expect(overall.medianUsdMinor).toBeNull();
      expect(overall.meanUsdMinor).toBeNull();
      expect(overall.minUsdMinor).toBeNull();
      // A total of nothing genuinely is zero, unlike an average of nothing.
      expect(overall.totalUsdMinor).toBe(0);
    });
  });

  describe('who is counted', () => {
    it('given somebody with no pay recorded, when summarised, then they count as a head and not as a salary', async () => {
      await setUp([{ name: 'Paid', amountMinor: dollars(60_000) }, { name: 'Never paid' }]);

      const { overall } = await computeStatistics(db, baseQuery);

      expect(overall.headcount).toBe(2);
      expect(overall.paidHeadcount).toBe(1);
      expect(overall.medianUsdMinor).toBe(dollars(60_000));
    });

    it('given a leaver, when summarised as active, then they are left out of the payroll', async () => {
      /* "What does payroll cost" is about the people currently employed.
         Counting leavers would inflate every total with salaries nobody pays. */
      await setUp([
        { name: 'Here', amountMinor: dollars(60_000) },
        { name: 'Gone', amountMinor: dollars(200_000), status: 'LEFT' },
      ]);

      const { overall } = await computeStatistics(db, baseQuery);

      expect(overall.headcount).toBe(1);
      expect(overall.totalUsdMinor).toBe(dollars(60_000));
    });

    it('given a leaver, when everybody is asked for, then they are counted', async () => {
      await setUp([
        { name: 'Here', amountMinor: dollars(60_000) },
        { name: 'Gone', amountMinor: dollars(200_000), status: 'LEFT' },
      ]);

      const { overall } = await computeStatistics(db, { asOf, status: 'ALL' });

      expect(overall.headcount).toBe(2);
    });

    it('given a raise that has not started, when summarised, then the previous salary is used', async () => {
      await setUp([{ name: 'Waiting', amountMinor: dollars(60_000), effectiveFrom: '2024-01-01' }]);
      const [person] = await db.select({ id: employees.id }).from(employees);
      if (!person) {
        throw new Error('Expected the seeded person.');
      }
      await db.insert(compensationRecords).values({
        employeeId: person.id,
        amountMinor: dollars(90_000),
        currency: 'USD',
        effectiveFrom: '2026-12-01',
      });

      const { overall } = await computeStatistics(db, baseQuery);

      expect(overall.totalUsdMinor).toBe(dollars(60_000));
    });

    it('given a past date, when summarised, then the payroll of that day is reported', async () => {
      await setUp([{ name: 'Raised', amountMinor: dollars(60_000), effectiveFrom: '2026-01-01' }]);

      const before = await computeStatistics(db, { asOf: '2025-06-01', status: 'ACTIVE' });
      const after = await computeStatistics(db, baseQuery);

      expect(before.overall.paidHeadcount).toBe(0);
      expect(after.overall.paidHeadcount).toBe(1);
    });
  });

  describe('currencies', () => {
    it('given salaries in three currencies, when totalled, then each is converted first', async () => {
      /* Summing them as if equal is the bug this exists to prevent: 5,000,000
         paise added to 100,000 dollars would report a payroll of five million. */
      await setUp([
        { name: 'US', amountMinor: dollars(100_000), currency: 'USD' },
        { name: 'GB', amountMinor: dollars(100_000), currency: 'GBP' },
        { name: 'IN', amountMinor: 500_000_000, currency: 'INR' },
      ]);

      const { overall } = await computeStatistics(db, baseQuery);

      // $100,000 + £100,000 × 1.27 + ₹5,000,000 × 0.01204.
      expect(overall.totalUsdMinor).toBe(dollars(100_000) + dollars(127_000) + 6_020_000);
    });

    it('given a currency with no exchange rate, when summarised, then it is counted rather than dropped', async () => {
      /* Silently omitting them would make the payroll total quietly too small,
         which is the one kind of wrong nobody spots. The service refuses on
         this count rather than publishing the figure. */
      await setUp([{ name: 'Unrated', amountMinor: dollars(100_000), currency: 'GBP' }], {
        rates: false,
      });

      const { overall } = await computeStatistics(db, baseQuery);

      expect(overall.unconvertible).toBe(1);
    });
  });

  describe('groups', () => {
    it('given several departments, when summarised, then the totals sum to the company total', async () => {
      await setUp([
        { name: 'E1', amountMinor: dollars(60_000), department: 'engineering' },
        { name: 'E2', amountMinor: dollars(80_000), department: 'engineering' },
        { name: 'S1', amountMinor: dollars(50_000), department: 'sales' },
      ]);

      const { overall, byDepartment } = await computeStatistics(db, baseQuery);

      const summed = byDepartment.reduce((total, group) => total + group.totalUsdMinor, 0);
      expect(summed).toBe(overall.totalUsdMinor);
      expect(byDepartment.map((group) => group.label)).toEqual(['Engineering', 'Sales']);
    });

    it('given a group below the threshold, when summarised, then its median is withheld', async () => {
      /* The middle of four people is those four salaries with one step of
         arithmetic in front. The headcount and the total are genuinely
         aggregate and stay. */
      const small = Array.from({ length: MIN_GROUP_FOR_MEDIAN - 1 }, (_unused, index) => ({
        name: `S${String(index)}`,
        amountMinor: dollars(50_000 + index * 1_000),
        department: 'sales' as const,
      }));
      await setUp(small);

      const { byDepartment } = await computeStatistics(db, baseQuery);

      expect(byDepartment[0]?.headcount).toBe(MIN_GROUP_FOR_MEDIAN - 1);
      expect(byDepartment[0]?.totalUsdMinor).toBeGreaterThan(0);
      expect(byDepartment[0]?.medianUsdMinor).toBeNull();
    });

    it('given a group at the threshold, when summarised, then its median is published', async () => {
      const enough = Array.from({ length: MIN_GROUP_FOR_MEDIAN }, (_unused, index) => ({
        name: `S${String(index)}`,
        amountMinor: dollars(50_000 + index * 1_000),
        department: 'sales' as const,
      }));
      await setUp(enough);

      const { byDepartment } = await computeStatistics(db, baseQuery);

      expect(byDepartment[0]?.medianUsdMinor).toBe(dollars(52_000));
    });

    it('given several levels, when summarised, then they are ordered by seniority', async () => {
      // Alphabetical order would read "Junior, Senior" here and "Junior, Lead,
      // Mid, Senior" in the real data, which is a list nobody can read down.
      await setUp([
        { name: 'Sen', amountMinor: dollars(120_000), level: 'senior' },
        { name: 'Jun', amountMinor: dollars(50_000), level: 'junior' },
      ]);

      const { byJobLevel } = await computeStatistics(db, baseQuery);

      expect(byJobLevel.map((group) => group.label)).toEqual(['Junior', 'Senior']);
    });

    it('given countries, when summarised, then each is a group in its own right', async () => {
      await setUp([
        { name: 'A', amountMinor: dollars(100_000), country: 'US' },
        { name: 'B', amountMinor: dollars(90_000), country: 'US' },
        { name: 'C', amountMinor: 500_000_000, currency: 'INR', country: 'IN' },
      ]);

      const { byCountry } = await computeStatistics(db, baseQuery);

      expect(byCountry.map((group) => group.label).sort()).toEqual(['IN', 'US']);
      // Ordered by cost, so the largest line in the payroll is first.
      expect(byCountry[0]?.label).toBe('US');
    });
  });

  describe('filters', () => {
    it('given a department filter, when summarised, then only that department is counted', async () => {
      await setUp([
        { name: 'E1', amountMinor: dollars(60_000), department: 'engineering' },
        { name: 'S1', amountMinor: dollars(50_000), department: 'sales' },
      ]);

      const { overall } = await computeStatistics(db, { ...baseQuery, departmentId: engineering });

      expect(overall.headcount).toBe(1);
      expect(overall.totalUsdMinor).toBe(dollars(60_000));
    });

    it('given filters that match nobody, when summarised, then it reports nothing rather than failing', async () => {
      await setUp([{ name: 'E1', amountMinor: dollars(60_000), country: 'US' }]);

      const { overall, byDepartment, distribution } = await computeStatistics(db, {
        ...baseQuery,
        country: 'IN',
      });

      expect(overall.headcount).toBe(0);
      expect(byDepartment).toEqual([]);
      expect(distribution).toEqual([]);
    });
  });

  describe('the distribution', () => {
    it('given a spread of salaries, when bucketed, then every person lands in exactly one bar', async () => {
      const amounts = [
        dollars(40_000),
        dollars(55_000),
        dollars(60_000),
        dollars(75_000),
        dollars(90_000),
        dollars(140_000),
      ];
      await setUp(
        amounts.map((amountMinor, index) => ({ name: `P${String(index)}`, amountMinor })),
      );

      const { distribution, overall } = await computeStatistics(db, baseQuery);

      const counted = distribution.reduce((total, bucket) => total + bucket.employees, 0);
      expect(counted).toBe(overall.paidHeadcount);
    });

    it('given a spread, when bucketed, then the bars are contiguous and cover the range', async () => {
      const amounts = [dollars(40_000), dollars(90_000), dollars(140_000)];
      await setUp(
        amounts.map((amountMinor, index) => ({ name: `P${String(index)}`, amountMinor })),
      );

      const { distribution, overall } = await computeStatistics(db, baseQuery);

      expect(distribution[0]?.fromUsdMinor).toBe(overall.minUsdMinor);
      expect(distribution.at(-1)?.toUsdMinor).toBe(overall.maxUsdMinor);
      for (const [index, bucket] of distribution.entries()) {
        if (index > 0) {
          expect(bucket.fromUsdMinor).toBe(distribution[index - 1]?.toUsdMinor);
        }
      }
    });

    it('given a gap in the middle, when bucketed, then it is a bar of zero rather than a missing bar', async () => {
      /* The gap is the interesting part — it is where a pay band has nobody in
         it. A missing bar would make the histogram narrower and hide it. */
      await setUp([
        { name: 'Low', amountMinor: dollars(40_000) },
        { name: 'High', amountMinor: dollars(200_000) },
      ]);

      const { distribution } = await computeStatistics(db, baseQuery);

      expect(distribution.filter((bucket) => bucket.employees === 0).length).toBeGreaterThan(0);
    });

    it('given everybody on the same salary, when bucketed, then it does not fall over', async () => {
      /* width_bucket refuses a range with equal bounds outright, so this would
         be a 500 on a company where everyone is paid the same. */
      await setUp([
        { name: 'A', amountMinor: dollars(60_000) },
        { name: 'B', amountMinor: dollars(60_000) },
      ]);

      const { distribution } = await computeStatistics(db, baseQuery);

      expect(distribution.reduce((total, bucket) => total + bucket.employees, 0)).toBe(2);
    });

    it('given the highest earner, when bucketed, then they are in the last bar rather than beyond it', async () => {
      // The top value lands in bucket 11 by definition and must be folded back.
      await setUp([
        { name: 'Low', amountMinor: dollars(40_000) },
        { name: 'Top', amountMinor: dollars(140_000) },
      ]);

      const { distribution } = await computeStatistics(db, baseQuery);

      expect(distribution).toHaveLength(10);
      expect(distribution.at(-1)?.employees).toBe(1);
    });
  });
});
