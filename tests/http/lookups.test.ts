import { eq } from 'drizzle-orm';
import request from 'supertest';
import { departments } from '../../src/db/schema';
import { accessTokenFrom, bodyOf } from '../helpers/http';
import { seedOrg } from '../helpers/org';
import { createTestHarness, TEST_PASSWORD, type TestHarness } from '../helpers/testApp';

interface LookupBody {
  departments: { id: number; name: string }[];
  jobLevels: { id: number; name: string; rank: number }[];
  countries: string[];
  fxRates: { currency: string; rateToUsd: string; asOf: string }[];
  salaryBands: unknown[];
}

describe('GET /api/lookups', () => {
  let harness: TestHarness;
  let token: string;

  beforeAll(async () => {
    harness = await createTestHarness();
    const managerEmployeeId = harness.accounts.manager.employeeId;
    if (managerEmployeeId === null) {
      throw new Error('The manager account must be linked to an employee.');
    }
    await seedOrg(harness.db, managerEmployeeId);

    const login = await request(harness.app)
      .post('/api/auth/login')
      .send({ email: 'hr.admin@acme.test', password: TEST_PASSWORD });
    token = accessTokenFrom(login);
  });

  afterAll(async () => {
    await harness.close();
  });

  const fetchLookups = () =>
    request(harness.app).get('/api/lookups').set('Authorization', `Bearer ${token}`);

  const lookupsOf = (response: request.Response) => bodyOf(response) as unknown as LookupBody;

  it('given a signed-in user, when the lookups are fetched, then the reference data comes back', async () => {
    const body = lookupsOf(await fetchLookups().expect(200));

    expect(body.departments.map((row) => row.name)).toEqual(['Engineering', 'Sales']);
    expect(body.jobLevels.map((row) => row.name)).toEqual(['Junior', 'Senior']);
    expect(body.countries).toEqual(['GB', 'IN', 'US']);
  });

  it('given exchange rates, when they are returned, then they stay strings', async () => {
    /* `numeric` in the database. Read into a float it loses precision, and the
       conversion is done by Postgres anyway — nothing here needs it as a number. */
    const body = lookupsOf(await fetchLookups().expect(200));
    const gbp = body.fxRates.find((rate) => rate.currency === 'GBP');

    expect(gbp?.rateToUsd).toBe('1.27000000');
    expect(typeof gbp?.rateToUsd).toBe('string');
  });

  it('given no token, when the lookups are fetched, then it is refused', async () => {
    /* Not personal data, but pay bands say what the company pays for a level in a
       country, which is not something to publish. */
    await request(harness.app).get('/api/lookups').expect(401);
  });

  it('given a response, when its headers are read, then it may be cached by the browser but not by a proxy', async () => {
    const response = await fetchLookups().expect(200);

    expect(response.headers['cache-control']).toContain('private');
    expect(response.headers['cache-control']).toContain('max-age=');
  });

  it('given the data changes behind the cache, when it is fetched again, then the held copy is served', async () => {
    /* The trade-off stated plainly: a change made directly in the database is not
       visible until the TTL runs out. Changes made through the app invalidate the
       cache, so this only applies to edits made behind its back. */
    await fetchLookups().expect(200);
    await harness.db
      .update(departments)
      .set({ name: 'Renamed Behind The Cache' })
      .where(eq(departments.name, 'Sales'));

    const body = lookupsOf(await fetchLookups().expect(200));

    expect(body.departments.map((row) => row.name)).toEqual(['Engineering', 'Sales']);
  });

  it('given the cache is told the data changed, when it is fetched again, then the new value is served', async () => {
    harness.container.lookups.invalidate();

    const body = lookupsOf(await fetchLookups().expect(200));

    expect(body.departments.map((row) => row.name)).toEqual([
      'Engineering',
      'Renamed Behind The Cache',
    ]);
  });
});
