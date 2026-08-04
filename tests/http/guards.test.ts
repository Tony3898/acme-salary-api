import express, { type Express } from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { HTTP_STATUS } from '../../src/errors';
import { accessTokenFrom, bodyOf, errorOf } from '../helpers/http';
import { errorHandler, notFoundHandler } from '../../src/middleware/errorHandler';
import { authContext, requireAuth } from '../../src/middleware/requireAuth';
import { requireRole } from '../../src/middleware/requireRole';
import { signAccessToken } from '../../src/domain/tokens';
import { createTestHarness, TEST_JWT_SECRET, TEST_ORIGIN, TEST_PASSWORD } from '../helpers/testApp';

const HR_ADMIN_CLAIMS = { userId: 1, role: 'HR_ADMIN', employeeId: null } as const;
const MANAGER_CLAIMS = { userId: 3, role: 'MANAGER', employeeId: 7 } as const;

/**
 * The guards on their own, over a stub route.
 *
 * Assembled here rather than tested through a real endpoint so that each rejection
 * is attributable to one middleware. The endpoints these will protect arrive with
 * the employee list; the guard behaviour is settled first.
 */
function guardedApp(): Express {
  const app = express();

  app.get('/protected', requireAuth(TEST_JWT_SECRET), (req, res) => {
    res.status(HTTP_STATUS.OK).json({ seenBy: authContext(req).role });
  });

  app.get(
    '/hr-only',
    requireAuth(TEST_JWT_SECRET),
    requireRole('HR_ADMIN', 'HR_VIEWER'),
    (_req, res) => {
      res.status(HTTP_STATUS.OK).json({ ok: true });
    },
  );

  // A route with no guard in front of it, to prove a wiring mistake is not silent.
  app.get('/unguarded', (req, res) => {
    res.status(HTTP_STATUS.OK).json({ role: authContext(req).role });
  });

  app.get('/broken', () => {
    throw new Error('database exploded while reading table salaries for user 42');
  });

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

describe('requireAuth', () => {
  const app = guardedApp();

  it('given a valid token, when calling a protected route, then the claims reach the handler', async () => {
    const token = signAccessToken(HR_ADMIN_CLAIMS, TEST_JWT_SECRET, 15);

    const response = await request(app).get('/protected').set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(bodyOf(response)).toEqual({ seenBy: 'HR_ADMIN' });
  });

  it.each([
    ['no Authorization header', undefined],
    ['an empty header', ''],
    ['a bare token with no scheme', 'aaa.bbb.ccc'],
    ['the wrong scheme', 'Basic YWRtaW46YWRtaW4='],
    ['Bearer with nothing after it', 'Bearer '],
    ['Bearer with two values', 'Bearer aaa.bbb.ccc extra'],
    ['a lowercase scheme', 'bearer aaa.bbb.ccc'],
  ])('given %s, when calling a protected route, then it is refused', async (_label, header) => {
    const pending = request(app).get('/protected');
    const response = await (header === undefined ? pending : pending.set('Authorization', header));

    expect(response.status).toBe(401);
    expect(errorOf(response)).toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('given tokens that are invalid in different ways, when calling a protected route, then the answer is always the same', async () => {
    /* Expired, forged and nonsense must be indistinguishable. A different message
       for each would tell an attacker which part of the token to work on next. */
    const expired = jwt.sign(HR_ADMIN_CLAIMS, TEST_JWT_SECRET, {
      algorithm: 'HS256',
      expiresIn: '-1s',
    });
    const anotherSecret = signAccessToken(HR_ADMIN_CLAIMS, 'a'.repeat(32), 15);
    const unsigned = jwt.sign(HR_ADMIN_CLAIMS, '', { algorithm: 'none' });
    const scopedWithoutEmployee = jwt.sign(
      { userId: 3, role: 'MANAGER', employeeId: null },
      TEST_JWT_SECRET,
      { algorithm: 'HS256', expiresIn: '15m' },
    );

    const responses = await Promise.all(
      [expired, anotherSecret, unsigned, scopedWithoutEmployee, 'garbage'].map((token) =>
        request(app).get('/protected').set('Authorization', `Bearer ${token}`),
      ),
    );

    for (const response of responses) {
      expect(response.status).toBe(401);
      expect(bodyOf(response)).toEqual({
        error: { code: 'UNAUTHENTICATED', message: 'Sign in to continue.' },
      });
    }
  });
});

describe('requireRole', () => {
  const app = guardedApp();

  it.each(['HR_ADMIN', 'HR_VIEWER'] as const)(
    'given a %s token, when calling an HR route, then it is allowed',
    async (role) => {
      const token = signAccessToken({ userId: 1, role, employeeId: null }, TEST_JWT_SECRET, 15);

      await request(app).get('/hr-only').set('Authorization', `Bearer ${token}`).expect(200);
    },
  );

  it('given a Manager token, when calling an HR route, then it is refused as forbidden', async () => {
    /* 403 and not 404: the caller is authenticated, and pretending the route does
       not exist would make a genuine permission problem look like a bug. */
    const token = signAccessToken(MANAGER_CLAIMS, TEST_JWT_SECRET, 15);

    const response = await request(app).get('/hr-only').set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(403);
    expect(errorOf(response)).toMatchObject({ code: 'FORBIDDEN' });
  });

  it('given no token, when calling a role-restricted route, then it is refused before the role is considered', async () => {
    const response = await request(app).get('/hr-only');

    expect(errorOf(response)).toMatchObject({ code: 'UNAUTHENTICATED' });
  });
});

describe('error handling', () => {
  const app = guardedApp();

  it('given a route with no auth middleware, when it reads the claims, then the mistake surfaces as a server error', async () => {
    /* A wiring slip must not let a request run with no identity. It fails loudly
       and the reason stays in the log. */
    const logged = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    const response = await request(app).get('/unguarded');

    expect(response.status).toBe(500);
    expect(logged).toHaveBeenCalled();
  });

  it('given an unexpected failure, when it is returned, then the detail is logged and not sent', async () => {
    /* A database message carries table names, SQL and sometimes the values being
       written. The client gets none of it. */
    const logged = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    const response = await request(app).get('/broken');

    expect(response.status).toBe(500);
    expect(bodyOf(response)).toEqual({
      error: { code: 'INTERNAL', message: 'Something went wrong. Please try again.' },
    });
    expect(JSON.stringify(bodyOf(response))).not.toContain('salaries');
    expect(String(logged.mock.calls[0]?.[0])).toContain('salaries');
  });

  it('given a URL that matches nothing, when it is requested, then the failure has the usual shape', async () => {
    const response = await request(app).get('/no-such-thing');

    expect(response.status).toBe(404);
    expect(bodyOf(response)).toEqual({ error: { code: 'NOT_FOUND', message: 'No such endpoint.' } });
  });
});

describe('the application shell', () => {
  it('given a request from the configured origin, when it is answered, then credentials are allowed', async () => {
    const harness = await createTestHarness();
    try {
      const response = await request(harness.app).get('/health').set('Origin', TEST_ORIGIN);

      expect(response.status).toBe(200);
      expect(response.headers['access-control-allow-origin']).toBe(TEST_ORIGIN);
      expect(response.headers['access-control-allow-credentials']).toBe('true');
    } finally {
      await harness.close();
    }
  });

  it('given a request from an origin that is not configured, when it is answered, then no CORS permission is granted', async () => {
    /* An exact allowlist, not a wildcard: a cookie is sent with these requests, and
       a wildcard cannot be combined with credentials. */
    const harness = await createTestHarness();
    try {
      const response = await request(harness.app)
        .get('/health')
        .set('Origin', 'https://not-acme.example');

      expect(response.headers['access-control-allow-origin']).toBeUndefined();
    } finally {
      await harness.close();
    }
  });

  it('given any response, when its headers are read, then the security headers are set and the server is not advertised', async () => {
    const harness = await createTestHarness();
    try {
      const response = await request(harness.app).get('/health');

      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['strict-transport-security']).toContain('max-age=');
      expect(response.headers['x-powered-by']).toBeUndefined();
    } finally {
      await harness.close();
    }
  });

  it('given a body larger than the limit, when it is posted, then it is refused rather than parsed', async () => {
    const harness = await createTestHarness();
    try {
      const response = await request(harness.app)
        .post('/api/auth/login')
        .set('Content-Type', 'application/json')
        .send(JSON.stringify({ email: 'a@b.test', password: 'x'.repeat(200_000) }));

      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).not.toBe(200);
    } finally {
      await harness.close();
    }
  });

  it('given a valid login, when the whole flow runs through the real app, then it works end to end', async () => {
    /* One test over the assembled application: container, middleware order, routes
       and error handler as the server builds them. */
    const harness = await createTestHarness();
    try {
      const login = await request(harness.app)
        .post('/api/auth/login')
        .send({ email: 'hr.admin@acme.test', password: TEST_PASSWORD });

      const me = await request(harness.app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${accessTokenFrom(login)}`);

      expect(me.status).toBe(200);
      expect(bodyOf(me)['user']).toMatchObject({ role: 'HR_ADMIN' });
    } finally {
      await harness.close();
    }
  });
});
