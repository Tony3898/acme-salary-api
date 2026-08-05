import { readFileSync, readdirSync } from 'node:fs';
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
  access: Access;
  /**
   * Set where a 404 is a legitimate answer, not a wrong URL.
   *
   * Every probe otherwise asserts the route was *reached*, because the whole point of
   * deriving URLs below is that a request can no longer miss. Two routes address a pay
   * band that the harness does not seed, so for them "no such thing" is the handler
   * working and the assertion has to be given up — named here rather than dropped
   * quietly, so the exception is a decision somebody made and not a gap.
   */
  absentIsFine?: true;
}

/**
 * Keyed by exactly what discovery produces, so a mismatch names the route.
 *
 * The key is the router file's path **relative to `src/routes`**, not its basename:
 * discovery walks subdirectories, and two files called `bands.ts` in different folders
 * would otherwise collide into one entry and hide a route behind another route's
 * classification.
 *
 * There are no URLs here. They are built from the mount prefix in `app.ts` and the path
 * the router itself registers, so a table entry and the request that tests it cannot
 * disagree — see `discoverRoutes`.
 */
const INVENTORY: Record<string, RouteEntry> = {
  'auth.ts POST /login': { access: 'PUBLIC' },
  'auth.ts POST /refresh': { access: 'REFRESH_COOKIE' },
  /* Public on purpose, and it reads oddly until you try the alternative. Logging out
     with an expired token would then fail — leaving the cookie in place and the user
     signed in to a session they asked to end. It succeeds whatever is presented, and
     revokes whatever it was given. */
  'auth.ts POST /logout': { access: 'PUBLIC' },
  'auth.ts GET /me': { access: 'AUTHENTICATED' },

  'bands.ts GET /': { access: 'HR' },
  'bands.ts PUT /:jobLevelId/:country': { access: 'HR_ADMIN', absentIsFine: true },
  'bands.ts DELETE /:jobLevelId/:country': { access: 'HR_ADMIN', absentIsFine: true },

  'bulkRaise.ts POST /': { access: 'HR_ADMIN' },

  /* Any signed-in user, because the export is the list they are already looking at
     with the paging removed — same filters, same scope, so a Manager's file contains
     their team and nobody else. Restricting it to HR would mean the screen and the
     file disagreed about who may see what, and the version somebody trusts is
     whichever they used last. */
  'employeeCsv.ts GET /export': { access: 'AUTHENTICATED' },
  'employeeCsv.ts POST /import': { access: 'HR_ADMIN' },

  'employees.ts GET /': { access: 'AUTHENTICATED' },
  'employees.ts POST /': { access: 'HR_ADMIN' },
  /* Authenticated rather than HR: it is a list of people, so the scope narrows it the
     same way the main list is narrowed, and a Manager seeing their own team's gaps to
     band is the feature working. */
  'employees.ts GET /attention': { access: 'AUTHENTICATED' },
  'employees.ts GET /:id': { access: 'AUTHENTICATED' },
  'employees.ts PATCH /:id/status': { access: 'HR_ADMIN' },
  'employees.ts POST /:id/compensation': { access: 'HR_ADMIN' },

  /* Departments, levels, countries, currencies. Reference data with nobody's name in
     it, so any signed-in user may read it — the filters on their own page need it. */
  'lookups.ts GET /': { access: 'AUTHENTICATED' },

  'statistics.ts GET /overview': { access: 'HR' },
  'statistics.ts GET /payroll-trend': { access: 'HR' },
  'statistics.ts GET /pay-gap': { access: 'HR' },
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

/** A route as discovered: where it is written, and the URL that actually reaches it. */
interface DiscoveredRoute {
  method: SupportedMethod;
  /** `/api/employees/:id` — the mount prefix and the router's own path, joined. */
  template: string;
}

/**
 * Where each router is mounted, read out of `app.ts` rather than written down twice.
 *
 * The prefix is the half of a URL that lives outside the router, so a table here would
 * be a second copy of it — and the failure a second copy produces is the quiet one:
 * the request goes somewhere that does not exist, the response is a 404, and a probe
 * asking only "not 403" counts that as the route being reachable.
 *
 * Matched off the source because a mounted Express router does not remember the string
 * it was mounted with — only a compiled matcher. Reading `app.use('<prefix>',
 * create<X>Router(` gives the mapping directly, and a router mounted some other way
 * fails loudly below rather than silently going unprobed.
 */
function mountPrefixes(): Map<string, string> {
  const source = readFileSync('src/app.ts', 'utf8');
  const mounts = source.matchAll(/app\.use\(\s*'([^']+)',\s*(create\w*Router)\(/g);

  return new Map([...mounts].map(([, prefix, factory]) => [factory as string, prefix as string]));
}

/**
 * Every route registered by every router module, found rather than listed.
 *
 * Recursive on purpose. Reading only the top level of `src/routes` meant a router in a
 * subdirectory was never discovered, so it was never missing from the inventory either
 * — the comparison below was between two sets that both left it out, and it passed. A
 * route with no guard at all could ship green through the one test written to stop it.
 *
 * The dependencies are a proxy handing back a no-op for whatever is asked of it.
 * Nothing is called — the routers are built only to be read — so a stub that
 * satisfies every shape is exactly as much as this needs, and means a new dependency
 * on a router does not become a change here.
 */
async function discoverRoutes(): Promise<Map<string, DiscoveredRoute>> {
  const found = new Map<string, DiscoveredRoute>();
  const noop = (): void => undefined;
  const stubDeps: unknown = new Proxy({}, { get: () => noop });
  const prefixes = mountPrefixes();

  /* `recursive` returns paths with the platform's separator. Normalised to `/` so the
     keys are the same on every machine, and so they read as the paths they are. */
  const files = readdirSync('src/routes', { recursive: true })
    .map((entry) => String(entry).replaceAll('\\', '/'))
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
    );

    // schemas.ts and anything else shared: no routes to classify.
    if (factory === undefined) {
      continue;
    }

    const [factoryName, build] = factory;
    const prefix = prefixes.get(factoryName);

    const router = build(stubDeps);
    for (const layer of (router as unknown as { stack: RouteLayer[] }).stack) {
      if (layer.route === undefined) {
        continue;
      }
      for (const method of Object.keys(layer.route.methods ?? {})) {
        if (!isSupportedMethod(method)) {
          throw new Error(
            `${file} registers ${method.toUpperCase()}, which nothing here can send.`,
          );
        }

        /* A router file that `app.ts` never mounts is unreachable today and one line
           from being reachable tomorrow, so it is a failure rather than a skip — and
           the key is still recorded, so the inventory comparison names it too. */
        if (prefix === undefined) {
          throw new Error(
            `${file} exports ${factoryName}, which app.ts never mounts. Mount it or delete it.`,
          );
        }

        // `/api/bands` + `/` is `/api/bands`, not `/api/bands/`.
        const path = layer.route.path === '/' ? '' : layer.route.path;
        found.set(`${file} ${method.toUpperCase()} ${layer.route.path}`, {
          method,
          template: `${prefix}${path}`,
        });
      }
    }
  }

  return found;
}

describe('every endpoint is classified and the classification holds', () => {
  let harness: TestHarness;
  let discovered: Map<string, DiscoveredRoute>;
  let paramValues: Record<string, string>;
  const tokens = new Map<string, string>();

  beforeAll(async () => {
    harness = await createTestHarness();
    discovered = await discoverRoutes();

    /* A real id, not `1`. `/api/employees/:id` answers 404 for somebody who does not
       exist, and that is correct — which is why the probes below could not tell a
       missing person from a missing route until the id pointed at a seeded one. */
    paramValues = {
      id: String(harness.accounts.manager.employeeId),
      jobLevelId: '1',
      country: 'GB',
    };

    for (const email of [
      'hr.admin@acme.test',
      'hr.viewer@acme.test',
      'manager@acme.test',
      'employee@acme.test',
    ]) {
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
   * Method and URL both come from discovery, so neither is written down twice and a
   * probe cannot be pointed at a URL the application does not serve.
   */
  const send = (key: string, token?: string, params: Record<string, string> = {}): request.Test => {
    const route = discovered.get(key);
    if (route === undefined) {
      throw new Error(`${key} is in the inventory but no router registers it.`);
    }

    const url = route.template.replaceAll(/:(\w+)/g, (_match, name: string) => {
      const value = params[name] ?? paramValues[name];
      if (value === undefined) {
        throw new Error(`No value for :${name} in ${route.template}. Add one to paramValues.`);
      }
      return value;
    });

    const test = request(harness.app)[route.method](url);
    return token === undefined ? test : test.set('Authorization', `Bearer ${token}`);
  };

  /** Every probe that expects to be *answered* also expects to have arrived somewhere. */
  const expectReached = (status: number, entry: RouteEntry): void => {
    if (entry.absentIsFine !== true) {
      expect(status).not.toBe(404);
    }
  };

  it('given the routers as they are registered, when they are read, then every route is in the inventory', () => {
    /* Both directions. A route missing from the table is an endpoint nobody has
       classified; a table entry with no route is a rule about something that no
       longer exists, which is worse than no rule because it reads like cover. */
    expect([...discovered.keys()].sort()).toEqual(Object.keys(INVENTORY).sort());
  });

  describe('without a session', () => {
    const entries = Object.entries(INVENTORY).filter(([, entry]) => entry.access !== 'PUBLIC');

    it.each(entries)('given no token, when %s is called, then it is 401', async (key) => {
      const response = await send(key);

      expect(response.status).toBe(401);
    });
  });

  describe('refreshing a session', () => {
    const entries = Object.entries(INVENTORY).filter(
      ([, entry]) => entry.access === 'REFRESH_COOKIE',
    );

    it.each(entries)(
      'given an access token instead of the cookie, when %s is called, then it is refused',
      async (key) => {
        const response = await send(key, tokens.get('manager@acme.test'));

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
      async (key) => {
        const response = await send(key, tokens.get('manager@acme.test'));

        expect(response.status).toBe(403);
      },
    );
  });

  describe('as HR Viewer', () => {
    const entries = Object.entries(INVENTORY).filter(([, entry]) => entry.access === 'HR_ADMIN');

    it.each(entries)(
      'given a read-only HR token, when %s is called, then the write is refused',
      async (key) => {
        /* The role that is easiest to get wrong: it can see everything, so a guard
           written as "is this HR?" passes it, and a read-only account gets to change
           somebody's salary. */
        const response = await send(key, tokens.get('hr.viewer@acme.test'));

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
           The bodies here are empty and most of these answer 400 — what matters is
           that none of them answers 403, and that the request arrived at all. */
        const response = await send(key, tokens.get('hr.admin@acme.test'));

        expect(response.status).not.toBe(403);
        expect(response.status).not.toBe(401);
        expectReached(response.status, entry);
      },
    );
  });

  describe('as an Employee', () => {
    const entries = Object.entries(INVENTORY).filter(
      ([, entry]) => entry.access === 'AUTHENTICATED',
    );

    it.each(entries)(
      'given an Employee token, when %s is called, then it is reached rather than refused',
      async (key, entry) => {
        /* The claim "AUTHENTICATED" makes is that these are open to every role and the
           scope narrows them in SQL — a Manager gets their team, an Employee gets
           themselves. Probing only as HR Admin leaves that claim untested from the
           bottom: a `requireRole` excluding Employee could be added to any of these and
           every other test here would still pass. This is the assertion that would not.

           Their own id, because the scope answers 404 rather than 403 for a person
           outside it — deliberately, so a refusal does not confirm that somebody
           exists. Probing with the manager's id would make that correct 404 look
           like the unreachable route this is trying to detect. */
        const response = await send(key, tokens.get('employee@acme.test'), {
          id: String(harness.accounts.employee.employeeId),
        });

        expect(response.status).not.toBe(401);
        expect(response.status).not.toBe(403);
        expectReached(response.status, entry);
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
        const response = await send(key);

        expect(response.status).not.toBe(401);
        expectReached(response.status, entry);
      },
    );
  });
});
