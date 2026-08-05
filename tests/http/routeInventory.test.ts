import { readdirSync } from 'node:fs';
import type { Router } from 'express';
import request from 'supertest';
import { accessTokenFrom } from '../helpers/http';
import { createTestHarness, TEST_PASSWORD, type TestHarness } from '../helpers/testApp';

/**
 * Every endpoint, and what each one is allowed to be reached by.
 *
 * This file exists because of a question with an uncomfortable answer. Access control
 * here is thorough — the scope is applied inside the query, the aggregate screens
 * check `canSeeAggregates`, the writes sit behind `requireRole` — and every one of
 * those has a test. What none of them had was a test that *the next endpoint* has any
 * of it. Sixteen careful tests do not stop a seventeenth route shipping with no guard
 * at all, and nobody notices, because nothing was removed.
 *
 * So the routes are discovered rather than listed. Every module in `src/routes/` is
 * imported, its factory called with stub dependencies, and its registered paths read
 * off the router. A new endpoint anywhere — a new method on an existing router, or a
 * whole new router file — appears in that list on its own, and the first assertion
 * below fails until somebody has said in this table what it is for.
 *
 * Then each classification is *exercised* rather than trusted. Saying a route is
 * HR-only in a table proves nothing; the test signs in as a Manager and checks the
 * refusal actually arrives. Both halves matter: the table catches the endpoint
 * somebody forgot to think about, and the probe catches the one they thought about
 * and wired wrongly.
 */

/** What may reach an endpoint. */
type Access =
  /** No session of any kind. Signing in, and signing out. */
  | 'PUBLIC'
  /**
   * The refresh cookie, and specifically not an access token.
   *
   * Its own classification rather than "public", which it superficially resembles: it
   * refuses an anonymous caller like every guarded route, but the thing it demands is
   * the httpOnly cookie. An access token must not be accepted in its place — that
   * would let a token stolen from a page's memory mint fresh ones indefinitely, which
   * is the entire reason the refresh token lives somewhere JavaScript cannot read.
   */
  | 'REFRESH_COOKIE'
  /** Any signed-in user. What the caller may *see* is then narrowed by the scope. */
  | 'AUTHENTICATED'
  /** Both HR roles. Company-wide figures and reference data; refused for a Manager. */
  | 'HR'
  /** HR Admin alone. Everything that writes. */
  | 'HR_ADMIN';

interface RouteEntry {
  /**
   * The route as a URL, for the probe.
   *
   * The only thing an entry has to carry that its key does not: the key names the
   * router and the path *within* it, and the mount prefix lives in `app.ts`. A wrong
   * prefix here shows up as a 404 where the probe expected a 401, so it is checked by
   * being used rather than by a second assertion about itself.
   */
  url: string;
  access: Access;
}

/**
 * Keyed by exactly what discovery produces, so a mismatch names the route.
 *
 * The ids in the URLs need not exist: every refusal being checked happens before a
 * handler looks anything up, which is the property that makes one table cover twenty
 * routes without twenty fixtures.
 */
const INVENTORY: Record<string, RouteEntry> = {
  'auth.ts POST /login': { url: '/api/auth/login', access: 'PUBLIC' },
  'auth.ts POST /refresh': {
    url: '/api/auth/refresh',
    access: 'REFRESH_COOKIE',
  },
  /* Public on purpose, and it reads oddly until you try the alternative. Logging out
     with an expired token would then fail — leaving the cookie in place and the user
     signed in to a session they asked to end. It succeeds whatever is presented, and
     revokes whatever it was given. */
  'auth.ts POST /logout': {
    url: '/api/auth/logout',
    access: 'PUBLIC',
  },
  'auth.ts GET /me': { url: '/api/auth/me', access: 'AUTHENTICATED' },

  'bands.ts GET /': { url: '/api/bands', access: 'HR' },
  'bands.ts PUT /:jobLevelId/:country': {
    url: '/api/bands/1/GB',
    access: 'HR_ADMIN',
  },
  'bands.ts DELETE /:jobLevelId/:country': {
    url: '/api/bands/1/GB',
    access: 'HR_ADMIN',
  },

  'bulkRaise.ts POST /': { url: '/api/compensation/bulk', access: 'HR_ADMIN' },

  /* Any signed-in user, because the export is the list they are already looking at
     with the paging removed — same filters, same scope, so a Manager's file contains
     their team and nobody else. Restricting it to HR would mean the screen and the
     file disagreed about who may see what, and the version somebody trusts is
     whichever they used last. */
  'employeeCsv.ts GET /export': {
    url: '/api/employees/export',
    access: 'AUTHENTICATED',
  },
  'employeeCsv.ts POST /import': {
    url: '/api/employees/import',
    access: 'HR_ADMIN',
  },

  'employees.ts GET /': { url: '/api/employees', access: 'AUTHENTICATED' },
  'employees.ts POST /': { url: '/api/employees', access: 'HR_ADMIN' },
  /* Authenticated rather than HR: it is a list of people, so the scope narrows it the
     same way the main list is narrowed, and a Manager seeing their own team's gaps to
     band is the feature working. */
  'employees.ts GET /attention': {
    url: '/api/employees/attention',
    access: 'AUTHENTICATED',
  },
  'employees.ts GET /:id': { url: '/api/employees/1', access: 'AUTHENTICATED' },
  'employees.ts PATCH /:id/status': {
    url: '/api/employees/1/status',
    access: 'HR_ADMIN',
  },
  'employees.ts POST /:id/compensation': {
    url: '/api/employees/1/compensation',
    access: 'HR_ADMIN',
  },

  /* Departments, levels, countries, currencies. Reference data with nobody's name in
     it, so any signed-in user may read it — the filters on their own page need it. */
  'lookups.ts GET /': { url: '/api/lookups', access: 'AUTHENTICATED' },

  'statistics.ts GET /overview': {
    url: '/api/stats/overview',
    access: 'HR',
  },
  'statistics.ts GET /payroll-trend': {
    url: '/api/stats/payroll-trend',
    access: 'HR',
  },
  'statistics.ts GET /pay-gap': { url: '/api/stats/pay-gap', access: 'HR' },
};

interface RouteLayer {
  route?: { path: string; methods?: Record<string, boolean> };
}

/** The verbs this API uses. Supertest names its request methods the same way. */
const SUPPORTED_METHODS = ['get', 'post', 'patch', 'put', 'delete'] as const;

type SupportedMethod = (typeof SUPPORTED_METHODS)[number];

function isSupportedMethod(method: string | undefined): method is SupportedMethod {
  return SUPPORTED_METHODS.includes(method as never);
}

/**
 * Every route registered by every router module, found rather than listed.
 *
 * The dependencies are a proxy handing back a no-op for whatever is asked of it.
 * Nothing is called — the routers are built only to be read — so a stub that
 * satisfies every shape is exactly as much as this needs, and means a new dependency
 * on a router does not become a change here.
 */
async function discoverRoutes(): Promise<Set<string>> {
  const found = new Set<string>();
  const noop = (): void => undefined;
  const stubDeps: unknown = new Proxy({}, { get: () => noop });

  const files = readdirSync('src/routes')
    .filter((file) => file.endsWith('.ts'))
    .sort();

  for (const file of files) {
    const module = (await import(`../../src/routes/${file.replace('.ts', '')}`)) as Record<
      string,
      unknown
    >;
    const factory = Object.entries(module).find(
      (entry): entry is [string, (deps: unknown) => Router] =>
        typeof entry[1] === 'function' && /^create.*Router$/.test(entry[0]),
    )?.[1];

    // schemas.ts and anything else shared: no routes to classify.
    if (factory === undefined) {
      continue;
    }

    const router = factory(stubDeps);
    for (const layer of (router as unknown as { stack: RouteLayer[] }).stack) {
      if (layer.route === undefined) {
        continue;
      }
      for (const method of Object.keys(layer.route.methods ?? {})) {
        found.add(`${file} ${method.toUpperCase()} ${layer.route.path}`);
      }
    }
  }

  return found;
}

describe('every endpoint is classified and the classification holds', () => {
  let harness: TestHarness;
  let discovered: Set<string>;
  const tokens = new Map<string, string>();

  beforeAll(async () => {
    harness = await createTestHarness();
    discovered = await discoverRoutes();

    for (const email of ['hr.admin@acme.test', 'hr.viewer@acme.test', 'manager@acme.test']) {
      const login = await request(harness.app)
        .post('/api/auth/login')
        .send({ email, password: TEST_PASSWORD });
      tokens.set(email, accessTokenFrom(login));
    }
  });

  afterAll(async () => {
    await harness.close();
  });

  /**
   * The request an entry describes, with or without a session.
   *
   * The method comes out of the key, which is the only place it is written down. Narrowed
   * against supertest's own method names rather than indexed with a cast, so a key with a
   * verb nobody supports fails here instead of at `undefined is not a function`.
   */
  const send = (entry: RouteEntry, key: string, token?: string): request.Test => {
    const method = key.split(' ')[1]?.toLowerCase();
    if (!isSupportedMethod(method)) {
      throw new Error(`Unsupported method in ${key}.`);
    }

    const test = request(harness.app)[method](entry.url);
    return token === undefined ? test : test.set('Authorization', `Bearer ${token}`);
  };

  it('given the routers as they are registered, when they are read, then every route is in the inventory', () => {
    /* Both directions. A route missing from the table is an endpoint nobody has
       classified; a table entry with no route is a rule about something that no
       longer exists, which is worse than no rule because it reads like cover. */
    expect([...discovered].sort()).toEqual(Object.keys(INVENTORY).sort());
  });

  describe('without a session', () => {
    const entries = Object.entries(INVENTORY).filter(([, entry]) => entry.access !== 'PUBLIC');

    it.each(entries)('given no token, when %s is called, then it is 401', async (key, entry) => {
      const response = await send(entry, key);

      expect(response.status).toBe(401);
    });
  });

  describe('refreshing a session', () => {
    const entries = Object.entries(INVENTORY).filter(
      ([, entry]) => entry.access === 'REFRESH_COOKIE',
    );

    it.each(entries)(
      'given an access token instead of the cookie, when %s is called, then it is refused',
      async (key, entry) => {
        const response = await send(entry, key, tokens.get('manager@acme.test'));

        expect(response.status).toBe(401);
      },
    );
  });

  describe('as a Manager', () => {
    const entries = Object.entries(INVENTORY).filter(
      ([, entry]) => entry.access === 'HR' || entry.access === 'HR_ADMIN',
    );

    it.each(entries)(
      'given a Manager token, when %s is called, then it is refused',
      async (key, entry) => {
        const response = await send(entry, key, tokens.get('manager@acme.test'));

        expect(response.status).toBe(403);
      },
    );
  });

  describe('as HR Viewer', () => {
    const entries = Object.entries(INVENTORY).filter(([, entry]) => entry.access === 'HR_ADMIN');

    it.each(entries)(
      'given a read-only HR token, when %s is called, then the write is refused',
      async (key, entry) => {
        /* The role that is easiest to get wrong: it can see everything, so a guard
           written as "is this HR?" passes it, and a read-only account gets to change
           somebody's salary. */
        const response = await send(entry, key, tokens.get('hr.viewer@acme.test'));

        expect(response.status).toBe(403);
      },
    );
  });

  describe('as HR Admin', () => {
    const entries = Object.entries(INVENTORY).filter(
      ([, entry]) => entry.access !== 'PUBLIC' && entry.access !== 'REFRESH_COOKIE',
    );

    it.each(entries)(
      'given an HR Admin token, when %s is called, then it is not refused',
      async (key, entry) => {
        /* The other direction, and the reason the table cannot be satisfied by
           guarding everything: a route nobody can reach passes every test above.
           The bodies here are empty and most of these answer 400 or 404 — what
           matters is that none of them answers 403. */
        const response = await send(entry, key, tokens.get('hr.admin@acme.test'));

        expect(response.status).not.toBe(403);
        expect(response.status).not.toBe(401);
      },
    );
  });

  describe('the public endpoints', () => {
    const entries = Object.entries(INVENTORY).filter(([, entry]) => entry.access === 'PUBLIC');

    it.each(entries)(
      'given no token, when %s is called, then it is answered rather than refused',
      async (key, entry) => {
        /* So "PUBLIC" in the table above means something. Without this, moving a
           route to that classification would be a way to make its row stop being
           checked at all. */
        const response = await send(entry, key);

        expect(response.status).not.toBe(401);
      },
    );
  });
});
