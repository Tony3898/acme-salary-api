import { eq } from 'drizzle-orm';
import request from 'supertest';
import { users } from '../../src/db/schema';
import { REFRESH_COOKIE_NAME } from '../../src/routes/auth';
import { cookieFor, cookieValue } from '../helpers/cookies';
import { accessTokenFrom, bodyOf, errorOf } from '../helpers/http';
import { createTestHarness, TEST_PASSWORD, type TestHarness } from '../helpers/testApp';

/**
 * Staying signed in, and stopping being signed in.
 *
 * Every refresh token here is passed as an explicit cookie header rather than
 * through supertest's agent, because these tests turn on what happens to the
 * *previous* token — which a cookie jar has already discarded.
 */
describe('session lifecycle', () => {
  let harness: TestHarness;

  beforeAll(async () => {
    harness = await createTestHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  const signIn = async (email = 'hr.admin@acme.test') => {
    const response = await request(harness.app)
      .post('/api/auth/login')
      .send({ email, password: TEST_PASSWORD });

    expect(response.status).toBe(200);
    const refreshToken = cookieValue(response, REFRESH_COOKIE_NAME);
    if (!refreshToken) {
      throw new Error('Login did not set a refresh token.');
    }

    return { refreshToken, accessToken: accessTokenFrom(response) };
  };

  const refreshWith = (refreshToken: string) =>
    request(harness.app)
      .post('/api/auth/refresh')
      .set('Cookie', `${REFRESH_COOKIE_NAME}=${refreshToken}`);

  it('given a valid refresh token, when refreshing, then a new pair is issued', async () => {
    const { refreshToken } = await signIn();

    const response = await refreshWith(refreshToken);

    expect(response.status).toBe(200);
    expect(accessTokenFrom(response)).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
    expect(bodyOf(response)).toMatchObject({
      user: { email: 'hr.admin@acme.test', role: 'HR_ADMIN' },
    });
    expect(cookieValue(response, REFRESH_COOKIE_NAME)).not.toBe(refreshToken);
  });

  it('given a refresh token that has been used, when it is presented again, then it is refused', async () => {
    /* Rotation. Without it a stolen cookie is valid for its whole lifetime, and
       logging out would not end anything. */
    const { refreshToken } = await signIn();
    await refreshWith(refreshToken).expect(200);

    const replay = await refreshWith(refreshToken);

    expect(replay.status).toBe(401);
    expect(errorOf(replay)).toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('given a used refresh token is replayed, when other sessions exist, then all of them end', async () => {
    /* A token coming back after rotation means either a replay or a copy in
       somebody else's hands, and there is no way to tell which. The safe reading is
       that the account is compromised, so every session for it stops — including
       the one on the attacker's machine. */
    const laptop = await signIn('hr.viewer@acme.test');
    const phone = await signIn('hr.viewer@acme.test');

    await refreshWith(laptop.refreshToken).expect(200);
    await refreshWith(laptop.refreshToken).expect(401);

    const phoneAfterwards = await refreshWith(phone.refreshToken);

    expect(phoneAfterwards.status).toBe(401);
  });

  it('given a logged-out token is presented again, when other sessions exist, then they survive', async () => {
    /* The counterpart to reuse detection, and the reason revocations record why
       they happened. A tab that wakes up and refreshes after another tab signed
       out is ordinary, not theft — treating it as theft would sign the person out
       of their phone because they closed a laptop tab. */
    const laptop = await signIn('employee@acme.test');
    const phone = await signIn('employee@acme.test');

    await request(harness.app)
      .post('/api/auth/logout')
      .set('Cookie', `${REFRESH_COOKIE_NAME}=${laptop.refreshToken}`)
      .expect(204);
    await refreshWith(laptop.refreshToken).expect(401);

    await refreshWith(phone.refreshToken).expect(200);
  });

  it('given the same refresh token used twice at once, when both arrive, then only one session is issued', async () => {
    /* Two tabs waking together, or a retry racing the original. Both read the token
       as live, so only the conditional UPDATE in the repository decides — without
       it, one token would mint two sessions and rotation would prove nothing. */
    const { refreshToken } = await signIn('manager@acme.test');

    const [first, second] = await Promise.all([
      refreshWith(refreshToken),
      refreshWith(refreshToken),
    ]);
    const statuses = [first.status, second.status].sort((a, b) => a - b);

    expect(statuses).toEqual([200, 401]);
  });

  it('given an expired refresh token, when refreshing, then it is refused', async () => {
    /* Its own harness: moving the clock is shared state, and a test that leaves it
       moved decides what the tests after it see. */
    const ageing = await createTestHarness();
    try {
      const login = await request(ageing.app)
        .post('/api/auth/login')
        .send({ email: 'hr.admin@acme.test', password: TEST_PASSWORD });
      const refreshToken = cookieValue(login, REFRESH_COOKIE_NAME) ?? '';

      // Past the 7-day lifetime, without a test that takes a week.
      ageing.clock.advanceDays(8);

      const response = await request(ageing.app)
        .post('/api/auth/refresh')
        .set('Cookie', `${REFRESH_COOKIE_NAME}=${refreshToken}`);

      expect(response.status).toBe(401);
    } finally {
      await ageing.close();
    }
  });

  it('given a refresh token one day short of expiry, when refreshing, then it still works', async () => {
    // The boundary from the other side, so the check above is not passing for the wrong reason.
    const ageing = await createTestHarness();
    try {
      const login = await request(ageing.app)
        .post('/api/auth/login')
        .send({ email: 'hr.admin@acme.test', password: TEST_PASSWORD });
      const refreshToken = cookieValue(login, REFRESH_COOKIE_NAME) ?? '';

      ageing.clock.advanceDays(6);

      const response = await request(ageing.app)
        .post('/api/auth/refresh')
        .set('Cookie', `${REFRESH_COOKIE_NAME}=${refreshToken}`);

      expect(response.status).toBe(200);
    } finally {
      await ageing.close();
    }
  });

  it.each([
    ['no cookie at all', undefined],
    ['an empty cookie', ''],
    ['a token that was never issued', 'not-a-real-token'],
  ])('given %s, when refreshing, then it is refused', async (_label, token) => {
    const pending = request(harness.app).post('/api/auth/refresh');
    const response = await (token === undefined
      ? pending
      : pending.set('Cookie', `${REFRESH_COOKIE_NAME}=${token}`));

    expect(response.status).toBe(401);
    expect(errorOf(response)).toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('given a signed-in session, when logging out, then the refresh token stops working', async () => {
    const { refreshToken } = await signIn('manager@acme.test');

    const loggedOut = await request(harness.app)
      .post('/api/auth/logout')
      .set('Cookie', `${REFRESH_COOKIE_NAME}=${refreshToken}`);

    expect(loggedOut.status).toBe(204);
    // Server-side, not merely dropped from the browser.
    await refreshWith(refreshToken).expect(401);
  });

  it('given a logout, when the response is read, then the cookie is cleared', async () => {
    const { refreshToken } = await signIn('manager@acme.test');

    const response = await request(harness.app)
      .post('/api/auth/logout')
      .set('Cookie', `${REFRESH_COOKIE_NAME}=${refreshToken}`);

    expect(cookieValue(response, REFRESH_COOKIE_NAME)).toBe('');
    expect(cookieFor(response, REFRESH_COOKIE_NAME)).toContain('Path=/api/auth');
  });

  it.each([
    ['no cookie', undefined],
    ['a token that was never issued', 'not-a-real-token'],
  ])('given %s, when logging out, then it still succeeds', async (_label, token) => {
    /* Logging out is not something a client should be able to fail at, and telling
       an unauthenticated caller whether a token existed is free information. */
    const pending = request(harness.app).post('/api/auth/logout');
    const response = await (token === undefined
      ? pending
      : pending.set('Cookie', `${REFRESH_COOKIE_NAME}=${token}`));

    expect(response.status).toBe(204);
  });

  it('given an already-used token, when logging out with it, then it still succeeds', async () => {
    const { refreshToken } = await signIn('employee@acme.test');
    await request(harness.app)
      .post('/api/auth/logout')
      .set('Cookie', `${REFRESH_COOKIE_NAME}=${refreshToken}`)
      .expect(204);

    await request(harness.app)
      .post('/api/auth/logout')
      .set('Cookie', `${REFRESH_COOKIE_NAME}=${refreshToken}`)
      .expect(204);
  });
});

describe('GET /api/auth/me', () => {
  let harness: TestHarness;

  beforeAll(async () => {
    harness = await createTestHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  it('given a valid access token, when asking who I am, then the account comes back without its hash', async () => {
    const login = await request(harness.app)
      .post('/api/auth/login')
      .send({ email: 'employee@acme.test', password: TEST_PASSWORD });

    const response = await request(harness.app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${accessTokenFrom(login)}`);

    expect(response.status).toBe(200);
    expect(bodyOf(response)).toEqual({
      user: {
        id: harness.accounts.employee.id,
        email: 'employee@acme.test',
        role: 'EMPLOYEE',
        employeeId: harness.accounts.employee.employeeId,
      },
    });
    expect(JSON.stringify(bodyOf(response))).not.toContain('argon2');
  });

  it('given the account is deleted while its token is still valid, when asking who I am, then it is refused', async () => {
    /* The token is signed and unexpired, so only re-reading the account catches
       this. A deleted login must not keep working for the rest of its 15 minutes. */
    const login = await request(harness.app)
      .post('/api/auth/login')
      .send({ email: 'hr.viewer@acme.test', password: TEST_PASSWORD });

    await harness.db.delete(users).where(eq(users.id, harness.accounts.hrViewer.id));

    const response = await request(harness.app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${accessTokenFrom(login)}`);

    expect(response.status).toBe(401);
  });
});
