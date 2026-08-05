import request from 'supertest';
import { accessTokenFrom, bodyOf, errorOf } from '../helpers/http';
import { seedOrg, type SeededOrg } from '../helpers/org';
import { createTestHarness, TEST_PASSWORD, type TestHarness } from '../helpers/testApp';

/**
 * One person's record and their pay history.
 *
 * The scope questions matter more here than on the list. A list quietly omits
 * what you may not see; a detail page is a direct request for one named person,
 * and the way it refuses is itself a disclosure.
 */

interface HistoryEntry {
  id: number;
  amountMinor: number;
  currency: string;
  amountUsdMinor: number;
  effectiveFrom: string;
  reason: string | null;
  recordedByEmail: string | null;
  change: { amountMinor: number | null; percentage: number | null; reason: string | null };
  isCurrent: boolean;
  isScheduled: boolean;
}

interface Detail {
  employee: {
    id: number;
    fullName: string;
    hireDate: string;
    salary: { amountMinor: number; currency: string } | null;
  };
  directReports: number;
  history: HistoryEntry[];
  asOf: string;
}

describe('GET /api/employees/:id', () => {
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

  beforeAll(async () => {
    harness = await createTestHarness();
    const managerEmployeeId = harness.accounts.manager.employeeId;
    if (managerEmployeeId === null) {
      throw new Error('The manager account must be linked to an employee.');
    }
    org = await seedOrg(harness.db, managerEmployeeId);

    for (const email of [
      'hr.admin@acme.test',
      'hr.viewer@acme.test',
      'manager@acme.test',
      'employee@acme.test',
    ]) {
      const login = await request(harness.app)
        .post('/api/auth/login')
        .send({ email, password: TEST_PASSWORD });
      tokens.set(email, accessTokenFrom(login));
    }
  });

  afterAll(async () => {
    await harness.close();
  });

  describe('who may open whose record', () => {
    it('given HR, when they open anybody, then the record is returned', async () => {
      const response = await request(harness.app)
        .get(`/api/employees/${String(org.outside.lead)}`)
        .set('Authorization', authorised('hr.admin@acme.test'));

      expect(response.status).toBe(200);
      expect(detailOf(response).employee.fullName).toBe('Outside Lead');
    });

    it('given a Manager, when they open somebody below them, then it is allowed', async () => {
      /* Two levels down, not just a direct report: the scope walks the whole
         reporting chain, and stopping at the first level would be a subtler bug
         than refusing outright. */
      const response = await request(harness.app)
        .get(`/api/employees/${String(org.chain.deepest)}`)
        .set('Authorization', authorised('manager@acme.test'));

      expect(response.status).toBe(200);
      expect(detailOf(response).employee.fullName).toBe('Deepest Report');
    });

    it('given a Manager, when they open somebody outside their team, then it is a 404 rather than a 403', async () => {
      /* A 403 confirms the record exists. Walking the ids with a 403/404
         distinction maps the whole company from an account that can see 84
         people. Both answers have to be identical. */
      const response = await request(harness.app)
        .get(`/api/employees/${String(org.outside.lead)}`)
        .set('Authorization', authorised('manager@acme.test'));

      expect(response.status).toBe(404);
      expect(errorOf(response).message).toBe('No such employee.');
    });

    it('given an id that does not exist, when anybody asks, then it answers exactly as if it were forbidden', async () => {
      const missing = await request(harness.app)
        .get('/api/employees/999999')
        .set('Authorization', authorised('manager@acme.test'));
      const forbidden = await request(harness.app)
        .get(`/api/employees/${String(org.outside.lead)}`)
        .set('Authorization', authorised('manager@acme.test'));

      expect(missing.status).toBe(forbidden.status);
      expect(errorOf(missing)).toEqual(errorOf(forbidden));
    });

    it('given an Employee, when they open their own record, then it is allowed', async () => {
      const response = await request(harness.app)
        .get(`/api/employees/${String(org.chain.report)}`)
        .set('Authorization', authorised('employee@acme.test'));

      expect(response.status).toBe(200);
    });

    it('given an Employee, when they open their manager, then it is refused', async () => {
      const response = await request(harness.app)
        .get(`/api/employees/${String(org.chain.manager)}`)
        .set('Authorization', authorised('employee@acme.test'));

      expect(response.status).toBe(404);
    });

    it('given no token, when a record is opened, then it is refused', async () => {
      const response = await request(harness.app).get(
        `/api/employees/${String(org.chain.manager)}`,
      );
      expect(response.status).toBe(401);
    });

    it('given an id that is not a number, when it is opened, then it is a bad request', async () => {
      // Refused at the boundary, rather than reaching Postgres as a failed cast.
      const response = await request(harness.app)
        .get('/api/employees/abc')
        .set('Authorization', authorised('hr.admin@acme.test'));

      expect(response.status).toBe(400);
    });
  });

  describe('the pay history', () => {
    it('given somebody with several salaries, when opened, then all of them are listed oldest first', async () => {
      const response = await request(harness.app)
        .get(`/api/employees/${String(org.chain.manager)}`)
        .set('Authorization', authorised('hr.admin@acme.test'));

      const { history } = detailOf(response);
      expect(history.map((entry) => entry.effectiveFrom)).toEqual(['2024-01-01', '2026-01-01']);
    });

    it('given a raise, when listed, then the change from the record before it is given', async () => {
      const response = await request(harness.app)
        .get(`/api/employees/${String(org.chain.manager)}`)
        .set('Authorization', authorised('hr.admin@acme.test'));

      // £100,000 to £120,000.
      expect(detailOf(response).history[1]?.change).toEqual({
        amountMinor: 2_000_000,
        percentage: 20,
        reason: null,
      });
    });

    it('given a raise that has not started, when listed, then it is shown and marked as scheduled', async () => {
      /* Hiding it until it starts is how the same raise gets awarded twice. It
         must be visible, and it must not be the current salary. */
      const response = await request(harness.app)
        .get(`/api/employees/${String(org.chain.deep)}`)
        .set('Authorization', authorised('hr.admin@acme.test'));

      const { history, employee } = detailOf(response);
      const future = history.find((entry) => entry.effectiveFrom === '2026-12-01');

      expect(future?.isScheduled).toBe(true);
      expect(future?.isCurrent).toBe(false);
      expect(employee.salary?.amountMinor).toBe(10_000_000);
    });

    it('given a history, when listed, then exactly one record is current', async () => {
      const response = await request(harness.app)
        .get(`/api/employees/${String(org.chain.deep)}`)
        .set('Authorization', authorised('hr.admin@acme.test'));

      expect(detailOf(response).history.filter((entry) => entry.isCurrent)).toHaveLength(1);
    });

    it('given a past date, when asked for, then the salary of that day is the current one', async () => {
      /* Free, given that pay is stored as dated records. It is also the clearest
         proof that the history is real rather than decorative. */
      const response = await request(harness.app)
        .get(`/api/employees/${String(org.chain.manager)}?asOf=2025-06-01`)
        .set('Authorization', authorised('hr.admin@acme.test'));

      const detail = detailOf(response);
      expect(detail.employee.salary?.amountMinor).toBe(10_000_000);
      expect(detail.history.find((entry) => entry.isCurrent)?.effectiveFrom).toBe('2024-01-01');
      expect(detail.asOf).toBe('2025-06-01');
    });

    it('given somebody never paid, when opened, then they have a record and no history', async () => {
      const response = await request(harness.app)
        .get(`/api/employees/${String(org.outside.noPay)}`)
        .set('Authorization', authorised('hr.admin@acme.test'));

      expect(response.status).toBe(200);
      expect(detailOf(response).employee.salary).toBeNull();
      expect(detailOf(response).history).toEqual([]);
    });

    it('given a date that is not a real day, when asked for, then it is refused', async () => {
      const response = await request(harness.app)
        .get(`/api/employees/${String(org.chain.manager)}?asOf=2026-02-31`)
        .set('Authorization', authorised('hr.admin@acme.test'));

      expect(response.status).toBe(400);
    });
  });

  describe('the rest of the record', () => {
    it('given a manager, when opened, then their direct reports are counted', async () => {
      const response = await request(harness.app)
        .get(`/api/employees/${String(org.outside.lead)}`)
        .set('Authorization', authorised('hr.admin@acme.test'));

      // The leaver, the unpaid joiner and every filler row report to this person.
      expect(detailOf(response).directReports).toBeGreaterThan(1);
    });

    it('given anybody, when opened, then no password hash comes with them', async () => {
      const response = await request(harness.app)
        .get(`/api/employees/${String(org.chain.manager)}`)
        .set('Authorization', authorised('hr.admin@acme.test'));

      expect(JSON.stringify(response.body)).not.toMatch(/argon2|passwordHash|password_hash/i);
    });
  });
});
