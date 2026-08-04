import request from 'supertest';
import { REFRESH_COOKIE_NAME } from '../../src/routes/auth';
import { cookieFor } from '../helpers/cookies';
import { accessTokenFrom, bodyOf, errorOf } from '../helpers/http';
import { createTestHarness, TEST_PASSWORD, type TestHarness } from '../helpers/testApp';

describe('POST /api/auth/login', () => {
  let harness: TestHarness;

  beforeAll(async () => {
    harness = await createTestHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  const login = (email: string, password: string) =>
    request(harness.app).post('/api/auth/login').send({ email, password });

  it('given the right password, when logging in, then an access token and the account come back', async () => {
    const response = await login('hr.admin@acme.test', TEST_PASSWORD);

    expect(response.status).toBe(200);
    expect(accessTokenFrom(response)).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
    expect(bodyOf(response)).toMatchObject({
      expiresInSeconds: 900,
      user: {
        id: harness.accounts.hrAdmin.id,
        email: 'hr.admin@acme.test',
        role: 'HR_ADMIN',
        employeeId: null,
      },
    });
  });

  it('given a successful login, when the response is read, then no password hash appears in it', async () => {
    /* The account row carries the hash and the response is built from it, so this
       is the check that the field list in the repository is doing its job — in the
       body and in the headers, since a cookie is a header. */
    const response = await login('hr.admin@acme.test', TEST_PASSWORD);
    const everythingSent = JSON.stringify({ headers: response.headers, body: bodyOf(response) });

    expect(everythingSent).not.toContain('argon2');
    expect(everythingSent).not.toContain('passwordHash');
    expect(everythingSent).not.toContain(TEST_PASSWORD);
  });

  it('given an unknown email and a wrong password, when both are tried, then the responses are identical', async () => {
    /* The whole point of the decoy hash. If these two differed in status, body or
       code, the login form would answer "does this person work here?" for anybody
       who asked. */
    const unknownEmail = await login('nobody@acme.test', TEST_PASSWORD);
    const wrongPassword = await login('hr.admin@acme.test', 'not-the-password');

    expect(unknownEmail.status).toBe(401);
    expect(wrongPassword.status).toBe(unknownEmail.status);
    expect(bodyOf(wrongPassword)).toEqual(bodyOf(unknownEmail));
    expect(bodyOf(unknownEmail)).toEqual({
      error: { code: 'INVALID_CREDENTIALS', message: 'Email or password is incorrect.' },
    });
  });

  it('given a failed login, when the response is read, then no session cookie is set', async () => {
    const response = await login('hr.admin@acme.test', 'not-the-password');

    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it('given an email in a different case, when logging in, then it succeeds', async () => {
    /* Addresses are stored as typed but matched case-insensitively, so somebody
       whose keyboard capitalised the first letter is not locked out. */
    const response = await login('HR.Admin@ACME.test', TEST_PASSWORD);

    expect(response.status).toBe(200);
    expect(bodyOf(response)).toMatchObject({ user: { email: 'hr.admin@acme.test' } });
  });

  it('given surrounding whitespace, when logging in, then it succeeds', async () => {
    const response = await login('  hr.admin@acme.test  ', TEST_PASSWORD);

    expect(response.status).toBe(200);
  });

  it('given a successful login, when the cookie is inspected, then the refresh token is httpOnly and scoped to the auth routes', async () => {
    const response = await login('manager@acme.test', TEST_PASSWORD);
    const cookie = cookieFor(response, REFRESH_COOKIE_NAME);

    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Path=/api/auth');
    // Not the access token: reading the cookie must not hand over an API credential.
    expect(cookie).not.toContain(accessTokenFrom(response));
  });

  it('given a production configuration, when logging in, then the cookie is Secure and cross-site', async () => {
    /* The two move together: a browser refuses SameSite=None without Secure, and
       the deployed UI is on a different domain from the API. */
    const production = await createTestHarness({ secureCookies: true });
    try {
      const response = await request(production.app)
        .post('/api/auth/login')
        .send({ email: 'hr.admin@acme.test', password: TEST_PASSWORD });
      const cookie = cookieFor(response, REFRESH_COOKIE_NAME);

      expect(cookie).toContain('Secure');
      expect(cookie).toContain('SameSite=None');
    } finally {
      await production.close();
    }
  });

  it.each([
    ['no body at all', {}],
    ['a missing password', { email: 'hr.admin@acme.test' }],
    ['a missing email', { password: TEST_PASSWORD }],
    ['an email that is not an address', { email: 'not-an-email', password: TEST_PASSWORD }],
    ['an empty password', { email: 'hr.admin@acme.test', password: '' }],
    ['a number where the email goes', { email: 42, password: TEST_PASSWORD }],
    ['an array where the password goes', { email: 'hr.admin@acme.test', password: ['a'] }],
  ])('given %s, when logging in, then it is refused as invalid', async (_label, body) => {
    const response = await request(harness.app).post('/api/auth/login').send(body);

    expect(response.status).toBe(400);
    expect(errorOf(response)).toMatchObject({ code: 'INVALID_REQUEST' });
    expect(errorOf(response).details?.length ?? 0).toBeGreaterThan(0);
  });

  it('given an enormous password, when logging in, then it is refused before any hashing happens', async () => {
    // A bound on what reaches argon2, so a large body cannot be turned into CPU time.
    const response = await login('hr.admin@acme.test', 'x'.repeat(5000));

    expect(response.status).toBe(400);
  });

  it('given more attempts than the limit allows, when logging in, then further attempts are refused', async () => {
    const limited = await createTestHarness({ rateLimits: { loginMaxRequests: 3 } });
    try {
      const attempt = () =>
        request(limited.app)
          .post('/api/auth/login')
          .send({ email: 'hr.admin@acme.test', password: 'wrong' });

      const statuses: number[] = [];
      for (let index = 0; index < 4; index += 1) {
        statuses.push((await attempt()).status);
      }

      expect(statuses).toEqual([401, 401, 401, 429]);

      /* And it stays refused even with the right password: otherwise the limit
         only slows an attacker down until they guess correctly. */
      const correct = await request(limited.app)
        .post('/api/auth/login')
        .send({ email: 'hr.admin@acme.test', password: TEST_PASSWORD });

      expect(correct.status).toBe(429);
      expect(errorOf(correct)).toMatchObject({ code: 'RATE_LIMITED' });
    } finally {
      await limited.close();
    }
  });
});
