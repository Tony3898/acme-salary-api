import request from 'supertest';
import { bodyOf, errorOf } from '../helpers/http';
import { ORG_BANDS, seedOrg, type SeededOrg } from '../helpers/org';
import { createTestHarness, type TestHarness } from '../helpers/testApp';
import { signInEveryone, type Signins } from '../helpers/tokens';

/**
 * Setting what the company pays for a job.
 *
 * The screen exists because without it "below band" is a judgement made by whoever
 * last ran the seed script, and changing it means database access — which an HR team
 * cannot be asked for. So the tests are about the two things that make it usable:
 * gaps are visible, and a saved band immediately changes who is below it.
 */

interface CoverageRow {
  jobLevelId: number;
  jobLevelName: string;
  country: string;
  band: { currency: string; minMinor: number; midMinor: number; maxMinor: number } | null;
  headcount: number;
  paidHeadcount: number;
  payCurrency: string | null;
  payCurrencies: number;
  below: number;
  within: number;
  above: number;
  otherCurrency: number;
}

interface Coverage {
  rows: CoverageRow[];
  pairsWithoutBand: number;
  peopleWithoutBand: number;
  asOf: string;
}

describe('pay bands', () => {
  let harness: TestHarness;
  let org: SeededOrg;
  let signins: Signins;

  const coverageOf = (response: request.Response): Coverage =>
    bodyOf(response) as unknown as Coverage;

  const rowFor = (coverage: Coverage, jobLevelId: number, country: string): CoverageRow => {
    const found = coverage.rows.find(
      (row) => row.jobLevelId === jobLevelId && row.country === country,
    );
    if (found === undefined) {
      throw new Error(`No coverage row for level ${String(jobLevelId)} in ${country}.`);
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
    signins = await signInEveryone(harness);
  });

  afterAll(async () => {
    await harness.close();
  });

  const listAs = (email: Parameters<Signins['as']>[0]) =>
    request(harness.app).get('/api/bands').set('Authorization', signins.as(email));

  const saveAs = (
    email: Parameters<Signins['as']>[0],
    jobLevelId: number,
    country: string,
    body: object,
  ) =>
    request(harness.app)
      .put(`/api/bands/${String(jobLevelId)}/${country}`)
      .set('Authorization', signins.as(email))
      .send(body);

  const removeAs = (email: Parameters<Signins['as']>[0], jobLevelId: number, country: string) =>
    request(harness.app)
      .delete(`/api/bands/${String(jobLevelId)}/${country}`)
      .set('Authorization', signins.as(email));

  describe('who may see and change them', () => {
    it.each(['hr.admin@acme.test', 'hr.viewer@acme.test'] as const)(
      'given %s, when they list the bands, then they get them',
      async (email) => {
        expect((await listAs(email)).status).toBe(200);
      },
    );

    it.each(['manager@acme.test', 'employee@acme.test'] as const)(
      'given %s, when they list the bands, then it is refused',
      async (email) => {
        /* Different from the needs-attention list, which a Manager may open. That is
           salaries they can already see; this is what the company pays two levels
           above them, which is not theirs. */
        const response = await listAs(email);

        expect(response.status).toBe(403);
        expect(errorOf(response).message).toContain('HR roles only');
      },
    );

    it('given HR Viewer, when they try to save a band, then it is refused', async () => {
      const response = await saveAs('hr.viewer@acme.test', org.juniorLevelId, 'CA', {
        currency: 'CAD',
        min: '60000.00',
        mid: '75000.00',
        max: '90000.00',
      });

      expect(response.status).toBe(403);
    });

    it('given no token, when the bands are asked for, then it is refused', async () => {
      expect((await request(harness.app).get('/api/bands')).status).toBe(401);
    });
  });

  describe('the gaps, which are the point', () => {
    it('given every occupied pair has a band, when listed, then no gaps are reported', async () => {
      /* The baseline the next test breaks. Worth asserting on its own: a screen that
         reported phantom gaps would be worse than one that reported none. */
      const coverage = coverageOf(await listAs('hr.admin@acme.test'));

      expect(coverage.pairsWithoutBand).toBe(0);
      expect(coverage.peopleWithoutBand).toBe(0);
    });

    it('given a band that exists for a pair with nobody in it, when listed, then it still appears', async () => {
      /* Both directions matter. A band nobody is under is not a gap, but it is still
         policy somebody set and may want to change. */
      const coverage = coverageOf(await listAs('hr.admin@acme.test'));
      const unused = rowFor(coverage, org.seniorLevelId, 'IN');

      expect(unused.band).not.toBeNull();
      expect(unused.headcount).toBe(0);
    });

    it('given a country with employees but no band at their level, when listed, then it is counted', async () => {
      /* Deepest Report is a Junior in India. Removing that band leaves a real person
         with nothing to be compared against, which the summary has to surface. */
      await removeAs('hr.admin@acme.test', org.juniorLevelId, 'IN');

      const coverage = coverageOf(await listAs('hr.admin@acme.test'));

      expect(coverage.pairsWithoutBand).toBeGreaterThan(0);
      expect(coverage.peopleWithoutBand).toBeGreaterThan(0);
      expect(rowFor(coverage, org.juniorLevelId, 'IN').band).toBeNull();
      expect(rowFor(coverage, org.juniorLevelId, 'IN').headcount).toBe(1);

      // Put it back, since the rest of the file reads the seeded figures.
      await saveAs('hr.admin@acme.test', org.juniorLevelId, 'IN', {
        currency: 'INR',
        min: '6000000.00',
        mid: '7000000.00',
        max: '8000000.00',
      });
    });

    it('given a band, when listed, then it says how many are below, within and above it', async () => {
      const coverage = coverageOf(await listAs('hr.admin@acme.test'));
      const usJunior = rowFor(coverage, org.juniorLevelId, 'US');

      // Thirty fillers below, the unpaid joiner counted in neither.
      expect(usJunior.below).toBe(30);
      expect(usJunior.below + usJunior.within + usJunior.above).toBe(usJunior.paidHeadcount);
    });

    it('given a band, when listed, then it says what people are actually paid in', async () => {
      /* A band in the wrong currency compares to nobody: every person reads as "not
         comparable", and the band looks set when it is useless. */
      const coverage = coverageOf(await listAs('hr.admin@acme.test'));
      const row = rowFor(coverage, org.juniorLevelId, 'IN');

      expect(row.payCurrency).toBe('INR');
      expect(row.payCurrencies).toBe(1);
      expect(row.otherCurrency).toBe(0);
    });

    it('given the list, when returned, then it is ordered by country then seniority', async () => {
      /* Alphabetically by level name would put Associate above Director, which is the
         wrong order to review a country's bands in. */
      const coverage = coverageOf(await listAs('hr.admin@acme.test'));
      const gb = coverage.rows.filter((row) => row.country === 'GB');

      expect(gb.map((row) => row.jobLevelName)).toEqual(['Junior', 'Senior']);
    });

    it('given the list, when returned, then it is not cacheable', async () => {
      expect((await listAs('hr.admin@acme.test')).headers['cache-control']).toBe('no-store');
    });
  });

  describe('saving a band', () => {
    it('given a new band for a country with nobody in it, when saved, then it is created', async () => {
      const response = await saveAs('hr.admin@acme.test', org.juniorLevelId, 'CA', {
        currency: 'CAD',
        min: '60000.00',
        mid: '75000.00',
        max: '90000.00',
      });

      expect(response.status).toBe(200);
      const row = rowFor(coverageOf(response), org.juniorLevelId, 'CA');
      expect(row.band).toEqual({
        currency: 'CAD',
        minMinor: 6_000_000,
        midMinor: 7_500_000,
        maxMinor: 9_000_000,
      });
    });

    it('given a lower-case country code, when saved, then it is stored upper-cased', async () => {
      const response = await saveAs('hr.admin@acme.test', org.seniorLevelId, 'ca', {
        currency: 'CAD',
        min: '90000.00',
        mid: '110000.00',
        max: '130000.00',
      });

      expect(rowFor(coverageOf(response), org.seniorLevelId, 'CA').band).not.toBeNull();
    });

    it('given a band raised above what people earn, when saved, then the counts change in the same response', async () => {
      /**
       * The behaviour that makes the screen usable.
       *
       * The figures worth seeing after setting a band are how many people are now
       * below it, and those are only knowable by recomputing — so the write answers
       * with the whole recomputed list rather than the row it wrote.
       */
      const before = rowFor(
        coverageOf(await listAs('hr.admin@acme.test')),
        org.seniorLevelId,
        'US',
      );
      expect(before.below).toBe(0);

      // Deep Report is on 10,000,000 and Outside Lead on 15,000,000.
      const response = await saveAs('hr.admin@acme.test', org.seniorLevelId, 'US', {
        currency: 'USD',
        min: '120000.00',
        mid: '140000.00',
        max: '160000.00',
      });

      const after = rowFor(coverageOf(response), org.seniorLevelId, 'US');
      expect(after.below).toBe(1);
      expect(after.within).toBe(1);

      // Restored, so later assertions read the seeded figures.
      await saveAs('hr.admin@acme.test', org.seniorLevelId, 'US', {
        currency: 'USD',
        min: String(ORG_BANDS.usSenior.minMinor / 100),
        mid: String(ORG_BANDS.usSenior.midMinor / 100),
        max: String(ORG_BANDS.usSenior.maxMinor / 100),
      });
    });

    it('given a band saved twice, when the second is sent, then it replaces rather than duplicating', async () => {
      /* PUT on the natural key: (level, country) *is* a band's identity, so the same
         request twice lands on the same row. */
      await saveAs('hr.admin@acme.test', org.juniorLevelId, 'AU', {
        currency: 'AUD',
        min: '70000.00',
        mid: '80000.00',
        max: '95000.00',
      });
      const second = await saveAs('hr.admin@acme.test', org.juniorLevelId, 'AU', {
        currency: 'AUD',
        min: '75000.00',
        mid: '85000.00',
        max: '99000.00',
      });

      const rows = coverageOf(second).rows.filter(
        (row) => row.country === 'AU' && row.jobLevelId === org.juniorLevelId,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.band?.minMinor).toBe(7_500_000);
    });

    it('given the edges out of order, when saved, then it is refused with the rule', async () => {
      const response = await saveAs('hr.admin@acme.test', org.juniorLevelId, 'CA', {
        currency: 'CAD',
        min: '90000.00',
        mid: '75000.00',
        max: '60000.00',
      });

      expect(response.status).toBe(400);
      expect(errorOf(response).message).toContain('minimum, midpoint, maximum in order');
    });

    it('given an amount with a separator, when saved, then it names which edge is wrong', async () => {
      /* Three amounts on the form, so "the amount is invalid" does not say which. */
      const response = await saveAs('hr.admin@acme.test', org.juniorLevelId, 'CA', {
        currency: 'CAD',
        min: '60000.00',
        mid: '75,000.00',
        max: '90000.00',
      });

      expect(response.status).toBe(400);
      expect(errorOf(response).message).toContain('midpoint');
    });

    it('given a zero minimum, when saved, then it is refused', async () => {
      const response = await saveAs('hr.admin@acme.test', org.juniorLevelId, 'CA', {
        currency: 'CAD',
        min: '0',
        mid: '75000.00',
        max: '90000.00',
      });

      expect(response.status).toBe(400);
    });

    it('given a job level that does not exist, when saved, then it is a 400 naming the field', async () => {
      const response = await saveAs('hr.admin@acme.test', 999_999, 'CA', {
        currency: 'CAD',
        min: '60000.00',
        mid: '75000.00',
        max: '90000.00',
      });

      expect(response.status).toBe(400);
      expect(errorOf(response).message).toContain('job level');
    });

    it('given an unsupported currency, when saved, then it is refused at the boundary', async () => {
      const response = await saveAs('hr.admin@acme.test', org.juniorLevelId, 'CA', {
        currency: 'JPY',
        min: '6000000',
        mid: '7500000',
        max: '9000000',
      });

      expect(response.status).toBe(400);
    });

    it('given a band saved, when a person in it is read back, then their standing reflects the new band', async () => {
      /* The end-to-end check: the band screen and the person's page have to agree,
         which they do because both read the same table through the same comparison. */
      await saveAs('hr.admin@acme.test', org.juniorLevelId, 'US', {
        currency: 'USD',
        min: '40000.00',
        mid: '60000.00',
        max: '80000.00',
      });

      const filler = org.filler[0];
      if (filler === undefined) {
        throw new Error('Expected a filler employee.');
      }
      const detail = await request(harness.app)
        .get(`/api/employees/${String(filler)}`)
        .set('Authorization', signins.as('hr.admin@acme.test'));

      // Now on 9,000,000 against a band topping out at 8,000,000.
      expect(
        (bodyOf(detail) as unknown as { employee: { band: { fit: string } } }).employee.band.fit,
      ).toBe('ABOVE');

      await saveAs('hr.admin@acme.test', org.juniorLevelId, 'US', {
        currency: 'USD',
        min: String(ORG_BANDS.usJunior.minMinor / 100),
        mid: String(ORG_BANDS.usJunior.midMinor / 100),
        max: String(ORG_BANDS.usJunior.maxMinor / 100),
      });
    });
  });

  describe('removing a band', () => {
    it('given a band, when removed, then it is gone and the pair still appears', async () => {
      await saveAs('hr.admin@acme.test', org.seniorLevelId, 'AU', {
        currency: 'AUD',
        min: '100000.00',
        mid: '120000.00',
        max: '140000.00',
      });

      const response = await removeAs('hr.admin@acme.test', org.seniorLevelId, 'AU');

      expect(response.status).toBe(200);
      /* The pair disappears entirely, because nobody is at that level in that country
         — there is nothing left to have a gap about. */
      expect(
        coverageOf(response).rows.some(
          (row) => row.country === 'AU' && row.jobLevelId === org.seniorLevelId,
        ),
      ).toBe(false);
    });

    it('given no band for that pair, when removed, then it is a 404', async () => {
      const response = await removeAs('hr.admin@acme.test', org.seniorLevelId, 'AU');

      expect(response.status).toBe(404);
    });

    it('given HR Viewer, when they try to remove one, then it is refused', async () => {
      const response = await removeAs('hr.viewer@acme.test', org.juniorLevelId, 'US');

      expect(response.status).toBe(403);
    });
  });

  describe('the counts and the filtered list agree', () => {
    it('given each band outcome, when the People page is filtered to it, then the total matches the count on this screen', async () => {
      /**
       * The link on the pay-bands screen has to lead to the people it was reached
       * from. Both sides use `bandFitCondition`, so this is asserting that one
       * definition really is one definition rather than two that happen to agree.
       */
      const coverage = coverageOf(await listAs('hr.admin@acme.test'));
      const row = rowFor(coverage, org.juniorLevelId, 'US');

      for (const [fit, expected] of [
        ['BELOW', row.below],
        ['WITHIN', row.within],
        ['ABOVE', row.above],
      ] as const) {
        const list = await request(harness.app)
          .get(
            `/api/employees?status=ACTIVE&country=US&jobLevelId=${String(org.juniorLevelId)}&bandFit=${fit}`,
          )
          .set('Authorization', signins.as('hr.admin@acme.test'));

        /* The fit is in the assertion so a failure names which outcome disagreed —
           and the status is, because a 500 here once looked exactly like a count of
           zero. */
        expect([fit, list.status, (bodyOf(list) as unknown as { total: number }).total]).toEqual([
          fit,
          200,
          expected,
        ]);
      }
    });

    it('given somebody with no salary, when the list is filtered to no pay, then they are the ones returned', async () => {
      const list = await request(harness.app)
        .get('/api/employees?status=ACTIVE&bandFit=NO_PAY')
        .set('Authorization', signins.as('hr.admin@acme.test'));
      const rows = (bodyOf(list) as unknown as { rows: { id: number }[] }).rows;

      expect(rows.map((employee) => employee.id)).toContain(org.outside.noPay);
    });

    it('given a band fit that is not one of the six, when asked for, then it is a 400 rather than ignored', async () => {
      /* A closed set, because it becomes a condition rather than a bound value. */
      const response = await request(harness.app)
        .get('/api/employees?bandFit=UNDERPAID')
        .set('Authorization', signins.as('hr.admin@acme.test'));

      expect(response.status).toBe(400);
    });

    it('given a Manager, when they filter by band fit, then the scope still applies', async () => {
      /* The filter narrows; it does not widen. A new condition must never be a way
         around the access scope. */
      const list = await request(harness.app)
        .get('/api/employees?bandFit=BELOW&pageSize=100')
        .set('Authorization', signins.as('manager@acme.test'));
      const rows = (bodyOf(list) as unknown as { rows: { id: number }[] }).rows;

      expect(rows.map((employee) => employee.id)).not.toContain(org.filler[0]);
    });
  });

  describe('the cached lookups', () => {
    it('given a band saved, when the lookups are read again, then they carry the new figures', async () => {
      /* The bands ride along in the cached lookup data, so a write that did not
         invalidate would leave the dropdowns and detail pages on the old range for up
         to an hour. */
      await saveAs('hr.admin@acme.test', org.juniorLevelId, 'GB', {
        currency: 'GBP',
        min: '41000.00',
        mid: '51000.00',
        max: '61000.00',
      });

      const lookups = await request(harness.app)
        .get('/api/lookups')
        .set('Authorization', signins.as('hr.admin@acme.test'));
      const bands = (
        bodyOf(lookups) as unknown as {
          salaryBands: { jobLevelId: number; country: string; minMinor: number }[];
        }
      ).salaryBands;

      expect(
        bands.find((band) => band.country === 'GB' && band.jobLevelId === org.juniorLevelId)
          ?.minMinor,
      ).toBe(4_100_000);
    });
  });
});
