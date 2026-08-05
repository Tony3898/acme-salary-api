import request from 'supertest';
import { bodyOf, errorOf } from '../helpers/http';
import { seedOrg, type SeededOrg } from '../helpers/org';
import { createTestHarness, type TestHarness } from '../helpers/testApp';
import { signInEveryone, type Signins } from '../helpers/tokens';

/**
 * Marking somebody as having left, and bringing them back.
 *
 * The interesting cases are all about the leaving *date*. Status alone cannot
 * answer "who was on the payroll last March", so the date is required — and the
 * schema pairs the two, which means the service has to refuse the three ways they
 * can disagree before the database does it with a 500.
 */

interface Detail {
  employee: { id: number; status: string; leftOn: string | null; fullName: string };
}

describe('PATCH /api/employees/:id/status', () => {
  let harness: TestHarness;
  let org: SeededOrg;
  let signins: Signins;

  const detailOf = (response: request.Response): Detail => bodyOf(response) as unknown as Detail;

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

  const changeAs = (email: Parameters<Signins['as']>[0], id: number, body: object) =>
    request(harness.app)
      .patch(`/api/employees/${String(id)}/status`)
      .set('Authorization', signins.as(email))
      .send(body);

  /** Somebody with no reports, so the manager check is not what is under test. */
  const spare = (): number => {
    const id = org.filler.at(-1);
    if (id === undefined) {
      throw new Error('Expected the org to have filler employees.');
    }
    return id;
  };

  describe('who may change it', () => {
    it('given HR Admin, when they mark somebody as having left, then the record says so', async () => {
      const response = await changeAs('hr.admin@acme.test', spare(), {
        status: 'LEFT',
        leftOn: '2026-08-31',
      });

      expect(response.status).toBe(200);
      expect(detailOf(response).employee).toMatchObject({
        status: 'LEFT',
        leftOn: '2026-08-31',
      });
    });

    it('given HR Viewer, when they try, then it is refused', async () => {
      const response = await changeAs('hr.viewer@acme.test', org.outside.lead, {
        status: 'LEFT',
        leftOn: '2026-08-31',
      });

      expect(response.status).toBe(403);
      expect(errorOf(response).code).toBe('FORBIDDEN');
    });

    it('given a Manager, when they try on their own report, then it is refused on the role, not the scope', async () => {
      /* Seeing somebody is not the same as being able to end their employment, and
         a Manager can see this person. The role guard is what stops it. */
      const response = await changeAs('manager@acme.test', org.chain.report, {
        status: 'LEFT',
        leftOn: '2026-08-31',
      });

      expect(response.status).toBe(403);
    });

    it('given no token, when a status is changed, then it is refused', async () => {
      const response = await request(harness.app)
        .patch(`/api/employees/${String(org.outside.lead)}/status`)
        .send({ status: 'LEFT', leftOn: '2026-08-31' });

      expect(response.status).toBe(401);
    });
  });

  describe('the leaving date', () => {
    it('given LEFT with no date, when submitted, then it is refused with the reason it matters', async () => {
      const response = await changeAs('hr.admin@acme.test', spare(), { status: 'LEFT' });

      expect(response.status).toBe(400);
      expect(errorOf(response).message).toContain('leaving date is required');
    });

    it('given ACTIVE with a date, when submitted, then it is refused', async () => {
      const response = await changeAs('hr.admin@acme.test', spare(), {
        status: 'ACTIVE',
        leftOn: '2026-08-31',
      });

      expect(response.status).toBe(400);
      expect(errorOf(response).message).toContain('still employed');
    });

    it('given a leaving date before the hire date, when submitted, then it is refused and names the hire date', async () => {
      const response = await changeAs('hr.admin@acme.test', org.outside.lead, {
        status: 'LEFT',
        leftOn: '2018-01-01',
      });

      expect(response.status).toBe(400);
      expect(errorOf(response).message).toContain('2019-02-18');
    });

    it('given a date that is the right shape but not a real day, when submitted, then it is a 400 about the field', async () => {
      const response = await changeAs('hr.admin@acme.test', spare(), {
        status: 'LEFT',
        leftOn: '2026-02-31',
      });

      expect(response.status).toBe(400);
      expect(errorOf(response).code).toBe('INVALID_REQUEST');
    });

    it('given somebody marked as having left, when they are made active again, then the date is cleared', async () => {
      const id = org.filler[0];
      if (id === undefined) {
        throw new Error('Expected a filler employee.');
      }

      await changeAs('hr.admin@acme.test', id, { status: 'LEFT', leftOn: '2026-07-31' });
      const response = await changeAs('hr.admin@acme.test', id, { status: 'ACTIVE' });

      expect(response.status).toBe(200);
      expect(detailOf(response).employee).toMatchObject({ status: 'ACTIVE', leftOn: null });
    });

    it('given the same change twice, when applied again, then it succeeds rather than complaining', async () => {
      /* Not an error. A corrected leaving date comes through this same call, and
         refusing "no change" would also break the button for anybody who
         double-clicked it. */
      const id = org.filler[1];
      if (id === undefined) {
        throw new Error('Expected a filler employee.');
      }

      await changeAs('hr.admin@acme.test', id, { status: 'LEFT', leftOn: '2026-07-31' });
      const again = await changeAs('hr.admin@acme.test', id, {
        status: 'LEFT',
        leftOn: '2026-07-31',
      });

      expect(again.status).toBe(200);
    });

    it('given a corrected leaving date, when submitted for an existing leaver, then it is updated', async () => {
      const id = org.filler[2];
      if (id === undefined) {
        throw new Error('Expected a filler employee.');
      }

      await changeAs('hr.admin@acme.test', id, { status: 'LEFT', leftOn: '2026-07-31' });
      const corrected = await changeAs('hr.admin@acme.test', id, {
        status: 'LEFT',
        leftOn: '2026-06-30',
      });

      expect(detailOf(corrected).employee.leftOn).toBe('2026-06-30');
    });
  });

  describe('somebody with people reporting to them', () => {
    it('given a manager with an active report, when they are marked as having left, then it is refused and the count is named', async () => {
      /* A departed manager leaves their team pointing at somebody who is no longer
         here, which silently breaks the Manager access scope for everybody
         underneath. The message says how many and what to do. */
      const response = await changeAs('hr.admin@acme.test', org.chain.deep, {
        status: 'LEFT',
        leftOn: '2026-08-31',
      });

      expect(response.status).toBe(400);
      expect(errorOf(response).message).toMatch(/1 person still reports/);
      expect(errorOf(response).message).toContain('another manager');
    });

    it('given a manager whose only report has themselves left, when they are marked as having left, then it is allowed', async () => {
      /* Counting reports who have already gone would block a departure for no
         reason — there is nobody left pointing at them. */
      await changeAs('hr.admin@acme.test', org.chain.deepest, {
        status: 'LEFT',
        leftOn: '2026-08-01',
      });

      const response = await changeAs('hr.admin@acme.test', org.chain.deep, {
        status: 'LEFT',
        leftOn: '2026-08-31',
      });

      expect(response.status).toBe(200);
    });
  });

  describe('somebody the caller cannot see', () => {
    it('given an id that does not exist, when a status is changed, then it is a 404', async () => {
      const response = await changeAs('hr.admin@acme.test', 999_999, {
        status: 'LEFT',
        leftOn: '2026-08-31',
      });

      expect(response.status).toBe(404);
    });

    it('given an id that is not a number, when a status is changed, then it is a 400 about the parameter', async () => {
      const response = await request(harness.app)
        .patch('/api/employees/not-a-number/status')
        .set('Authorization', signins.as('hr.admin@acme.test'))
        .send({ status: 'ACTIVE' });

      expect(response.status).toBe(400);
    });
  });
});
