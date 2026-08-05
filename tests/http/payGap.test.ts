import request from 'supertest';
import { compensationRecords, employees, fxRates } from '../../src/db/schema';
import { MIN_GROUP_FOR_MEDIAN } from '../../src/domain/disclosure';
import { bodyOf, errorOf } from '../helpers/http';
import { createTestHarness, type TestHarness } from '../helpers/testApp';
import { signInEveryone, type Signins } from '../helpers/tokens';

/**
 * Median pay by gender, one country and one level at a time.
 *
 * Every assertion here is really about something the analysis refuses to do:
 * compare across countries, publish a group of four, treat "not recorded" as a
 * gender, or produce a company-wide figure that mostly measures who sits at which
 * level. Those refusals are the feature — a single headline percentage is easy to
 * compute and is the wrong number.
 */

interface PayGapGroup {
  gender: string;
  headcount: number;
  medianMinor: number | null;
  gapMinor: number | null;
}

interface PayGapCell {
  country: string;
  jobLevelName: string;
  currency: string;
  headcount: number;
  referenceMedianMinor: number;
  groups: PayGapGroup[];
}

interface PayGapBody {
  cells: PayGapCell[];
  minimumGroupSize: number;
  referenceGender: string;
  suppressedCells: number;
  mixedCurrencyCells: number;
  unrecordedGender: number;
  syntheticData: boolean;
  asOf: string;
}

/** Pounds, so the figures below read as the pence they are. */
const MEN_MEDIAN = 10_000_000;
const WOMEN_MEDIAN = 9_600_000;

describe('GET /api/stats/pay-gap', () => {
  let harness: TestHarness;
  let signins: Signins;
  let seniorLevelId: number;
  let departmentId: number;
  let nextEmail = 0;

  const gapOf = (response: request.Response): PayGapBody =>
    bodyOf(response) as unknown as PayGapBody;

  /**
   * Adds people to one cell, all on the same salary, so the median of the group is
   * that salary and every figure below can be read straight off these calls.
   */
  async function addPeople(spec: {
    count: number;
    gender: 'FEMALE' | 'MALE' | 'OTHER' | null;
    country: string;
    currency: 'GBP' | 'USD';
    amountMinor: number | null;
    jobLevelId?: number;
  }): Promise<void> {
    for (let index = 0; index < spec.count; index += 1) {
      nextEmail += 1;
      const [inserted] = await harness.db
        .insert(employees)
        .values({
          fullName: `Person ${String(nextEmail)}`,
          email: `gap${String(nextEmail)}@acme.test`,
          country: spec.country,
          departmentId,
          jobLevelId: spec.jobLevelId ?? seniorLevelId,
          hireDate: '2020-01-01',
          gender: spec.gender,
        })
        .returning({ id: employees.id });

      if (!inserted) {
        throw new Error('Failed to insert a test employee.');
      }
      if (spec.amountMinor !== null) {
        await harness.db.insert(compensationRecords).values({
          employeeId: inserted.id,
          amountMinor: spec.amountMinor,
          currency: spec.currency,
          effectiveFrom: '2020-01-01',
        });
      }
    }
  }

  beforeAll(async () => {
    harness = await createTestHarness();
    signins = await signInEveryone(harness);

    await harness.db.insert(fxRates).values([
      { currency: 'GBP', rateToUsd: '1.27000000', asOf: '2026-08-01' },
      { currency: 'USD', rateToUsd: '1.00000000', asOf: '2026-08-01' },
    ]);

    const [level] = await harness.db.query.jobLevels.findMany({ limit: 1 });
    const [department] = await harness.db.query.departments.findMany({ limit: 1 });
    if (!level || !department) {
      throw new Error('The harness should have seeded a level and a department.');
    }
    seniorLevelId = level.id;
    departmentId = department.id;

    /* One publishable cell: GB Senior, with enough of both genders. The seeded
       accounts already put two people in GB Senior with no gender recorded, which
       is why the unrecorded count below is not simply what this block adds. */
    await addPeople({
      count: 6,
      gender: 'MALE',
      country: 'GB',
      currency: 'GBP',
      amountMinor: MEN_MEDIAN,
    });
    await addPeople({
      count: 5,
      gender: 'FEMALE',
      country: 'GB',
      currency: 'GBP',
      amountMinor: WOMEN_MEDIAN,
    });
    // Below the threshold, so this group has a headcount and no median.
    await addPeople({
      count: 2,
      gender: 'OTHER',
      country: 'GB',
      currency: 'GBP',
      amountMinor: 11_000_000,
    });

    /* A cell where only one gender reaches the threshold, so nothing can be
       published about it at all. */
    await addPeople({
      count: 6,
      gender: 'MALE',
      country: 'US',
      currency: 'USD',
      amountMinor: 12_000_000,
    });
    await addPeople({
      count: 3,
      gender: 'FEMALE',
      country: 'US',
      currency: 'USD',
      amountMinor: 9_000_000,
    });

    // People with a salary and no gender recorded: counted, never a fourth group.
    await addPeople({
      count: 4,
      gender: null,
      country: 'GB',
      currency: 'GBP',
      amountMinor: 10_500_000,
    });
  });

  afterAll(async () => {
    await harness.close();
  });

  const askAs = (email: Parameters<Signins['as']>[0], query = '') =>
    request(harness.app).get(`/api/stats/pay-gap${query}`).set('Authorization', signins.as(email));

  describe('who may see it', () => {
    it.each(['hr.admin@acme.test', 'hr.viewer@acme.test'] as const)(
      'given %s, when they ask, then the analysis is returned',
      async (email) => {
        const response = await askAs(email);

        expect(response.status).toBe(200);
      },
    );

    it.each(['manager@acme.test', 'employee@acme.test'] as const)(
      'given %s, when they ask, then it is refused rather than narrowed',
      async (email) => {
        /* Narrowing to a Manager's team would put every cell under the disclosure
           threshold, and the few that survived would compare two named colleagues. */
        const response = await askAs(email);

        expect(response.status).toBe(403);
        expect(errorOf(response).message).toContain('HR roles only');
      },
    );

    it('given no token, when the analysis is asked for, then it is refused', async () => {
      const response = await request(harness.app).get('/api/stats/pay-gap');

      expect(response.status).toBe(401);
    });

    it('given any caller, when the response is sent, then nothing in between may cache it', async () => {
      const response = await askAs('hr.admin@acme.test');

      expect(response.headers['cache-control']).toBe('no-store');
    });
  });

  describe('the comparison', () => {
    it('given a cell with enough of both genders, when analysed, then the gap is reported against the male median', async () => {
      const body = gapOf(await askAs('hr.admin@acme.test'));
      const cell = body.cells.find((entry) => entry.country === 'GB');

      expect(body.referenceGender).toBe('MALE');
      expect(cell?.referenceMedianMinor).toBe(MEN_MEDIAN);

      const women = cell?.groups.find((group) => group.gender === 'FEMALE');
      expect(women?.medianMinor).toBe(WOMEN_MEDIAN);
      // Negative means paid less, in pence, never as a converted figure.
      expect(women?.gapMinor).toBe(WOMEN_MEDIAN - MEN_MEDIAN);
    });

    it('given a cell, when returned, then the reference gender comes first', async () => {
      const body = gapOf(await askAs('hr.admin@acme.test'));
      const cell = body.cells.find((entry) => entry.country === 'GB');

      expect(cell?.groups[0]?.gender).toBe('MALE');
    });

    it('given a cell, when returned, then its figures are in the local currency and nothing is converted', async () => {
      const body = gapOf(await askAs('hr.admin@acme.test'));

      expect(body.cells.find((entry) => entry.country === 'GB')?.currency).toBe('GBP');
    });

    it('given the whole response, when read, then there is no company-wide figure to quote', async () => {
      /* Deliberate. One number for the company mostly measures who sits at which
         level in which country, and somebody would quote it. */
      const body: Record<string, unknown> = bodyOf(await askAs('hr.admin@acme.test'));

      expect(Object.keys(body)).not.toContain('overallGapMinor');
      expect(Object.keys(body)).not.toContain('gapPercent');
    });
  });

  describe('what it suppresses', () => {
    it('given a group below the threshold, when analysed, then its headcount is reported and its median is not', async () => {
      const body = gapOf(await askAs('hr.admin@acme.test'));
      const cell = body.cells.find((entry) => entry.country === 'GB');
      const other = cell?.groups.find((group) => group.gender === 'OTHER');

      expect(other?.headcount).toBe(2);
      expect(other?.medianMinor).toBeNull();
      expect(other?.gapMinor).toBeNull();
    });

    it('given a cell where only the reference group is large enough, when analysed, then the whole cell is withheld and counted', async () => {
      /* A cell showing one median on its own is an invitation to compare it with a
         cell from somewhere else, which is the comparison this module exists to
         prevent. */
      const body = gapOf(await askAs('hr.admin@acme.test'));

      expect(body.cells.map((cell) => cell.country)).not.toContain('US');
      expect(body.suppressedCells).toBeGreaterThan(0);
    });

    it('given the threshold, when published, then it is the same one the dashboard uses', async () => {
      const body = gapOf(await askAs('hr.admin@acme.test'));

      expect(body.minimumGroupSize).toBe(MIN_GROUP_FOR_MEDIAN);
    });

    it('given people with no gender recorded, when analysed, then they are counted and are not a fourth group', async () => {
      const body = gapOf(await askAs('hr.admin@acme.test'));
      const genders = body.cells.flatMap((cell) => cell.groups.map((group) => group.gender));

      expect(body.unrecordedGender).toBeGreaterThanOrEqual(4);
      expect(genders).not.toContain(null);
      expect(genders.every((gender) => ['MALE', 'FEMALE', 'OTHER'].includes(gender))).toBe(true);
    });

    it('given the data is generated, when analysed, then the response says so rather than the screen', async () => {
      /* A caveat hard-coded into the UI keeps saying "synthetic" after the data
         becomes real. This flag is the one thing that has to change. */
      expect(gapOf(await askAs('hr.admin@acme.test')).syntheticData).toBe(true);
    });
  });

  describe('filters', () => {
    it('given a country filter, when analysed, then only that country has cells', async () => {
      const body = gapOf(await askAs('hr.admin@acme.test', '?country=GB'));

      expect(body.cells.every((cell) => cell.country === 'GB')).toBe(true);
    });

    it('given a filter that leaves every group too small, when analysed, then there are no cells rather than an error', async () => {
      const body = gapOf(await askAs('hr.admin@acme.test', '?country=US'));

      expect(body.cells).toEqual([]);
    });

    it('given a country code in the wrong shape, when asked for, then it is a 400 about the parameter', async () => {
      const response = await askAs('hr.admin@acme.test', '?country=GBR');

      expect(response.status).toBe(400);
    });
  });
});
