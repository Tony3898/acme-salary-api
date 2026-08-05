import request from 'supertest';
import { compensationRecords, employees } from '../../src/db/schema';
import { accessTokenFrom, bodyOf } from '../helpers/http';
import { seedOrg, type SeededOrg } from '../helpers/org';
import { createTestHarness, TEST_PASSWORD, type TestHarness } from '../helpers/testApp';

/**
 * Payroll month by month, and what is already committed beyond today.
 *
 * The forecast half is the part worth pinning: it is not a projection, it is the
 * same arithmetic applied to pay changes that have already been signed off and
 * carry a future date. A promotion agreed in August that starts in October is a
 * cost the company has taken on, and every other screen hides it.
 */

interface Point {
  month: string;
  payrollUsdMinor: number;
  paidHeadcount: number;
  kind: 'ACTUAL' | 'COMMITTED';
}

interface Trend {
  asOf: string;
  months: Point[];
  committedChangeUsdMinor: number;
}

describe('GET /api/stats/payroll-trend', () => {
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

  const trendOf = (response: request.Response): Trend => bodyOf(response) as unknown as Trend;

  const monthOf = (trend: Trend, month: string): Point => {
    const found = trend.months.find((point) => point.month === month);
    if (found === undefined) {
      throw new Error(`No point for ${month} in ${trend.months.map((p) => p.month).join(', ')}`);
    }
    return found;
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

  const trendAs = (email: string, query: Record<string, string | number> = {}) =>
    request(harness.app)
      .get('/api/stats/payroll-trend')
      .query(query)
      .set('Authorization', authorised(email));

  describe('who may see it', () => {
    it('given HR Admin, when they ask, then they get the trend', async () => {
      const response = await trendAs('hr.admin@acme.test');

      expect(response.status).toBe(200);
      expect(trendOf(response).months.length).toBeGreaterThan(0);
    });

    it('given HR Viewer, when they ask, then they get it too', async () => {
      // Read-only, and this is reading.
      await trendAs('hr.viewer@acme.test').expect(200);
    });

    it('given a Manager, when they ask, then it is refused rather than narrowed', async () => {
      /* A payroll total over three people is those three salaries with one step
         of arithmetic in front. */
      await trendAs('manager@acme.test').expect(403);
    });

    it('given no token, when asked, then it is refused', async () => {
      await request(harness.app).get('/api/stats/payroll-trend').expect(401);
    });
  });

  describe('the shape of the answer', () => {
    it('given a window, when asked, then it runs from history to horizon inclusive', async () => {
      const response = await trendAs('hr.admin@acme.test', {
        asOf: '2026-06-15',
        historyMonths: 3,
        horizonMonths: 2,
      });

      const trend = trendOf(response);
      // Three back, this month, two forward.
      expect(trend.months).toHaveLength(6);
      expect(trend.months[0]?.month).toBe('2026-03-01');
      expect(trend.months.at(-1)?.month).toBe('2026-08-01');
    });

    it('given the month being asked about, when returned, then it counts as actual', async () => {
      const trend = trendOf(
        await trendAs('hr.admin@acme.test', { asOf: '2026-06-15', historyMonths: 1, horizonMonths: 1 }),
      );

      expect(monthOf(trend, '2026-06-01').kind).toBe('ACTUAL');
      expect(monthOf(trend, '2026-07-01').kind).toBe('COMMITTED');
    });

    it('given an absurd window, when asked, then it is clamped rather than refused', async () => {
      const trend = trendOf(
        await trendAs('hr.admin@acme.test', { historyMonths: 5000, horizonMonths: 5000 }),
      );

      // 36 back + this month + 24 forward.
      expect(trend.months).toHaveLength(61);
    });
  });

  describe('what the figures mean', () => {
    /** Somebody hired mid-window, with a raise that has not started yet. */
    let joiner: number;

    beforeAll(async () => {
      const [created] = await harness.db
        .insert(employees)
        .values({
          fullName: 'Trend Subject',
          email: 'trend.subject@acme.test',
          country: 'US',
          departmentId: org.salesId,
          jobLevelId: org.juniorLevelId,
          hireDate: '2026-03-10',
        })
        .returning({ id: employees.id });

      if (created === undefined) {
        throw new Error('Failed to create the trend subject.');
      }
      joiner = created.id;

      await harness.db.insert(compensationRecords).values([
        {
          employeeId: joiner,
          amountMinor: 10_000_000,
          currency: 'USD',
          effectiveFrom: '2026-03-10',
          reason: 'Hired',
        },
        {
          employeeId: joiner,
          amountMinor: 12_000_000,
          currency: 'USD',
          effectiveFrom: '2026-10-01',
          reason: 'Promotion, signed off',
        },
      ]);
    });

    const payrollFor = async (month: string): Promise<number> => {
      const trend = trendOf(
        await trendAs('hr.admin@acme.test', {
          asOf: '2026-08-05',
          historyMonths: 12,
          horizonMonths: 6,
        }),
      );
      return monthOf(trend, month).payrollUsdMinor;
    };

    it('given somebody was hired mid-window, when the months are drawn, then they start in their hire month', async () => {
      /* A record dated in March must not appear in February. Counting them from
         the start of the window would make every earlier month too expensive. */
      const before = await payrollFor('2026-02-01');
      const after = await payrollFor('2026-04-01');

      expect(after - before).toBe(10_000_000);
    });

    it('given a raise signed off for a future month, when the horizon is drawn, then it appears there and not before', async () => {
      const september = await payrollFor('2026-09-01');
      const october = await payrollFor('2026-10-01');

      expect(october - september).toBe(2_000_000);
    });

    it('given changes already signed off, when asked, then the committed change is reported', async () => {
      const trend = trendOf(
        await trendAs('hr.admin@acme.test', {
          asOf: '2026-08-05',
          historyMonths: 12,
          horizonMonths: 6,
        }),
      );

      /* The number worth acting on: money already promised, and the one figure
         on the dashboard that appears nowhere else in the product. */
      expect(trend.committedChangeUsdMinor).toBe(
        monthOf(trend, '2027-02-01').payrollUsdMinor - monthOf(trend, '2026-08-01').payrollUsdMinor,
      );
      expect(trend.committedChangeUsdMinor).toBeGreaterThanOrEqual(2_000_000);
    });

    it('given no horizon asked for, when returned, then it is history alone with nothing committed', async () => {
      /* A fair thing to ask for, so zero is allowed rather than refused — and
         with no month beyond today there is no commitment to report. */
      const trend = trendOf(
        await trendAs('hr.admin@acme.test', { asOf: '2026-08-05', horizonMonths: 0 }),
      );

      expect(trend.months.at(-1)).toMatchObject({ month: '2026-08-01', kind: 'ACTUAL' });
      expect(trend.committedChangeUsdMinor).toBe(0);
    });

    it('given a month, when its headcount is reported, then it counts people with pay in force', async () => {
      const trend = trendOf(
        await trendAs('hr.admin@acme.test', { asOf: '2026-08-05', historyMonths: 1, horizonMonths: 1 }),
      );

      const august = monthOf(trend, '2026-08-01');
      expect(august.paidHeadcount).toBeGreaterThan(0);
      expect(august.payrollUsdMinor).toBeGreaterThan(0);
    });
  });
});
