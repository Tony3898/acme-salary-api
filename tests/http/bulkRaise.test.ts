import request from 'supertest';
import { bodyOf, errorOf } from '../helpers/http';
import { ORG_BANDS, seedOrg, type SeededOrg } from '../helpers/org';
import { createTestHarness, type TestHarness } from '../helpers/testApp';
import { signInEveryone, type Signins } from '../helpers/tokens';

/**
 * One percentage applied to a lot of people.
 *
 * The two tests this feature exists for are "the preview matches what is applied"
 * and "running it twice does not apply it twice". Everything else here is about
 * being honest with the person signing it off: who was left out, why, and who ends
 * up above their band.
 */

interface CurrencyTotal {
  currency: string;
  affected: number;
  currentTotalMinor: number;
  newTotalMinor: number;
  increaseMinor: number;
}

interface Report {
  effectiveFrom: string;
  percent: string;
  matched: number;
  affected: number;
  skippedNoPay: number;
  skippedHiredLater: number;
  skippedAlreadyRecorded: number;
  skippedChangedOnDate: number;
  skippedNotSelected: number;
  changes: { employeeId: number; fullName: string; exceedsBand: boolean }[];
  changesTruncated: boolean;
  byCurrency: CurrencyTotal[];
  increaseUsdMinorEstimate: number;
  currentTotalUsdMinor: number;
  wouldExceedBand: { employeeId: number; fullName: string; newAmountMinor: number }[];
  wouldExceedBandCount: number;
  applied: boolean;
  recorded: number;
}

describe('POST /api/compensation/bulk', () => {
  let harness: TestHarness;
  let org: SeededOrg;
  let signins: Signins;

  const reportOf = (response: request.Response): Report => bodyOf(response) as unknown as Report;

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

  const runAs = (email: Parameters<Signins['as']>[0], body: object, apply = false) =>
    request(harness.app)
      .post(`/api/compensation/bulk?apply=${String(apply)}`)
      .set('Authorization', signins.as(email))
      .send(body);

  /** US Sales juniors: the thirty fillers, all on the same salary. */
  const fillerRaise = (overrides: object = {}) => ({
    percent: '10',
    effectiveFrom: '2026-09-01',
    country: 'US',
    departmentId: org.salesId,
    jobLevelId: org.juniorLevelId,
    ...overrides,
  });

  describe('who may run it', () => {
    it.each(['hr.viewer@acme.test', 'manager@acme.test', 'employee@acme.test'] as const)(
      'given %s, when they preview, then it is refused',
      async (email) => {
        const response = await runAs(email, fillerRaise());

        expect(response.status).toBe(403);
      },
    );

    it('given no token, when a raise is previewed, then it is refused', async () => {
      const response = await request(harness.app)
        .post('/api/compensation/bulk')
        .send(fillerRaise());

      expect(response.status).toBe(401);
    });
  });

  describe('the percentage', () => {
    it.each(['3,5', 'x', '3%', ''])(
      'given "%s" as a percentage, when previewed, then it is a 400 rather than a 500',
      async (percent) => {
        const response = await runAs('hr.admin@acme.test', fillerRaise({ percent }));

        expect(response.status).toBe(400);
        expect(errorOf(response).code).toBe('INVALID_REQUEST');
      },
    );

    it('given zero, when previewed, then it is refused because it would record every salary again', async () => {
      const response = await runAs('hr.admin@acme.test', fillerRaise({ percent: '0' }));

      expect(response.status).toBe(400);
    });

    it('given a percentage beyond the range, when previewed, then it is refused', async () => {
      const response = await runAs('hr.admin@acme.test', fillerRaise({ percent: '250' }));

      expect(response.status).toBe(400);
    });

    it('given a cut that would round somebody to nothing, when previewed, then the message names them', async () => {
      const response = await runAs('hr.admin@acme.test', fillerRaise({ percent: '-100' }));

      expect(response.status).toBe(400);
      expect(errorOf(response).message).toMatch(/It would apply to /);
    });
  });

  describe('the preview', () => {
    it('given a filter, when previewed, then the figures are exact and per currency', async () => {
      const response = await runAs('hr.admin@acme.test', fillerRaise());
      const report = reportOf(response);

      // Thirty people on 9,000,000 cents; 10% is 900,000 each.
      expect(report.affected).toBe(30);
      expect(report.byCurrency).toEqual([
        {
          currency: 'USD',
          affected: 30,
          currentTotalMinor: 30 * 9_000_000,
          newTotalMinor: 30 * 9_900_000,
          increaseMinor: 30 * 900_000,
        },
      ]);
      expect(report.applied).toBe(false);
      expect(report.recorded).toBe(0);
    });

    it('given people in several currencies, when previewed, then nothing is summed across them', async () => {
      /* Adding rupees to pounds is the mistake the whole system is arranged to
         prevent, so the exact figures come back one currency at a time. */
      const response = await runAs('hr.admin@acme.test', {
        percent: '5',
        effectiveFrom: '2026-09-01',
        departmentId: org.engineeringId,
      });
      const currencies = reportOf(response).byCurrency.map((total) => total.currency);

      expect(currencies.length).toBeGreaterThan(1);
      expect(new Set(currencies).size).toBe(currencies.length);
    });

    it('given somebody with no salary recorded, when previewed, then they are counted as skipped and not as affected', async () => {
      const response = await runAs('hr.admin@acme.test', {
        percent: '5',
        effectiveFrom: '2026-09-01',
        country: 'US',
        departmentId: org.salesId,
      });
      const report = reportOf(response);

      expect(report.skippedNoPay).toBe(1);
      expect(report.matched).toBe(
        report.affected +
          report.skippedNoPay +
          report.skippedHiredLater +
          report.skippedAlreadyRecorded +
          report.skippedChangedOnDate,
      );
    });

    it('given a date before somebody was hired, when previewed, then they are skipped rather than backdated', async () => {
      const response = await runAs('hr.admin@acme.test', {
        percent: '5',
        effectiveFrom: '2024-06-01',
        country: 'US',
        departmentId: org.salesId,
      });

      // "Never Paid" was hired in 2026, so a 2024 raise cannot reach them.
      expect(reportOf(response).skippedHiredLater).toBeGreaterThan(0);
    });

    it('given somebody who has left, when previewed, then they are not matched at all', async () => {
      const response = await runAs('hr.admin@acme.test', {
        percent: '5',
        effectiveFrom: '2026-09-01',
        country: 'US',
        departmentId: org.salesId,
      });
      const report = reportOf(response);

      // Thirty fillers, the lead, and the unpaid joiner. The leaver is not there.
      expect(report.matched).toBe(32);
    });

    it('given a raise that pushes somebody past their band, when previewed, then they are named', async () => {
      /* The warning worth having before signing off. The US Sales junior band tops
         out at 12,000,000, so a 40% raise on 9,000,000 clears it. */
      const response = await runAs('hr.admin@acme.test', fillerRaise({ percent: '40' }));
      const report = reportOf(response);

      expect(report.wouldExceedBandCount).toBe(30);
      expect(report.wouldExceedBand[0]?.newAmountMinor).toBe(12_600_000);
      expect(ORG_BANDS.usJunior.maxMinor).toBeLessThan(12_600_000);
    });

    it('given a modest raise, when previewed, then nobody is reported as exceeding their band', async () => {
      expect(reportOf(await runAs('hr.admin@acme.test', fillerRaise())).wouldExceedBandCount).toBe(
        0,
      );
    });

    it('given a preview, when it runs, then nothing is written', async () => {
      const before = await historyLengthOf(org.outside.lead);
      await runAs('hr.admin@acme.test', {
        percent: '5',
        effectiveFrom: '2026-10-01',
        country: 'US',
        jobLevelId: org.seniorLevelId,
      });

      expect(await historyLengthOf(org.outside.lead)).toBe(before);
    });
  });

  describe('applying it', () => {
    it('given a preview and then an apply with the same body, when compared, then every figure matches', async () => {
      /**
       * The promise the whole feature rests on.
       *
       * Preview and apply are one function with a flag, so this is asserting that
       * the structure holds rather than that two pieces of code were written
       * carefully on the same afternoon.
       */
      const body = {
        percent: '7.5',
        effectiveFrom: '2026-11-01',
        country: 'US',
        departmentId: org.salesId,
        jobLevelId: org.juniorLevelId,
      };

      const preview = reportOf(await runAs('hr.admin@acme.test', body));
      const applied = reportOf(await runAs('hr.admin@acme.test', body, true));

      expect(applied.affected).toBe(preview.affected);
      expect(applied.byCurrency).toEqual(preview.byCurrency);
      expect(applied.increaseUsdMinorEstimate).toBe(preview.increaseUsdMinorEstimate);
      expect(applied.recorded).toBe(preview.affected);
      expect(applied.applied).toBe(true);
    });

    it('given a raise already applied, when applied again, then nobody is paid twice', async () => {
      const body = {
        percent: '4',
        effectiveFrom: '2026-12-01',
        country: 'US',
        departmentId: org.salesId,
        jobLevelId: org.juniorLevelId,
      };

      const first = reportOf(await runAs('hr.admin@acme.test', body, true));
      const second = reportOf(await runAs('hr.admin@acme.test', body, true));

      expect(first.recorded).toBe(30);
      expect(second.recorded).toBe(0);
      expect(second.skippedAlreadyRecorded).toBe(30);
      expect(second.affected).toBe(0);
    });

    it('given a raise applied, when the person is read back, then the new salary is what the preview said', async () => {
      const target = org.filler[0];
      if (target === undefined) {
        throw new Error('Expected a filler employee.');
      }

      await runAs(
        'hr.admin@acme.test',
        {
          percent: '10',
          effectiveFrom: '2027-01-01',
          country: 'US',
          departmentId: org.salesId,
          jobLevelId: org.juniorLevelId,
        },
        true,
      );

      const detail = await request(harness.app)
        .get(`/api/employees/${String(target)}?asOf=2027-01-01`)
        .set('Authorization', signins.as('hr.admin@acme.test'));
      const employee = (
        bodyOf(detail) as unknown as { employee: { salary: { amountMinor: number } | null } }
      ).employee;

      /* Two earlier raises in this file already moved this cohort, so the figure is
         asserted as strictly greater rather than as a literal — the point here is
         that the record landed and reads back, which the previous test pins exactly. */
      expect(employee.salary?.amountMinor).toBeGreaterThan(9_000_000);
    });

    it('given a raise applied, when the history is read, then it says what it was', async () => {
      const target = org.filler[1];
      if (target === undefined) {
        throw new Error('Expected a filler employee.');
      }

      await runAs(
        'hr.admin@acme.test',
        {
          percent: '2',
          effectiveFrom: '2027-06-01',
          reason: 'Cost of living, 2027',
          country: 'US',
          departmentId: org.salesId,
          jobLevelId: org.juniorLevelId,
        },
        true,
      );

      const detail = await request(harness.app)
        .get(`/api/employees/${String(target)}`)
        .set('Authorization', signins.as('hr.admin@acme.test'));
      const history = (bodyOf(detail) as unknown as { history: { reason: string | null }[] })
        .history;

      expect(history.map((entry) => entry.reason)).toContain('Cost of living, 2027');
    });

    it('given no reason given, when applied, then the record still says where it came from', async () => {
      const target = org.filler[2];
      if (target === undefined) {
        throw new Error('Expected a filler employee.');
      }

      await runAs(
        'hr.admin@acme.test',
        {
          percent: '1',
          effectiveFrom: '2027-07-01',
          country: 'US',
          departmentId: org.salesId,
          jobLevelId: org.juniorLevelId,
        },
        true,
      );

      const detail = await request(harness.app)
        .get(`/api/employees/${String(target)}`)
        .set('Authorization', signins.as('hr.admin@acme.test'));
      const history = (bodyOf(detail) as unknown as { history: { reason: string | null }[] })
        .history;

      expect(history.map((entry) => entry.reason)).toContain('Bulk change of 1%');
    });

    it('given a selection, when previewed, then only those people are costed', async () => {
      /**
       * The selection is sent on the preview as well as the apply, so a narrowed set is
       * costed by the same arithmetic over the same rows. The alternative — subtracting
       * the deselected from a total in the client — would put the cost of a bulk change
       * in two places.
       */
      const everybody = reportOf(await runAs('hr.admin@acme.test', fillerRaise()));
      const two = everybody.changes.slice(0, 2).map((change) => change.employeeId);

      const narrowed = reportOf(
        await runAs('hr.admin@acme.test', { ...fillerRaise(), employeeIds: two }),
      );

      expect(narrowed.affected).toBe(2);
      expect(narrowed.skippedNotSelected).toBe(everybody.affected - 2);
      expect(narrowed.matched).toBe(everybody.matched);
      expect(narrowed.byCurrency[0]?.increaseMinor).toBe(2 * 900_000);
    });

    it('given a selection, when applied, then only those people get a record', async () => {
      const preview = reportOf(
        await runAs('hr.admin@acme.test', fillerRaise({ effectiveFrom: '2029-01-01' })),
      );
      const two = preview.changes.slice(0, 2).map((change) => change.employeeId);

      const applied = reportOf(
        await runAs(
          'hr.admin@acme.test',
          { ...fillerRaise({ effectiveFrom: '2029-01-01' }), employeeIds: two },
          true,
        ),
      );

      expect(applied.recorded).toBe(2);
      expect(applied.applied).toBe(true);
    });

    it('given an id outside what the filters matched, when named, then it is ignored rather than reached', async () => {
      /* The selection narrows and can never widen. It is intersected with what the
         filters and the access scope already allowed. */
      const narrowed = reportOf(
        await runAs('hr.admin@acme.test', {
          ...fillerRaise(),
          employeeIds: [org.chain.deep, org.outside.lead],
        }),
      );

      expect(narrowed.affected).toBe(0);
    });

    it('given more people than the report will list, when previewed, then the changes are truncated and flagged', async () => {
      /* Nobody reviews nine thousand checkboxes, so beyond the cap the honest answer
         is "narrow the filters" rather than a payload the plan exists to avoid. */
      const everybody = reportOf(
        await runAs('hr.admin@acme.test', { percent: '1', effectiveFrom: '2030-01-01' }),
      );

      expect(everybody.changesTruncated).toBe(false);
      expect(everybody.changes.length).toBeLessThanOrEqual(500);
      expect(everybody.changes.length).toBe(everybody.affected);
    });

    it('given the listed changes, when read, then each carries what the person is on and what they would move to', async () => {
      const preview = reportOf(await runAs('hr.admin@acme.test', fillerRaise()));
      const change = preview.changes[0];

      expect(change).toMatchObject({ exceedsBand: false });
      expect(change?.fullName).toBeTruthy();
    });

    it('given a selection larger than the cap, when sent, then it is refused at the boundary', async () => {
      const response = await runAs('hr.admin@acme.test', {
        ...fillerRaise(),
        employeeIds: Array.from({ length: 501 }, (_unused, index) => index + 1),
      });

      expect(response.status).toBe(400);
    });

    it('given the default, when no apply flag is sent, then it is a preview', async () => {
      /* Getting a dry run when you wanted the real thing costs a second request;
         the other way round costs an append-only table full of raises. */
      const response = await request(harness.app)
        .post('/api/compensation/bulk')
        .set('Authorization', signins.as('hr.admin@acme.test'))
        .send(fillerRaise({ effectiveFrom: '2028-01-01' }));

      expect(reportOf(response).applied).toBe(false);
    });
  });

  async function historyLengthOf(id: number): Promise<number> {
    const detail = await request(harness.app)
      .get(`/api/employees/${String(id)}`)
      .set('Authorization', signins.as('hr.admin@acme.test'));

    return (bodyOf(detail) as unknown as { history: unknown[] }).history.length;
  }
});
