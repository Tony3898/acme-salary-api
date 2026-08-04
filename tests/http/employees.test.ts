import request from 'supertest';
import { accessTokenFrom, bodyOf, errorOf } from '../helpers/http';
import { seedOrg, type SeededOrg } from '../helpers/org';
import { createTestHarness, TEST_PASSWORD, type TestHarness } from '../helpers/testApp';

/**
 * The employee list: who may see whom, and whether a page of it can be trusted.
 *
 * Read through HTTP rather than by calling the repository, because the scope has
 * to hold on the route people actually use — and because a filter that is applied
 * in the service but forgotten in the count is only visible from out here.
 */

interface ListedEmployee {
  id: number;
  fullName: string;
  email: string;
  country: string;
  status: string;
  salary: { amountMinor: number; currency: string; amountUsdMinor: number } | null;
}

interface ListPage {
  rows: ListedEmployee[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  asOf: string;
}

describe('GET /api/employees', () => {
  let harness: TestHarness;
  let org: SeededOrg;
  const tokens = new Map<string, string>();

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

  const list = (as: string, query: Record<string, string | number> = {}) =>
    request(harness.app)
      .get('/api/employees')
      .query(query)
      .set('Authorization', `Bearer ${tokens.get(as) ?? ''}`);

  const pageOf = (response: request.Response): ListPage => bodyOf(response) as unknown as ListPage;

  const allRowsFor = async (as: string, query: Record<string, string | number> = {}) => {
    const rows: ListedEmployee[] = [];
    const first = pageOf(await list(as, { ...query, page: 1, pageSize: 25 }).expect(200));
    rows.push(...first.rows);

    for (let page = 2; page <= first.totalPages; page += 1) {
      const body = pageOf(await list(as, { ...query, page, pageSize: 25 }).expect(200));
      rows.push(...body.rows);
    }

    return rows;
  };

  describe('who can see whom', () => {
    it('given an HR Admin, when listing, then everybody is included', async () => {
      const body = pageOf(await list('hr.admin@acme.test').expect(200));

      expect(body.total).toBe(org.totalEmployees);
    });

    it('given an HR Viewer, when listing, then they see the same as an HR Admin', async () => {
      // Read-only is a route concern; it does not narrow who is visible.
      const admin = pageOf(await list('hr.admin@acme.test').expect(200));
      const viewer = pageOf(await list('hr.viewer@acme.test').expect(200));

      expect(viewer.total).toBe(admin.total);
    });

    it('given a Manager, when listing, then it is exactly their reporting chain and themselves', async () => {
      /* Three levels down, not just direct reports — a manager is accountable for
         everybody beneath them, which is what the recursive walk is for. */
      const rows = await allRowsFor('manager@acme.test');

      expect(rows.map((row) => row.id).sort((a, b) => a - b)).toEqual(
        [org.chain.manager, org.chain.report, org.chain.deep, org.chain.deepest].sort(
          (a, b) => a - b,
        ),
      );
    });

    it('given a Manager, when they page through, then the total counts only their team', async () => {
      /* The count comes from the same query as the rows. If the scope were applied
         to one and not the other, the footer would disclose the company headcount
         to somebody who cannot see a single one of those people. */
      const body = pageOf(await list('manager@acme.test').expect(200));

      expect(body.total).toBe(4);
      expect(body.total).toBeLessThan(org.totalEmployees);
    });

    it('given an Employee, when listing, then they see exactly their own record', async () => {
      const body = pageOf(await list('employee@acme.test').expect(200));

      expect(body.total).toBe(1);
      expect(body.rows[0]?.id).toBe(harness.accounts.employee.employeeId);
    });

    it('given a Manager filtering to somebody outside their team, when listing, then the result is empty', async () => {
      /* The scope is a condition on the query, so a filter cannot widen it. This is
         the case a route-level check would pass and a data-level one catches. */
      const body = pageOf(
        await list('manager@acme.test', { departmentId: org.salesId }).expect(200),
      );

      expect(body.rows).toEqual([]);
      expect(body.total).toBe(0);
    });

    it('given no token, when listing, then it is refused', async () => {
      const response = await request(harness.app).get('/api/employees');

      expect(response.status).toBe(401);
      expect(errorOf(response)).toMatchObject({ code: 'UNAUTHENTICATED' });
    });
  });

  describe('paging', () => {
    it('given every page is walked in salary order, then each person appears exactly once', async () => {
      /* Thirty people share one salary here. Without `id` as the final sort key the
         database may order those thirty differently per request, so page 2 repeats
         some of page 1 and skips others — and nothing looks broken. */
      const rows = await allRowsFor('hr.admin@acme.test', { sortBy: 'salary', sortDir: 'asc' });
      const ids = rows.map((row) => row.id);

      expect(ids).toHaveLength(org.totalEmployees);
      expect(new Set(ids).size).toBe(org.totalEmployees);
    });

    it('given a page past the end, when requested, then it is empty but the total still holds', async () => {
      const body = pageOf(await list('hr.admin@acme.test', { page: 99 }).expect(200));

      expect(body.rows).toEqual([]);
      expect(body.total).toBe(org.totalEmployees);
    });

    it('given filters that match nobody, when listing, then the total is zero rather than missing', async () => {
      /* The window function producing the total returns no rows when nothing
         matches, so it has to be defaulted — otherwise the pager renders NaN. */
      const body = pageOf(
        await list('hr.admin@acme.test', { q: 'nobody-with-this-name' }).expect(200),
      );

      expect(body.total).toBe(0);
      expect(body.totalPages).toBe(0);
    });

    it.each([
      ['a page size that is not offered', { pageSize: 30 }],
      ['a page size beyond the maximum', { pageSize: 5000 }],
      ['page zero', { page: 0 }],
      ['a negative page', { page: -1 }],
      ['an unknown sort column', { sortBy: 'passwordHash' }],
      ['an unknown sort direction', { sortDir: 'sideways' }],
      ['a status that is not a status', { status: 'MAYBE' }],
      ['a country that is not a code', { country: 'United Kingdom' }],
      ['a date that is not a date', { asOf: 'last-tuesday' }],
      ['a date that does not exist', { asOf: '2026-02-31' }],
    ])('given %s, when listing, then it is refused', async (_label, query) => {
      const response = await list('hr.admin@acme.test', query);

      expect(response.status).toBe(400);
      expect(errorOf(response)).toMatchObject({ code: 'INVALID_REQUEST' });
    });

    it.each([25, 50, 100])('given a page size of %s, when listing, then it is accepted', async (pageSize) => {
      await list('hr.admin@acme.test', { pageSize }).expect(200);
    });
  });

  describe('sorting and money', () => {
    it('given salaries in different currencies, when sorting by salary, then the converted amount decides', async () => {
      /* ₹5,000,000 is 500,000,000 in minor units — a far bigger number than
         $150,000, and a far smaller salary. Sorting on the raw amount would put the
         lowest-paid person at the top. */
      const rows = await allRowsFor('hr.admin@acme.test', { sortBy: 'salary', sortDir: 'desc' });
      const withPay = rows.filter((row) => row.salary !== null);

      /* The best paid is the manager on GBP 120,000 — $152,400 — not the Outside
         Lead on $150,000. Worth stating: it is only true after conversion. */
      expect(withPay[0]?.id).toBe(org.chain.manager);
      expect(withPay[1]?.id).toBe(org.outside.lead);
      expect(withPay.at(-1)?.id).toBe(org.chain.deepest);

      const usdAmounts = withPay.map((row) => row.salary?.amountUsdMinor ?? 0);
      expect([...usdAmounts].sort((a, b) => b - a)).toEqual(usdAmounts);
    });

    it('given a salary in rupees, when converted, then the local amount is kept alongside the USD one', async () => {
      // 500,000,000 paise at 0.01204 is 6,020,000 US cents.
      const rows = await allRowsFor('hr.admin@acme.test');
      const deepest = rows.find((row) => row.id === org.chain.deepest);

      expect(deepest?.salary).toEqual({
        amountMinor: 500_000_000,
        currency: 'INR',
        amountUsdMinor: 6_020_000,
        effectiveFrom: '2024-01-01',
      });
    });

    it('given somebody with no pay recorded, when listing, then they appear with no salary rather than disappearing', async () => {
      /* An inner join here would drop a new joiner from the list *and* from the
         total, so the headcount would quietly be wrong. */
      const rows = await allRowsFor('hr.admin@acme.test');

      expect(rows.find((row) => row.id === org.outside.noPay)?.salary).toBeNull();
    });

    it('given people with no pay, when sorting by salary, then they sort last in both directions', async () => {
      const ascending = await allRowsFor('hr.admin@acme.test', { sortBy: 'salary', sortDir: 'asc' });
      const descending = await allRowsFor('hr.admin@acme.test', {
        sortBy: 'salary',
        sortDir: 'desc',
      });

      expect(ascending.at(-1)?.id).toBe(org.outside.noPay);
      expect(descending.at(-1)?.id).toBe(org.outside.noPay);
    });
  });

  describe('as of a date', () => {
    it('given no date, when listing, then salaries are as they stand today', async () => {
      const rows = await allRowsFor('hr.admin@acme.test');

      expect(rows.find((row) => row.id === org.chain.manager)?.salary?.amountMinor).toBe(12_000_000);
    });

    it('given a date before a raise, when listing, then the earlier salary is reported', async () => {
      const rows = await allRowsFor('hr.admin@acme.test', { asOf: '2025-06-30' });

      expect(rows.find((row) => row.id === org.chain.manager)?.salary?.amountMinor).toBe(10_000_000);
    });

    it('given a raise that has not started yet, when listing today, then it is not counted', async () => {
      // Signed off in December, not payable in August.
      const rows = await allRowsFor('hr.admin@acme.test');

      expect(rows.find((row) => row.id === org.chain.deep)?.salary?.amountMinor).toBe(10_000_000);
    });

    it('given a date before anybody was paid, when listing, then everyone appears with no salary', async () => {
      const rows = await allRowsFor('hr.admin@acme.test', { asOf: '2020-01-01' });

      expect(rows).toHaveLength(org.totalEmployees);
      expect(rows.every((row) => row.salary === null)).toBe(true);
    });
  });

  describe('search and filters', () => {
    it('given a search for a percent sign, when listing, then it matches the text and not everything', async () => {
      /* Unescaped, this pattern becomes `%%%` and matches every row in the table.
         Escaped, it matches the one person whose name contains the character. The
         injection-shaped case for a value that *is* parameterised: the danger here
         is not SQL, it is the pattern language inside the parameter. */
      const rows = await allRowsFor('hr.admin@acme.test', { q: '%' });

      expect(rows).toHaveLength(1);
      expect(rows[0]?.fullName).toBe('Fifty% Percent');
    });

    it('given a search containing an underscore, when listing, then it is a literal underscore', async () => {
      const rows = await allRowsFor('hr.admin@acme.test', { q: 'Filler_Number' });

      expect(rows).toEqual([]);
    });

    it('given SQL in the search box, when listing, then it is treated as text', async () => {
      const rows = await allRowsFor('hr.admin@acme.test', { q: "'; DROP TABLE employees; --" });

      expect(rows).toEqual([]);
      // Still there.
      expect(pageOf(await list('hr.admin@acme.test').expect(200)).total).toBe(org.totalEmployees);
    });

    it('given a search by email, when listing, then it matches', async () => {
      const rows = await allRowsFor('hr.admin@acme.test', { q: 'deepest@acme' });

      expect(rows.map((row) => row.id)).toEqual([org.chain.deepest]);
    });

    it('given a country filter in lower case, when listing, then it matches the stored code', async () => {
      const rows = await allRowsFor('hr.admin@acme.test', { country: 'in' });

      expect(rows.map((row) => row.id)).toEqual([org.chain.deepest]);
    });

    it('given a status filter, when listing, then only people with that status are returned', async () => {
      const left = await allRowsFor('hr.admin@acme.test', { status: 'LEFT' });

      expect(left.map((row) => row.id)).toEqual([org.outside.leaver]);
    });

    it('given a department filter, when listing, then the total reflects the filter', async () => {
      const body = pageOf(
        await list('hr.admin@acme.test', { departmentId: org.engineeringId }).expect(200),
      );

      // The manager, their report, and the two below them.
      expect(body.total).toBe(4);
    });

    it('given a job level filter, when listing, then only that level is returned', async () => {
      const rows = await allRowsFor('hr.admin@acme.test', { jobLevelId: org.seniorLevelId });

      expect(rows.every((row) => row.id !== org.chain.deepest)).toBe(true);
      expect(rows.length).toBeGreaterThan(0);
    });
  });
});
