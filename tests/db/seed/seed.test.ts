import { sql } from 'drizzle-orm';
import { compensationRecords, employees, jobLevels, salaryBands, users } from '../../../src/db/schema';
import { seed } from '../../../src/db/seed/seed';
import { useTestDatabases, type TestDb } from '../../helpers/testDb';

/**
 * The seed is test infrastructure as much as a demo: other tests rely on it
 * producing the same data every time. These tests are run with a small headcount
 * — the shape is what matters, and 10,000 rows would only make them slow.
 */
const SEED_OPTIONS = {
  employeeCount: 300,
  randomSeed: 42,
  today: '2026-08-04',
  demoPassword: 'test-only-password',
} as const;

describe('seed', () => {
  const databases = useTestDatabases();
  let db: TestDb;

  /* Seeded once for the whole file: all but three of these tests only read, and
     re-seeding per test made the suite twenty seconds slower for no extra
     coverage. The three that need isolation build their own database. */
  beforeAll(async () => {
    db = await databases.create();
    await seed(db, SEED_OPTIONS);
  });

  afterAll(databases.closeAll);

  const countOf = async (table: typeof employees | typeof compensationRecords) => {
    const [row] = await db.select({ total: sql<number>`count(*)::int` }).from(table);
    return row?.total ?? 0;
  };

  it('given a headcount, when seeded, then exactly that many employees exist', async () => {
    expect(await countOf(employees)).toBe(SEED_OPTIONS.employeeCount);
  });

  it('given the same seed, when run twice on separate databases, then the data is identical', async () => {
    /* Other tests assert on seeded values, so this has to be reproducible. Any
       accidental use of Math.random or the system clock breaks this test. */
    const fingerprint = async (target: TestDb) => {
      await seed(target, SEED_OPTIONS);
      const rows = await target
        .select({
          name: employees.fullName,
          email: employees.email,
          country: employees.country,
          hireDate: employees.hireDate,
        })
        .from(employees)
        .orderBy(employees.id);
      const [totals] = await target
        .select({ payroll: sql<number>`sum(${compensationRecords.amountMinor})::bigint` })
        .from(compensationRecords);
      return JSON.stringify({ rows, payroll: totals?.payroll });
    };

    expect(await fingerprint(db)).toBe(await fingerprint(await databases.create()));
  });

  it('given a different seed, when seeded, then the data differs', async () => {
    // Guards against the seed being ignored entirely, which would make the test above vacuous.
    const first = await db
      .select({ name: employees.fullName })
      .from(employees)
      .orderBy(employees.id);

    const other = await databases.create();
    await seed(other, { ...SEED_OPTIONS, randomSeed: 7 });
    const second = await other
      .select({ name: employees.fullName })
      .from(employees)
      .orderBy(employees.id);

    expect(second).not.toEqual(first);
  });

  it('given seeded employees, when their salary history is read, then everyone has a record starting on their hire date', async () => {
    const [row] = await db.select({ missing: sql<number>`count(*)::int` }).from(sql`
      (SELECT e.id
         FROM ${employees} e
         LEFT JOIN ${compensationRecords} c
           ON c.employee_id = e.id AND c.effective_from = e.hire_date
        WHERE c.id IS NULL) AS gaps
    `);

    expect(row?.missing).toBe(0);
  });

  it('given seeded employees, when raises are counted, then salary history has more rows than people', async () => {
    // A history of exactly one record each would make "view any past date" pointless.
    expect(await countOf(compensationRecords)).toBeGreaterThan(SEED_OPTIONS.employeeCount);
  });

  it('given seeded salary history, when checked against today, then no record starts in the future', async () => {
    const [row] = await db
      .select({ future: sql<number>`count(*)::int` })
      .from(compensationRecords)
      .where(sql`${compensationRecords.effectiveFrom} > ${SEED_OPTIONS.today}`);

    expect(row?.future).toBe(0);
  });

  it('given any salary history, when read in date order, then pay never goes down', async () => {
    /* The obvious property of a raise history, and the one an earlier version of
       this suite did not check: the dates were generated in reverse, so amounts
       compounded upwards while the dates ran backwards, and everybody's pay fell
       every year. Every other test still passed. */
    const [row] = await db.select({ payCuts: sql<number>`count(*)::int` }).from(sql`
      (SELECT amount_minor - lag(amount_minor)
                OVER (PARTITION BY employee_id ORDER BY effective_from, id) AS delta
         FROM ${compensationRecords}) deltas
      WHERE delta < 0
    `);

    expect(row?.payCuts).toBe(0);
  });

  it('given a person with several records, when the latest is read, then it is their highest', async () => {
    // The current salary is the top of the ladder, not a step somewhere down it.
    const [row] = await db.select({ mismatches: sql<number>`count(*)::int` }).from(sql`
      (SELECT employee_id
         FROM (SELECT employee_id, amount_minor,
                      max(amount_minor) OVER (PARTITION BY employee_id) AS highest,
                      row_number() OVER (PARTITION BY employee_id
                                         ORDER BY effective_from DESC, id DESC) AS recency
                 FROM ${compensationRecords}) ranked
        WHERE recency = 1 AND amount_minor <> highest) AS wrong
    `);

    expect(row?.mismatches).toBe(0);
  });

  it('given the pay bands, when salaries are compared, then some sit above as well as below', async () => {
    /* Both are needed: "needs attention" lists people below their band, and the
       bulk-raise preview warns about people who would go above theirs. An earlier
       version could never produce an above-band case, so that warning could never
       have been demonstrated. */
    const [row] = await db.select({ below: sql<number>`below`, above: sql<number>`above` })
      .from(sql`
      (WITH current_pay AS (
         SELECT DISTINCT ON (employee_id) employee_id, amount_minor
           FROM ${compensationRecords}
          WHERE effective_from <= ${SEED_OPTIONS.today}
          ORDER BY employee_id, effective_from DESC, id DESC)
       SELECT count(*) FILTER (WHERE c.amount_minor < b.min_minor)::int AS below,
              count(*) FILTER (WHERE c.amount_minor > b.max_minor)::int AS above
         FROM ${employees} e
         JOIN current_pay c ON c.employee_id = e.id
         JOIN ${salaryBands} b
           ON b.job_level_id = e.job_level_id AND b.country = e.country) AS spread
    `);

    expect(row?.below).toBeGreaterThan(0);
    expect(row?.above).toBeGreaterThan(0);
  });

  it('given the reporting hierarchy, when traversed, then it is a single tree with no cycles', async () => {
    const [roots] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(employees)
      .where(sql`${employees.managerId} IS NULL`);
    const [selfManaged] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(employees)
      .where(sql`${employees.managerId} = ${employees.id}`);
    // Everyone must be reachable from the root, or a cycle exists somewhere.
    const [reachable] = await db.select({ total: sql<number>`count(*)::int` }).from(sql`
      (WITH RECURSIVE tree AS (
         SELECT id FROM ${employees} WHERE manager_id IS NULL
         UNION ALL
         SELECT e.id FROM ${employees} e JOIN tree t ON e.manager_id = t.id
       ) SELECT id FROM tree) AS reached
    `);

    expect(roots?.total).toBe(1);
    expect(selfManaged?.total).toBe(0);
    expect(reachable?.total).toBe(SEED_OPTIONS.employeeCount);
  });

  it('given every employee, when their pay band is looked up, then one exists for their level and country', async () => {
    // Compa-ratio and the "needs attention" list are meaningless without a band.
    const [row] = await db.select({ missing: sql<number>`count(*)::int` }).from(sql`
      (SELECT e.id
         FROM ${employees} e
         LEFT JOIN ${salaryBands} b
           ON b.job_level_id = e.job_level_id AND b.country = e.country
        WHERE b.id IS NULL) AS gaps
    `);

    expect(row?.missing).toBe(0);
  });

  it('given a pay band and an employee, when compared, then the salary is in that country currency', async () => {
    /* Fairness is judged against the local band, so a salary recorded in the
       wrong currency would silently compare a rupee figure to a pound band. */
    const [row] = await db.select({ mismatched: sql<number>`count(*)::int` }).from(sql`
      (SELECT c.id
         FROM ${compensationRecords} c
         JOIN ${employees} e ON e.id = c.employee_id
         JOIN ${salaryBands} b ON b.job_level_id = e.job_level_id AND b.country = e.country
        WHERE c.currency <> b.currency) AS mismatches
    `);

    expect(row?.mismatched).toBe(0);
  });

  it('given comparable people, when pay is compared by gender, then a small deliberate gap exists', async () => {
    /* Randomly generated salaries show no gap, so the pay-gap screen would have
       nothing to display. The seed introduces one on purpose; the README says the
       data is synthetic.

       Compared within a level and country, and only where both groups have at
       least five people — the same two rules the feature itself uses. Comparing
       raw amounts across countries would just be measuring the exchange rate:
       a median that mixes rupees with dollars means nothing. */
    const target = await databases.create();
    // Needs more people than the other tests: 36 level/country groups have to
    // reach five of each gender before a comparison is meaningful.
    await seed(target, { ...SEED_OPTIONS, employeeCount: 1500 });

    const [row] = await target.select({
      medianRatio: sql<number>`median_ratio`,
      groups: sql<number>`groups`,
    }).from(sql`
      (WITH current_pay AS (
         SELECT DISTINCT ON (employee_id) employee_id, amount_minor
           FROM ${compensationRecords}
          WHERE effective_from <= ${SEED_OPTIONS.today}
          ORDER BY employee_id, effective_from DESC, id DESC),
       comparable AS (
         SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY c.amount_minor)
                  FILTER (WHERE e.gender = 'FEMALE') AS female_median,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY c.amount_minor)
                  FILTER (WHERE e.gender = 'MALE') AS male_median,
                count(*) FILTER (WHERE e.gender = 'FEMALE') AS female_count,
                count(*) FILTER (WHERE e.gender = 'MALE') AS male_count
           FROM ${employees} e
           JOIN current_pay c ON c.employee_id = e.id
          GROUP BY e.job_level_id, e.country)
       SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY female_median / male_median)
                AS median_ratio,
              count(*)::int AS groups
         FROM comparable
        WHERE female_count >= 5 AND male_count >= 5) AS gap
    `);

    // Enough groups clear the small-cell rule for the figure to mean something.
    expect(row?.groups).toBeGreaterThan(5);
    // Present, but not so large it looks like a bug in the generator.
    expect(Number(row?.medianRatio)).toBeLessThan(1);
    expect(Number(row?.medianRatio)).toBeGreaterThan(0.88);
  });

  it('given the seeded staff, when statuses are counted, then some people have left', async () => {
    /* Every employee being active would leave the status filter, and the
       active-only default on the employee list, with nothing to act on. */
    const rows = await db
      .select({ status: employees.status, total: sql<number>`count(*)::int` })
      .from(employees)
      .groupBy(employees.status);
    const byStatus = new Map(rows.map((row) => [row.status, row.total]));

    expect(byStatus.get('ACTIVE') ?? 0).toBeGreaterThan(0);
    expect(byStatus.get('LEFT') ?? 0).toBeGreaterThan(0);
  });

  it('given the people who have left, when their reports are counted, then nobody reported to them', async () => {
    // A departed manager would leave their team pointing at an inactive person.
    const [row] = await db.select({ orphaned: sql<number>`count(*)::int` }).from(sql`
      (SELECT report.id
         FROM ${employees} report
         JOIN ${employees} manager ON manager.id = report.manager_id
        WHERE manager.status = 'LEFT') AS orphans
    `);

    expect(row?.orphaned).toBe(0);
  });

  it('given each job level, when unrecorded gender is measured, then the rate does not vary with seniority', async () => {
    /* It once ran from 5% at junior levels to 20% at director, purely as an
       arithmetic accident. Because the pay-gap analysis hides small groups, that
       quietly removed senior data — which is where a gap matters most. */
    const rows = await db
      .select({
        rank: jobLevels.rank,
        unrecordedShare: sql<number>`
          (count(*) FILTER (WHERE ${employees.gender} IS NULL))::float / count(*)`,
      })
      .from(employees)
      .innerJoin(jobLevels, sql`${jobLevels.id} = ${employees.jobLevelId}`)
      .groupBy(jobLevels.rank);
    const shares = rows.map((row) => Number(row.unrecordedShare));

    // Sampling noise at 300 people is wide, but a 4x drift is not noise.
    expect(Math.max(...shares) - Math.min(...shares)).toBeLessThan(0.1);
  });

  it('given the demo accounts, when seeded, then there is one per role and scoped roles link to a person', async () => {
    const accounts = await db
      .select({ email: users.email, role: users.role, employeeId: users.employeeId })
      .from(users)
      .orderBy(users.role);

    expect(accounts.map((account) => account.role)).toEqual([
      'HR_ADMIN',
      'HR_VIEWER',
      'MANAGER',
      'EMPLOYEE',
    ]);
    for (const account of accounts.filter((a) => a.role === 'MANAGER' || a.role === 'EMPLOYEE')) {
      expect(account.employeeId).not.toBeNull();
    }
  });

  it('given the demo manager account, when their reports are counted, then they actually manage people', async () => {
    // A manager with no reports would make the access-scope demo show nothing.
    const [row] = await db.select({ reports: sql<number>`count(*)::int` }).from(sql`
      (SELECT e.id FROM ${employees} e
         WHERE e.manager_id = (SELECT employee_id FROM ${users} WHERE role = 'MANAGER')) AS team
    `);

    expect(row?.reports).toBeGreaterThan(0);
  });

  it('given an already seeded database, when seeded again, then it is replaced rather than duplicated', async () => {
    const target = await databases.create();
    await seed(target, SEED_OPTIONS);
    await seed(target, SEED_OPTIONS);

    const [row] = await target.select({ total: sql<number>`count(*)::int` }).from(employees);

    expect(row?.total).toBe(SEED_OPTIONS.employeeCount);
  });

  it('given some employees, when their salary is compared to their band, then a few sit below it', async () => {
    // The "needs attention" list needs something to attend to.
    const [row] = await db.select({ below: sql<number>`count(*)::int` }).from(sql`
      (SELECT e.id
         FROM ${employees} e
         JOIN ${salaryBands} b ON b.job_level_id = e.job_level_id AND b.country = e.country
         JOIN (SELECT DISTINCT ON (employee_id) employee_id, amount_minor
                 FROM ${compensationRecords}
                WHERE effective_from <= ${SEED_OPTIONS.today}
                ORDER BY employee_id, effective_from DESC, id DESC) c
           ON c.employee_id = e.id
        WHERE c.amount_minor < b.min_minor) AS underpaid
    `);

    expect(row?.below).toBeGreaterThan(0);
  });
});
