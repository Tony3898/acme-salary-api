import request from 'supertest';
import { employees } from '../../src/db/schema';
import { accessTokenFrom, bodyOf, errorOf } from '../helpers/http';
import { seedOrg, type SeededOrg } from '../helpers/org';
import { createTestHarness, TEST_PASSWORD, type TestHarness } from '../helpers/testApp';

/**
 * Recording a raise — the one write in the application so far, into a table
 * nothing ever updates or deletes.
 *
 * That is what makes the validation worth this much attention. A wrong figure
 * cannot be edited away; it can only be corrected by another record, and both
 * stay in the history for good.
 */

interface Detail {
  employee: { id: number; salary: { amountMinor: number; currency: string } | null };
  history: {
    amountMinor: number;
    currency: string;
    effectiveFrom: string;
    reason: string | null;
    recordedByEmail: string | null;
    isCurrent: boolean;
    isScheduled: boolean;
  }[];
}

describe('POST /api/employees/:id/compensation', () => {
  let harness: TestHarness;
  let org: SeededOrg;
  const tokens = new Map<string, string>();

  const authorised = (email: string): string => {
    const token = tokens.get(email);
    if (token === undefined) {
      throw new Error(`No token for ${email}.`);
    }
    return `Bearer ${token}`;
  };

  const detailOf = (response: request.Response): Detail => bodyOf(response) as unknown as Detail;

  /** A fresh person per test, so an append-only table cannot leak between them. */
  let subject: number;
  let nextEmail = 0;

  beforeAll(async () => {
    harness = await createTestHarness();
    const managerEmployeeId = harness.accounts.manager.employeeId;
    if (managerEmployeeId === null) {
      throw new Error('The manager account must be linked to an employee.');
    }
    org = await seedOrg(harness.db, managerEmployeeId);

    for (const email of ['hr.admin@acme.test', 'hr.viewer@acme.test', 'manager@acme.test']) {
      const login = await request(harness.app)
        .post('/api/auth/login')
        .send({ email, password: TEST_PASSWORD });
      tokens.set(email, accessTokenFrom(login));
    }
  });

  beforeEach(async () => {
    nextEmail += 1;
    const [created] = await harness.db
      .insert(employees)
      .values({
        fullName: `Subject ${String(nextEmail)}`,
        email: `subject${String(nextEmail)}@acme.test`,
        country: 'US',
        departmentId: org.salesId,
        jobLevelId: org.juniorLevelId,
        hireDate: '2024-01-15',
        managerId: org.outside.lead,
      })
      .returning({ id: employees.id });

    if (created === undefined) {
      throw new Error('Failed to create the test subject.');
    }
    subject = created.id;
  });

  afterAll(async () => {
    await harness.close();
  });

  const recordAs = (email: string, body: object, id = subject) =>
    request(harness.app)
      .post(`/api/employees/${String(id)}/compensation`)
      .set('Authorization', authorised(email))
      .send(body);

  const validRaise = {
    amount: '95000.50',
    currency: 'USD',
    effectiveFrom: '2026-09-01',
    reason: 'Annual review',
  };

  describe('who may record pay', () => {
    it('given HR Admin, when they record a raise, then it is saved', async () => {
      const response = await recordAs('hr.admin@acme.test', validRaise);

      expect(response.status).toBe(200);
      expect(detailOf(response).history).toHaveLength(1);
    });

    it('given HR Viewer, when they try, then it is refused', async () => {
      /* Read-only means read-only. HR Viewer can see every salary in the
         company, which is exactly why being able to change one is a different
         permission. */
      const response = await recordAs('hr.viewer@acme.test', validRaise);

      expect(response.status).toBe(403);
    });

    it('given a Manager, when they try on their own report, then it is refused', async () => {
      const response = await recordAs('manager@acme.test', validRaise, org.chain.report);

      expect(response.status).toBe(403);
    });

    it('given no token, when a raise is posted, then it is refused', async () => {
      const response = await request(harness.app)
        .post(`/api/employees/${String(subject)}/compensation`)
        .send(validRaise);

      expect(response.status).toBe(401);
    });

    it('given an employee who does not exist, when a raise is posted, then it is a 404', async () => {
      const response = await recordAs('hr.admin@acme.test', validRaise, 999_999);

      expect(response.status).toBe(404);
    });
  });

  describe('what counts as a valid amount', () => {
    const rejected: [string, object][] = [
      ['three decimal places', { ...validRaise, amount: '95000.123' }],
      // 95,000.50 in most of Europe is 95000.5; stripping the comma reads it as 9.5 million.
      ['a thousands separator', { ...validRaise, amount: '95,000.50' }],
      ['a European decimal comma', { ...validRaise, amount: '95000,50' }],
      ['nothing at all', { ...validRaise, amount: '' }],
      ['words', { ...validRaise, amount: 'lots' }],
      ['zero', { ...validRaise, amount: '0.00' }],
      ['a negative amount', { ...validRaise, amount: '-500.00' }],
      ['a number rather than a string', { ...validRaise, amount: 95_000.5 }],
      ['an unsupported currency', { ...validRaise, currency: 'JPY' }],
      ['a date that is not a real day', { ...validRaise, effectiveFrom: '2026-02-31' }],
      ['a date in the wrong format', { ...validRaise, effectiveFrom: '01/09/2026' }],
      ['no date', { amount: '95000.00', currency: 'USD' }],
    ];

    it.each(rejected)('given %s, when posted, then it is a bad request', async (_name, body) => {
      const response = await recordAs('hr.admin@acme.test', body);

      expect(response.status).toBe(400);
      // A 500 here would say "something went wrong" to somebody who mistyped.
      expect(errorOf(response).code).toBe('INVALID_REQUEST');
    });

    it('given an amount with three decimals, when refused, then the reason names the rule', async () => {
      const response = await recordAs('hr.admin@acme.test', { ...validRaise, amount: '95000.123' });

      expect(errorOf(response).message).toMatch(/two decimal places/i);
    });

    it('given an exact amount, when saved, then it is stored as whole minor units', async () => {
      const response = await recordAs('hr.admin@acme.test', { ...validRaise, amount: '95000.50' });

      // 9500050, not 9500049.999999999.
      expect(detailOf(response).history[0]?.amountMinor).toBe(9_500_050);
    });

    it('given an amount with no decimals, when saved, then it is read as whole units', async () => {
      const response = await recordAs('hr.admin@acme.test', { ...validRaise, amount: '95000' });

      expect(detailOf(response).history[0]?.amountMinor).toBe(9_500_000);
    });
  });

  describe('what counts as a valid date', () => {
    it('given a start before the hire date, when posted, then it is refused', async () => {
      const response = await recordAs('hr.admin@acme.test', {
        ...validRaise,
        effectiveFrom: '2020-01-01',
      });

      expect(response.status).toBe(400);
      expect(errorOf(response).message).toMatch(/hire date/i);
    });

    it('given a future start, when posted, then it is saved as scheduled and is not current', async () => {
      // Signing off a January raise in August is ordinary, and it must not take effect early.
      const response = await recordAs('hr.admin@acme.test', {
        ...validRaise,
        effectiveFrom: '2027-01-01',
      });

      const entry = detailOf(response).history[0];
      expect(entry?.isScheduled).toBe(true);
      expect(entry?.isCurrent).toBe(false);
      expect(detailOf(response).employee.salary).toBeNull();
    });

    it('given a backdated correction after the hire date, when posted, then it is allowed', async () => {
      /* Payroll corrections are backdated all the time. Refusing them would send
         people back to the spreadsheet this replaces. */
      const response = await recordAs('hr.admin@acme.test', {
        ...validRaise,
        effectiveFrom: '2024-02-01',
      });

      expect(response.status).toBe(200);
      expect(detailOf(response).history[0]?.isCurrent).toBe(true);
    });
  });

  describe('recording it twice', () => {
    it('given the same raise posted twice, when it is, then the second is refused', async () => {
      /* A double-clicked button or a retry on a flaky connection. The table is
         append-only, so a duplicate cannot be tidied away afterwards. */
      await recordAs('hr.admin@acme.test', validRaise);
      const second = await recordAs('hr.admin@acme.test', validRaise);

      expect(second.status).toBe(400);
      expect(errorOf(second).message).toMatch(/already exists/i);
    });

    it('given a different amount on the same day, when posted, then the correction wins', async () => {
      /* A correction issued the same day is legitimate, so it is not a
         duplicate. Dated in the past so which one is *current* is observable —
         two records tie on the date and the later id has to break it, the same
         rule the list query uses. */
      const sameDay = { ...validRaise, effectiveFrom: '2025-06-01' };
      await recordAs('hr.admin@acme.test', sameDay);
      const corrected = await recordAs('hr.admin@acme.test', { ...sameDay, amount: '96000.00' });

      expect(corrected.status).toBe(200);
      expect(detailOf(corrected).history).toHaveLength(2);
      expect(detailOf(corrected).employee.salary?.amountMinor).toBe(9_600_000);
      expect(detailOf(corrected).history.filter((entry) => entry.isCurrent)).toHaveLength(1);
    });
  });

  describe('what the record remembers', () => {
    it('given a raise, when recorded, then the account that made it is stored', async () => {
      const response = await recordAs('hr.admin@acme.test', validRaise);

      expect(detailOf(response).history[0]?.recordedByEmail).toBe('hr.admin@acme.test');
    });

    it('given a reason, when recorded, then it is kept with the record', async () => {
      const response = await recordAs('hr.admin@acme.test', validRaise);

      expect(detailOf(response).history[0]?.reason).toBe('Annual review');
    });

    it('given no reason, when recorded, then it is saved without one', async () => {
      const response = await recordAs('hr.admin@acme.test', {
        amount: '95000.00',
        currency: 'USD',
        effectiveFrom: '2026-09-01',
      });

      expect(response.status).toBe(200);
      expect(detailOf(response).history[0]?.reason).toBeNull();
    });

    it('given a raise, when recorded, then the response already shows the new salary', async () => {
      /* One round trip. Returning the whole record rather than the new row means
         the screen redraws from what the database says, not from what the client
         guessed the change would do. */
      const response = await recordAs('hr.admin@acme.test', {
        ...validRaise,
        effectiveFrom: '2026-01-01',
      });

      expect(detailOf(response).employee.salary?.amountMinor).toBe(9_500_050);
    });
  });
});
