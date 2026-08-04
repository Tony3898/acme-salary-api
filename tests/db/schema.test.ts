import { sql } from 'drizzle-orm';
import {
  compensationRecords,
  departments,
  employees,
  fxRates,
  jobLevels,
  salaryBands,
  users,
} from '../../src/db/schema';
import { one, rejectionReason, useTestDatabases, type TestDb } from '../helpers/testDb';

/**
 * These tests are about the constraints, not the queries. Anything the database
 * can refuse on its own is one less thing every code path has to remember.
 */
describe('schema', () => {
  const databases = useTestDatabases();
  let db: TestDb;
  let departmentId: number;
  let jobLevelId: number;

  beforeEach(async () => {
    db = await databases.create();
    departmentId = one(await db.insert(departments).values({ name: 'Engineering' }).returning()).id;
    jobLevelId = one(
      await db.insert(jobLevels).values({ name: 'Senior Engineer', rank: 30 }).returning(),
    ).id;
  });

  /* A fresh database per test, so a constraint test cannot be affected by rows
     another one left behind — and each is released rather than piling up. */
  afterEach(databases.closeAll);

  const anEmployee = (overrides: Partial<typeof employees.$inferInsert> = {}) => ({
    fullName: 'Sarah Fisher',
    email: 'sarah.fisher@acme.test',
    country: 'GB',
    departmentId,
    jobLevelId,
    hireDate: '2022-01-01',
    ...overrides,
  });

  it('given a valid employee, when inserted, then it is stored with an active status by default', async () => {
    const [row] = await db.insert(employees).values(anEmployee()).returning();

    expect(row?.status).toBe('ACTIVE');
    expect(row?.gender).toBeNull();
  });

  it('given the same email in different case, when inserted twice, then the second is rejected', async () => {
    // Login looks people up by email, so two rows differing only in case is an ambiguity.
    await db.insert(employees).values(anEmployee());

    await expect(
      rejectionReason(db.insert(employees).values(anEmployee({ email: 'Sarah.Fisher@ACME.test' }))),
    ).resolves.toMatch(/employees_email_lower_idx/);
  });

  it('given a missing department, when an employee is inserted, then it is rejected', async () => {
    await expect(
      rejectionReason(db.insert(employees).values(anEmployee({ departmentId: 9999 }))),
    ).resolves.toMatch(/employees_department_id_departments_id_fk/);
  });

  it('given a manager who is another employee, when set, then the reference is accepted', async () => {
    const [manager] = await db.insert(employees).values(anEmployee()).returning();

    const [report] = await db
      .insert(employees)
      .values(anEmployee({ email: 'report@acme.test', managerId: manager?.id }))
      .returning();

    expect(report?.managerId).toBe(manager?.id);
  });

  describe('compensation records', () => {
    let employeeId: number;

    beforeEach(async () => {
      employeeId = one(await db.insert(employees).values(anEmployee()).returning()).id;
    });

    it('given an amount in minor units, when read back, then it is an exact number', async () => {
      const [row] = await db
        .insert(compensationRecords)
        .values({
          employeeId,
          amountMinor: 8_500_050,
          currency: 'GBP',
          effectiveFrom: '2022-01-01',
          reason: 'Hired',
        })
        .returning();

      expect(row?.amountMinor).toBe(8_500_050);
    });

    it.each([0, -1])(
      'given an amount of %s, when inserted, then it is rejected',
      async (amountMinor) => {
        // Nobody is paid nothing. A zero here would silently drag every average down.
        await expect(
          rejectionReason(
            db.insert(compensationRecords).values({
              employeeId,
              amountMinor,
              currency: 'GBP',
              effectiveFrom: '2022-01-01',
            }),
          ),
        ).resolves.toMatch(/compensation_amount_positive/);
      },
    );

    it('given an amount past exact integer arithmetic, when inserted directly, then it is rejected', async () => {
      /* The domain refuses this at the boundary; this is the database backstop
         for anything reaching it another way. Written as raw SQL because the
         value cannot be expressed exactly as a JS number, which is the point. */
      await expect(
        rejectionReason(
          db.execute(
            sql`INSERT INTO compensation_records (employee_id, amount_minor, currency, effective_from)
                VALUES (${employeeId}, 9007199254740992, 'GBP', '2022-01-01')`,
          ),
        ),
      ).resolves.toMatch(/compensation_amount_within_exact_range/);
    });

    it('given an unsupported currency, when inserted, then it is rejected', async () => {
      // JPY has no minor unit; the arithmetic assumes two decimal places throughout.
      await expect(
        rejectionReason(
          db.execute(
            sql`INSERT INTO compensation_records (employee_id, amount_minor, currency, effective_from)
              VALUES (${employeeId}, 8500050, 'JPY', '2022-01-01')`,
          ),
        ),
      ).resolves.toMatch(/invalid input value for enum|currency/i);
    });

    it('given a date, when stored and read, then it is the same calendar day', async () => {
      /* Dates are stored as plain YYYY-MM-DD, never as a timestamp. A raise
         starting today must not read as pending for somebody in Sydney. */
      const [row] = await db
        .insert(compensationRecords)
        .values({
          employeeId,
          amountMinor: 8_500_050,
          currency: 'GBP',
          effectiveFrom: '2026-01-01',
        })
        .returning();

      expect(row?.effectiveFrom).toBe('2026-01-01');
    });

    it('given two records starting the same day, when inserted, then both are kept', async () => {
      /* Deliberately not unique on (employee_id, effective_from): a correction
         issued the same day is legitimate. The higher id wins when reading. */
      const record = {
        employeeId,
        currency: 'GBP' as const,
        effectiveFrom: '2025-04-01',
      };
      await db.insert(compensationRecords).values({ ...record, amountMinor: 9_000_000 });
      await db.insert(compensationRecords).values({ ...record, amountMinor: 9_100_000 });

      const rows = await db.select().from(compensationRecords);

      expect(rows).toHaveLength(2);
    });

    it('given an employee is deleted, when they had salary records, then the delete is refused', async () => {
      // Salary history is the audit trail; it must not disappear with a stray delete.
      await db.insert(compensationRecords).values({
        employeeId,
        amountMinor: 8_500_050,
        currency: 'GBP',
        effectiveFrom: '2022-01-01',
      });

      await expect(rejectionReason(db.delete(employees))).resolves.toMatch(
        /compensation_records_employee_id_employees_id_fk/,
      );
    });
  });

  describe('salary bands', () => {
    it('given a band where the minimum exceeds the maximum, when inserted, then it is rejected', async () => {
      await expect(
        rejectionReason(
          db.insert(salaryBands).values({
            jobLevelId,
            country: 'GB',
            currency: 'GBP',
            minMinor: 9_000_000,
            midMinor: 8_000_000,
            maxMinor: 7_000_000,
          }),
        ),
      ).resolves.toMatch(/salary_band_ordered/);
    });

    it('given a band for a level and country, when a second is added, then it is rejected', async () => {
      // One band per level per country, or "is this person paid fairly" has two answers.
      const band = {
        jobLevelId,
        country: 'GB',
        currency: 'GBP' as const,
        minMinor: 7_000_000,
        midMinor: 8_000_000,
        maxMinor: 9_000_000,
      };
      await db.insert(salaryBands).values(band);

      await expect(rejectionReason(db.insert(salaryBands).values(band))).resolves.toMatch(
        /salary_bands_level_country_idx/,
      );
    });
  });

  describe('exchange rates', () => {
    it('given a rate, when stored, then it keeps full precision', async () => {
      const [row] = await db
        .insert(fxRates)
        .values({ currency: 'INR', rateToUsd: '0.01204', asOf: '2026-08-04' })
        .returning();

      /* numeric arrives as a scale-padded string, never a float — which is the
         point: the rate is multiplied across 10,000 salaries, and conversion is
         done by Postgres so the value never passes through JS arithmetic. */
      expect(row?.rateToUsd).toBe('0.01204000');
      expect(typeof row?.rateToUsd).toBe('string');
    });

    it('given a rate of zero or less, when stored, then it is rejected', async () => {
      // A zero rate would report every salary in that currency as costing nothing.
      await expect(
        rejectionReason(
          db.insert(fxRates).values({ currency: 'EUR', rateToUsd: '0', asOf: '2026-08-04' }),
        ),
      ).resolves.toMatch(/fx_rate_positive/);
    });

    it('given a currency, when a second rate is added for it, then it is rejected', async () => {
      // A single snapshot, so conversion has exactly one answer.
      await db.insert(fxRates).values({ currency: 'EUR', rateToUsd: '1.08', asOf: '2026-08-04' });

      await expect(
        rejectionReason(
          db.insert(fxRates).values({ currency: 'EUR', rateToUsd: '1.09', asOf: '2026-08-05' }),
        ),
      ).resolves.toMatch(/fx_rates_pkey/);
    });
  });

  describe('users', () => {
    it('given a user, when inserted, then no plaintext password column exists to fill', async () => {
      const [row] = await db
        .insert(users)
        .values({
          email: 'hr.admin@acme.test',
          passwordHash: '$argon2id$fake-for-schema-test',
          role: 'HR_ADMIN',
        })
        .returning();

      expect(row).not.toHaveProperty('password');
      expect(Object.keys(row ?? {})).toContain('passwordHash');
    });

    it.each(['MANAGER', 'EMPLOYEE'] as const)(
      'given a %s login with no employee linked, when inserted, then it is rejected',
      async (role) => {
        /* These roles are scoped by which employee they are: a Manager sees their
           own reporting line, an Employee sees themselves. Without a link there is
           no answer to "who can this user see". */
        await expect(
          rejectionReason(
            db.insert(users).values({ email: 'orphan@acme.test', passwordHash: 'x', role }),
          ),
        ).resolves.toMatch(/users_scoped_role_needs_employee/);
      },
    );

    it('given an HR login with no employee linked, when inserted, then it is accepted', async () => {
      // HR sees everyone, so it needs no link to a person.
      const [row] = await db
        .insert(users)
        .values({ email: 'hr.only@acme.test', passwordHash: 'x', role: 'HR_VIEWER' })
        .returning();

      expect(row?.employeeId).toBeNull();
    });

    it('given an unknown role, when inserted, then it is rejected', async () => {
      await expect(
        rejectionReason(
          db.execute(
            sql`INSERT INTO users (email, password_hash, role)
              VALUES ('nobody@acme.test', 'x', 'SUPERUSER')`,
          ),
        ),
      ).resolves.toMatch(/invalid input value for enum/i);
    });

    it('given the same email in different case, when inserted twice, then the second is rejected', async () => {
      await db
        .insert(users)
        .values({ email: 'hr@acme.test', passwordHash: 'x', role: 'HR_VIEWER' });

      await expect(
        rejectionReason(
          db.insert(users).values({ email: 'HR@acme.test', passwordHash: 'x', role: 'HR_VIEWER' }),
        ),
      ).resolves.toMatch(/users_email_lower_idx/);
    });
  });
});
