import {
  compensationRecords,
  departments,
  employees,
  fxRates,
  jobLevels,
} from '../../src/db/schema';
import { listEmployees } from '../../src/repositories/employees';
import { useTestDatabases, type TestDb } from '../helpers/testDb';

/**
 * Two paths the HTTP tests cannot reach.
 *
 * The first is a currency with no exchange rate, which the seeded data never has.
 * The second is a scope covering nobody, which a valid token cannot produce —
 * the database and the token schema both refuse a scoped login with no employee.
 * Both are the failure modes that matter most, so they are exercised directly.
 */
describe('listEmployees', () => {
  const databases = useTestDatabases();
  let db: TestDb;

  const baseQuery = {
    asOf: '2026-08-04',
    page: 1,
    pageSize: 25 as const,
    sortBy: 'name' as const,
    sortDir: 'asc' as const,
  };

  beforeEach(async () => {
    db = await databases.create();

    const [department] = await db.insert(departments).values({ name: 'Engineering' }).returning();
    const [level] = await db.insert(jobLevels).values({ name: 'Senior', rank: 3 }).returning();
    if (!department || !level) {
      throw new Error('Failed to seed lookups.');
    }

    const [person] = await db
      .insert(employees)
      .values({
        fullName: 'Paid In Euros',
        email: 'euros@acme.test',
        country: 'DE',
        departmentId: department.id,
        jobLevelId: level.id,
        hireDate: '2024-01-01',
      })
      .returning({ id: employees.id });
    if (!person) {
      throw new Error('Failed to seed the employee.');
    }

    await db.insert(compensationRecords).values({
      employeeId: person.id,
      amountMinor: 9_000_000,
      currency: 'EUR',
      effectiveFrom: '2024-01-01',
    });
  });

  afterEach(databases.closeAll);

  it('given a salary in a currency with no rate, when listed, then it fails rather than omitting the person', async () => {
    /* Converting is how every cost figure is produced. Dropping the people whose
       currency has no rate would make a payroll total quietly too small — wrong in
       the direction nobody checks, because the page still looks fine. */
    await expect(listEmployees(db, { ...baseQuery, scope: { kind: 'ALL' } })).rejects.toThrow(
      /No exchange rate for EUR/,
    );
  });

  it('given a rate exists, when listed, then the same query succeeds', async () => {
    // The other side of it: the failure above is about the missing rate, nothing else.
    await db.insert(fxRates).values({ currency: 'EUR', rateToUsd: '1.08000000', asOf: '2026-08-01' });

    const { rows, total } = await listEmployees(db, { ...baseQuery, scope: { kind: 'ALL' } });

    expect(total).toBe(1);
    // 9,000,000 cents at 1.08 is 9,720,000.
    expect(rows[0]?.salary?.amountUsdMinor).toBe(9_720_000);
  });

  it('given a scope covering nobody, when listed, then nothing is returned', async () => {
    /* A permissions bug has to fail closed. If the scope cannot be resolved the
       answer is an empty list, which somebody notices, rather than everybody,
       which nobody does. */
    const { rows, total } = await listEmployees(db, { ...baseQuery, scope: { kind: 'NONE' } });

    expect(rows).toEqual([]);
    expect(total).toBe(0);
  });
});
