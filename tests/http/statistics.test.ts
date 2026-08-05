import request from 'supertest';
import { accessTokenFrom, bodyOf, errorOf } from '../helpers/http';
import { seedOrg, type SeededOrg } from '../helpers/org';
import { createTestHarness, TEST_PASSWORD, type TestHarness } from '../helpers/testApp';

/**
 * Who may see company-wide figures.
 *
 * The rule is enforced in the service rather than by a route guard, so these
 * check the behaviour rather than the wiring: a Manager must be refused, not
 * shown a version of the dashboard narrowed to their team.
 */

interface Overview {
  overall: { headcount: number; paidHeadcount: number; totalUsdMinor: number };
  byDepartment: { label: string; headcount: number }[];
  distribution: unknown[];
  asOf: string;
  minimumGroupForMedian: number;
}

describe('GET /api/stats/overview', () => {
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

  const overviewOf = (response: request.Response): Overview =>
    bodyOf(response) as unknown as Overview;

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

  describe('who may see them', () => {
    it.each(['hr.admin@acme.test', 'hr.viewer@acme.test'])(
      'given %s, when they ask, then the figures are returned',
      async (email) => {
        const response = await request(harness.app)
          .get('/api/stats/overview')
          .set('Authorization', authorised(email));

        expect(response.status).toBe(200);
        expect(overviewOf(response).overall.headcount).toBeGreaterThan(0);
      },
    );

    it.each(['manager@acme.test', 'employee@acme.test'])(
      'given %s, when they ask, then they are refused rather than shown a narrowed version',
      async (email) => {
        /* A median over three people is those three salaries with one step of
           arithmetic in front, and a company-wide-looking figure that covers
           four people is a number somebody will quote in a meeting. */
        const response = await request(harness.app)
          .get('/api/stats/overview')
          .set('Authorization', authorised(email));

        expect(response.status).toBe(403);
        expect(errorOf(response).code).toBe('FORBIDDEN');
      },
    );

    it('given no token, when the figures are asked for, then it is refused', async () => {
      const response = await request(harness.app).get('/api/stats/overview');
      expect(response.status).toBe(401);
    });
  });

  describe('what comes back', () => {
    it('given the company, when summarised, then the department totals reconcile with the whole', async () => {
      const response = await request(harness.app)
        .get('/api/stats/overview')
        .set('Authorization', authorised('hr.admin@acme.test'));

      const { overall, byDepartment } = overviewOf(response);
      expect(byDepartment.reduce((total, group) => total + group.headcount, 0)).toBe(
        overall.headcount,
      );
    });

    it('given leavers in the data, when summarised, then they are not in the payroll by default', async () => {
      const response = await request(harness.app)
        .get('/api/stats/overview')
        .set('Authorization', authorised('hr.admin@acme.test'));
      const everybody = await request(harness.app)
        .get('/api/stats/overview?status=ALL')
        .set('Authorization', authorised('hr.admin@acme.test'));

      expect(overviewOf(everybody).overall.headcount).toBeGreaterThan(
        overviewOf(response).overall.headcount,
      );
    });

    it('given a filter, when summarised, then it narrows the figures', async () => {
      const response = await request(harness.app)
        .get(`/api/stats/overview?departmentId=${String(org.engineeringId)}`)
        .set('Authorization', authorised('hr.admin@acme.test'));

      const { byDepartment } = overviewOf(response);
      expect(byDepartment).toHaveLength(1);
      expect(byDepartment[0]?.label).toBe('Engineering');
    });

    it('given a past date, when summarised, then it is reported back', async () => {
      const response = await request(harness.app)
        .get('/api/stats/overview?asOf=2025-06-01')
        .set('Authorization', authorised('hr.admin@acme.test'));

      expect(overviewOf(response).asOf).toBe('2025-06-01');
    });

    it('given a date that is not a real day, when asked for, then it is refused', async () => {
      const response = await request(harness.app)
        .get('/api/stats/overview?asOf=2026-02-31')
        .set('Authorization', authorised('hr.admin@acme.test'));

      expect(response.status).toBe(400);
    });

    it('given the figures, when returned, then nothing in between may cache them', async () => {
      /* Salary figures, and the same URL answers differently per role. A shared
         cache would be one misconfiguration away from serving them to the
         wrong person. */
      const response = await request(harness.app)
        .get('/api/stats/overview')
        .set('Authorization', authorised('hr.admin@acme.test'));

      expect(response.headers['cache-control']).toBe('no-store');
    });
  });
});
