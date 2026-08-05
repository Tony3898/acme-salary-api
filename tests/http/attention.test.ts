import request from 'supertest';
import { bandStanding } from '../../src/domain/payBand';
import { bodyOf } from '../helpers/http';
import { ORG_BANDS, seedOrg, type SeededOrg } from '../helpers/org';
import { createTestHarness, type TestHarness } from '../helpers/testApp';
import { signInEveryone, type Signins } from '../helpers/tokens';

/**
 * Who is paid below their band, dearest first.
 *
 * The test that matters most is the last one: the SQL predicate that filters
 * thousands of rows and the pure function that classifies one row are two
 * expressions of the same rule, and this holds them against each other over every
 * seeded person. Without it the two could drift and a person would read as
 * under-banded on one screen and fine on the next.
 */

interface AttentionRow {
  employee: {
    id: number;
    fullName: string;
    country: string;
    status: string;
    salary: { amountMinor: number; currency: string } | null;
    band: {
      fit: string;
      shortfallMinor: number;
      band: { currency: string; minMinor: number; maxMinor: number } | null;
    };
  };
  shortfallUsdMinor: number;
}

interface AttentionPage {
  rows: AttentionRow[];
  total: number;
  totalPages: number;
  totalShortfallUsdMinor: number;
  asOf: string;
}

/** Worked out from ORG_BANDS by hand, so a mistake in the query cannot agree with itself. */
const FILLER_COUNT = 30;
const FILLER_SHORTFALL_USD = 500_000; // $5,000.00: band min 9,500,000 against pay of 9,000,000
const DEEPEST_SHORTFALL_USD = 1_204_000; // 100,000,000 paise at 0.01204
const REPORT_SHORTFALL_USD = 1_270_000; // 1,000,000 pence at 1.27

describe('GET /api/employees/attention', () => {
  let harness: TestHarness;
  let org: SeededOrg;
  let signins: Signins;

  const pageOf = (response: request.Response): AttentionPage =>
    bodyOf(response) as unknown as AttentionPage;

  beforeAll(async () => {
    harness = await createTestHarness();
    const managerEmployeeId = harness.accounts.manager.employeeId;
    if (managerEmployeeId === null) {
      throw new Error('The manager account must be linked to an employee.');
    }
    org = await seedOrg(harness.db, managerEmployeeId);
    signins = await signInEveryone(harness);
  });

  afterAll(async () => {
    await harness.close();
  });

  const listAs = (email: Parameters<Signins['as']>[0], query = '') =>
    request(harness.app)
      .get(`/api/employees/attention${query}`)
      .set('Authorization', signins.as(email));

  describe('who is on the list', () => {
    it('given HR Admin, when they ask, then everybody below their band is counted', async () => {
      const response = await listAs('hr.admin@acme.test', '?pageSize=100');

      expect(response.status).toBe(200);
      // Thirty fillers, the deepest report, and the manager's own report.
      expect(pageOf(response).total).toBe(FILLER_COUNT + 2);
    });

    it('given somebody below their band who has left, when the list is built, then they are not on it', async () => {
      /* Nothing to do about a leaver's pay. Including them would make the
         cost-to-fix total money nobody is going to spend. */
      const response = await listAs('hr.admin@acme.test', '?pageSize=100');
      const ids = pageOf(response).rows.map((row) => row.employee.id);

      expect(ids).not.toContain(org.outside.leaver);
    });

    it('given somebody with no salary recorded, when the list is built, then they are not on it', async () => {
      const response = await listAs('hr.admin@acme.test', '?pageSize=100');
      const ids = pageOf(response).rows.map((row) => row.employee.id);

      expect(ids).not.toContain(org.outside.noPay);
    });

    it('given somebody paid inside their band, when the list is built, then they are not on it', async () => {
      const response = await listAs('hr.admin@acme.test', '?pageSize=100');
      const ids = pageOf(response).rows.map((row) => row.employee.id);

      expect(ids).not.toContain(org.chain.deep);
      expect(ids).not.toContain(org.outside.lead);
    });
  });

  describe('the order, and the cost', () => {
    it('given people short in different currencies, when ordered, then the dearest to fix comes first', async () => {
      /* The one place a converted figure is right: "fix the expensive ones first"
         has to weigh a rupee gap against a sterling one. A pound is worth more than
         a rupee, so the GBP shortfall leads even though the rupee figure is a much
         larger number. */
      const response = await listAs('hr.admin@acme.test', '?pageSize=100');
      const rows = pageOf(response).rows;

      expect(rows[0]?.employee.id).toBe(org.chain.report);
      expect(rows[0]?.shortfallUsdMinor).toBe(REPORT_SHORTFALL_USD);
      expect(rows[1]?.employee.id).toBe(org.chain.deepest);
      expect(rows[1]?.shortfallUsdMinor).toBe(DEEPEST_SHORTFALL_USD);
    });

    it('given a shortfall, when reported, then the local figure is the local one and only the ordering is converted', async () => {
      const response = await listAs('hr.admin@acme.test', '?pageSize=100');
      const deepest = pageOf(response).rows.find((row) => row.employee.id === org.chain.deepest);

      // 100,000,000 paise short, reported in paise.
      expect(deepest?.employee.band.shortfallMinor).toBe(100_000_000);
      expect(deepest?.employee.band.band?.currency).toBe('INR');
      expect(deepest?.employee.salary?.currency).toBe('INR');
    });

    it('given the whole filtered set, when totalled, then the cost covers everybody rather than the page', async () => {
      /* A footer that totals only what is on screen answers a question nobody
         asked. Twenty-five rows on the page, thirty-two people in the total. */
      const response = await listAs('hr.admin@acme.test', '?pageSize=25');
      const page = pageOf(response);

      expect(page.rows).toHaveLength(25);
      expect(page.total).toBe(FILLER_COUNT + 2);
      expect(page.totalShortfallUsdMinor).toBe(
        FILLER_COUNT * FILLER_SHORTFALL_USD + DEEPEST_SHORTFALL_USD + REPORT_SHORTFALL_USD,
      );
    });

    it('given a page past the end, when asked for, then the total is still right so the pager can get back', async () => {
      const response = await listAs('hr.admin@acme.test', '?page=99&pageSize=25');
      const page = pageOf(response);

      expect(page.rows).toEqual([]);
      expect(page.total).toBe(FILLER_COUNT + 2);
      expect(page.totalShortfallUsdMinor).toBeGreaterThan(0);
    });

    it('given a filter that matches nobody short, when asked for, then the total is genuinely zero', async () => {
      const response = await listAs(
        'hr.admin@acme.test',
        `?departmentId=${String(org.engineeringId)}&country=US`,
      );
      const page = pageOf(response);

      expect(page.total).toBe(0);
      expect(page.totalShortfallUsdMinor).toBe(0);
      expect(page.totalPages).toBe(0);
    });
  });

  describe('what each role sees', () => {
    it('given a Manager, when they ask, then they get their own team and nobody else', async () => {
      const response = await listAs('manager@acme.test', '?pageSize=100');
      const ids = pageOf(response).rows.map((row) => row.employee.id);

      expect(response.status).toBe(200);
      expect(ids).toContain(org.chain.report);
      expect(ids).toContain(org.chain.deepest);
      expect(ids).not.toContain(org.filler[0]);
    });

    it('given a Manager, when they ask, then the cost totals only their own team', async () => {
      /* The one aggregate on this screen is computed inside the same scoped query,
         so it cannot total people the caller cannot see. */
      const response = await listAs('manager@acme.test', '?pageSize=100');

      expect(pageOf(response).totalShortfallUsdMinor).toBe(
        REPORT_SHORTFALL_USD + DEEPEST_SHORTFALL_USD,
      );
    });

    it('given an Employee, when they ask, then they see only themselves', async () => {
      const response = await listAs('employee@acme.test', '?pageSize=100');
      const rows = pageOf(response).rows;

      expect(rows).toHaveLength(1);
      expect(rows[0]?.employee.id).toBe(org.chain.report);
    });

    it('given no token, when the list is asked for, then it is refused', async () => {
      const response = await request(harness.app).get('/api/employees/attention');

      expect(response.status).toBe(401);
    });
  });

  describe('the query and the pure function agree', () => {
    it('given every seeded employee, when compared both ways, then the SQL predicate and bandStanding pick the same people', async () => {
      /**
       * The drift test.
       *
       * `BELOW_BAND_CONDITION` filters in SQL because thousands of rows cannot be
       * filtered in Node; `bandStanding` classifies one row because the comparison
       * belongs in the domain. Two expressions of one rule is exactly the shape that
       * quietly diverges, so this walks the whole company through both.
       */
      const everybody = await request(harness.app)
        .get('/api/employees?pageSize=100&status=ACTIVE')
        .set('Authorization', signins.as('hr.admin@acme.test'));

      const rows = (bodyOf(everybody) as unknown as { rows: AttentionRow['employee'][] }).rows;

      const belowByDomain = rows
        .filter(
          (employee) =>
            bandStanding(
              employee.salary === null
                ? null
                : {
                    amountMinor: employee.salary.amountMinor,
                    currency: employee.salary.currency as 'USD',
                  },
              employee.band.band === null
                ? null
                : {
                    currency: employee.band.band.currency as 'USD',
                    minMinor: employee.band.band.minMinor,
                    midMinor: employee.band.band.minMinor,
                    maxMinor: employee.band.band.maxMinor,
                  },
            ).fit === 'BELOW',
        )
        .map((employee) => employee.id)
        .sort((left, right) => left - right);

      const attention = await listAs('hr.admin@acme.test', '?pageSize=100');
      const belowBySql = pageOf(attention)
        .rows.map((row) => row.employee.id)
        .sort((left, right) => left - right);

      expect(belowBySql).toEqual(belowByDomain);
      expect(belowBySql.length).toBeGreaterThan(0);
    });

    it('given a band in a currency the person is not paid in, when compared, then they are on neither list', () => {
      /* A dollar salary against a sterling band is not "below" it — it is not
         comparable, and converting to decide would be measuring the exchange rate.
         Both the query and the domain function refuse it, which is what keeps the
         two lists identical. */
      const gbJuniorBand = ORG_BANDS.gbJunior;
      const standing = bandStanding(
        { amountMinor: gbJuniorBand.minMinor - 1, currency: 'USD' },
        { currency: 'GBP', ...gbJuniorBand },
      );

      expect(standing.fit).toBe('OTHER_CURRENCY');
    });
  });
});
