import request from 'supertest';
import { accessTokenFrom, bodyOf, errorOf } from '../helpers/http';
import { seedOrg, type SeededOrg } from '../helpers/org';
import { createTestHarness, TEST_PASSWORD, type TestHarness } from '../helpers/testApp';

/**
 * Adding somebody through the portal.
 *
 * The CSV import is for the migration off the spreadsheets; this is for the
 * ordinary case of one person joining, which is most of them. It writes to two
 * tables at once — the record and, when the salary is known, the first
 * compensation row — so the interesting cases are the ones where the second
 * half must not happen on its own.
 */

interface Detail {
  employee: {
    id: number;
    fullName: string;
    email: string;
    country: string;
    managerId: number | null;
    status: string;
    salary: { amountMinor: number; currency: string; effectiveFrom: string } | null;
  };
  history: { amountMinor: number; effectiveFrom: string; reason: string | null }[];
}

describe('POST /api/employees', () => {
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

  /** A fresh address per test: the email is unique, which is half of what is tested. */
  let nextEmail = 0;
  const freshEmail = (): string => {
    nextEmail += 1;
    return `joiner${String(nextEmail)}@acme.test`;
  };

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

  afterAll(async () => {
    await harness.close();
  });

  const createAs = (email: string, body: object) =>
    request(harness.app).post('/api/employees').set('Authorization', authorised(email)).send(body);

  const validJoiner = () => ({
    fullName: 'Nadia Rahman',
    email: freshEmail(),
    country: 'GB',
    departmentId: org.salesId,
    jobLevelId: org.juniorLevelId,
    jobTitle: 'Account Executive',
    hireDate: '2026-09-01',
  });

  describe('who may add somebody', () => {
    it('given HR Admin, when they add somebody, then the record is created', async () => {
      const response = await createAs('hr.admin@acme.test', validJoiner());

      expect(response.status).toBe(201);
      expect(detailOf(response).employee.fullName).toBe('Nadia Rahman');
    });

    it('given HR Viewer, when they try, then it is refused', async () => {
      /* Read-only means read-only. Seeing every salary in the company is exactly
         why creating a record is a different permission. */
      const response = await createAs('hr.viewer@acme.test', validJoiner());

      expect(response.status).toBe(403);
    });

    it('given a Manager, when they try, then it is refused', async () => {
      const response = await createAs('manager@acme.test', validJoiner());

      expect(response.status).toBe(403);
    });

    it('given no token, when somebody is posted, then it is refused', async () => {
      const response = await request(harness.app).post('/api/employees').send(validJoiner());

      expect(response.status).toBe(401);
    });
  });

  describe('the record it creates', () => {
    it('given no starting salary, when created, then they appear with no pay rather than zero', async () => {
      /* A record is often created before the offer is signed off. An invented
         starting salary is worse than a gap the list can show as "not
         recorded". */
      const response = await createAs('hr.admin@acme.test', validJoiner());

      const detail = detailOf(response);
      expect(detail.employee.salary).toBeNull();
      expect(detail.history).toHaveLength(0);
    });

    it('given a starting salary, when created, then it is the first record in their history', async () => {
      const response = await createAs('hr.admin@acme.test', {
        ...validJoiner(),
        hireDate: '2025-03-01',
        startingPay: { amount: '72000.50', currency: 'GBP' },
      });

      const detail = detailOf(response);
      expect(detail.employee.salary).toMatchObject({
        amountMinor: 7_200_050,
        currency: 'GBP',
        // Defaulted to the hire date, which is when a starting salary starts.
        effectiveFrom: '2025-03-01',
      });
      expect(detail.history).toHaveLength(1);
      expect(detail.history[0]?.reason).toBe('Hired');
    });

    it('given an address in capitals, when created, then it is stored in lower case', async () => {
      // The unique index is on lower(email); storing something else invites a duplicate.
      const email = freshEmail();
      const response = await createAs('hr.admin@acme.test', {
        ...validJoiner(),
        email: `  ${email.toUpperCase()} `,
      });

      expect(detailOf(response).employee.email).toBe(email);
    });

    it('given a country in lower case, when created, then it is stored as a code', async () => {
      const response = await createAs('hr.admin@acme.test', { ...validJoiner(), country: 'in' });

      expect(detailOf(response).employee.country).toBe('IN');
    });

    it('given no status, when created, then they are active', async () => {
      const response = await createAs('hr.admin@acme.test', validJoiner());

      expect(detailOf(response).employee.status).toBe('ACTIVE');
    });

    it('given a manager, when created, then they report to them', async () => {
      const response = await createAs('hr.admin@acme.test', {
        ...validJoiner(),
        managerId: org.chain.manager,
      });

      expect(detailOf(response).employee.managerId).toBe(org.chain.manager);
    });
  });

  describe('what it refuses', () => {
    it('given an address somebody already has, when posted, then it is refused', async () => {
      const joiner = validJoiner();
      await createAs('hr.admin@acme.test', joiner).expect(201);

      const response = await createAs('hr.admin@acme.test', {
        ...validJoiner(),
        email: joiner.email,
      });

      expect(response.status).toBe(400);
      expect(errorOf(response).message).toMatch(/already has that email/i);
    });

    it('given the same address in different capitals, when posted, then it is still a duplicate', async () => {
      const joiner = validJoiner();
      await createAs('hr.admin@acme.test', joiner).expect(201);

      const response = await createAs('hr.admin@acme.test', {
        ...validJoiner(),
        email: joiner.email.toUpperCase(),
      });

      expect(response.status).toBe(400);
    });

    it('given a department that does not exist, when posted, then the field is named', async () => {
      /* A stale dropdown option. "Invalid request" would leave whoever is
         filling the form guessing which field to look at. */
      const response = await createAs('hr.admin@acme.test', {
        ...validJoiner(),
        departmentId: 999_999,
      });

      expect(response.status).toBe(400);
      expect(errorOf(response).message).toMatch(/department/i);
    });

    it('given a job level that does not exist, when posted, then the field is named', async () => {
      const response = await createAs('hr.admin@acme.test', {
        ...validJoiner(),
        jobLevelId: 999_999,
      });

      expect(response.status).toBe(400);
      expect(errorOf(response).message).toMatch(/job level/i);
    });

    it('given a manager who does not exist, when posted, then the field is named', async () => {
      const response = await createAs('hr.admin@acme.test', {
        ...validJoiner(),
        managerId: 999_999,
      });

      expect(response.status).toBe(400);
      expect(errorOf(response).message).toMatch(/manager/i);
    });

    it('given a salary starting before the hire date, when posted, then it is refused', async () => {
      const response = await createAs('hr.admin@acme.test', {
        ...validJoiner(),
        hireDate: '2026-09-01',
        startingPay: { amount: '70000', currency: 'GBP', effectiveFrom: '2026-08-01' },
      });

      expect(response.status).toBe(400);
      expect(errorOf(response).message).toMatch(/before the hire date/i);
    });

    it.each([
      ['no name', { fullName: '' }],
      ['an address that is not one', { email: 'not-an-address' }],
      ['a country that is not a code', { country: 'GBR' }],
      ['a hire date that is not a date', { hireDate: '2026-02-31' }],
      ['a department that is not a number', { departmentId: 'sales' }],
      [
        'an amount with three decimal places',
        { startingPay: { amount: '1.234', currency: 'USD' } },
      ],
      ['an amount with a separator', { startingPay: { amount: '70,000', currency: 'USD' } }],
      ['a currency we do not support', { startingPay: { amount: '70000', currency: 'JPY' } }],
    ])('given %s, when posted, then it is a 400 rather than a 500', async (_name, invalid) => {
      const response = await createAs('hr.admin@acme.test', { ...validJoiner(), ...invalid });

      expect(response.status).toBe(400);
      expect(errorOf(response).code).toBe('INVALID_REQUEST');
    });

    it('given a refused record, when it fails, then nothing was written', async () => {
      /* The record and the first salary are one decision. A failure between
         them would leave somebody hired with no pay and nobody aware of it. */
      const joiner = validJoiner();
      await createAs('hr.admin@acme.test', {
        ...joiner,
        startingPay: { amount: 'not-a-number', currency: 'GBP' },
      }).expect(400);

      const listed = await request(harness.app)
        .get('/api/employees')
        .query({ q: joiner.email })
        .set('Authorization', authorised('hr.admin@acme.test'));

      expect(bodyOf(listed)).toMatchObject({ total: 0 });
    });
  });

  describe('what happens next', () => {
    it('given somebody was added, when the list is read, then they are in it', async () => {
      const joiner = validJoiner();
      await createAs('hr.admin@acme.test', joiner).expect(201);

      const listed = await request(harness.app)
        .get('/api/employees')
        .query({ q: joiner.email })
        .set('Authorization', authorised('hr.admin@acme.test'));

      expect(bodyOf(listed)).toMatchObject({ total: 1 });
    });

    it('given somebody was added, when a raise is recorded for them, then it works', async () => {
      // The id in the response is real, and the record it names is complete.
      const created = await createAs('hr.admin@acme.test', {
        ...validJoiner(),
        hireDate: '2025-01-01',
      }).expect(201);
      const { id } = detailOf(created).employee;

      const raise = await request(harness.app)
        .post(`/api/employees/${String(id)}/compensation`)
        .set('Authorization', authorised('hr.admin@acme.test'))
        .send({ amount: '81000', currency: 'GBP', effectiveFrom: '2025-06-01' });

      expect(raise.status).toBe(200);
      expect(detailOf(raise).employee.salary).toMatchObject({ amountMinor: 8_100_000 });
    });
  });
});
