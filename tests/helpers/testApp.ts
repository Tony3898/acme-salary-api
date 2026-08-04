import type { Express } from 'express';
import { createApp, type AppOptions } from '../../src/app';
import { createContainer, type Container } from '../../src/container';
import { departments, employees, jobLevels, users } from '../../src/db/schema';
import { hashPassword } from '../../src/domain/password';
import type { Role } from '../../src/domain/roles';
import { createTestDatabaseHandle, type TestDb } from './testDb';

/**
 * A running app over an in-process Postgres.
 *
 * The app is built through the same container the server uses, so these tests
 * cover the real wiring — middleware order, error handling, cookie flags — rather
 * than a hand-assembled imitation that could agree with the code and disagree
 * with production.
 */

/** Long enough for the config minimum. Not a secret; it exists for one test run. */
export const TEST_JWT_SECRET = 'test-secret-that-is-long-enough-32';
export const TEST_PASSWORD = 'CorrectHorse!7';
export const TEST_ORIGIN = 'http://localhost:5173';

const ACCESS_TOKEN_TTL_MINUTES = 15;
const REFRESH_TOKEN_TTL_DAYS = 7;
/** High by default, so only the test that is about rate limiting ever hits it. */
const UNLIMITED = 10_000;

export interface TestAccount {
  id: number;
  email: string;
  role: Role;
  employeeId: number | null;
}

export interface TestAccounts {
  hrAdmin: TestAccount;
  hrViewer: TestAccount;
  manager: TestAccount;
  employee: TestAccount;
}

/** Time under the test's control, so an expiry can be reached without waiting. */
export interface TestClock {
  now: () => Date;
  advanceDays: (days: number) => void;
}

export interface TestHarness {
  app: Express;
  db: TestDb;
  container: Container;
  accounts: TestAccounts;
  clock: TestClock;
  close: () => Promise<void>;
}

export interface TestHarnessOptions {
  rateLimits?: Partial<AppOptions['rateLimits']>;
  secureCookies?: boolean;
  trustProxyHops?: number;
}

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

export async function createTestHarness(options: TestHarnessOptions = {}): Promise<TestHarness> {
  const database = await createTestDatabaseHandle();
  const accounts = await seedAccounts(database.db);

  let currentTime = new Date('2026-08-04T09:00:00.000Z');
  const clock: TestClock = {
    now: () => currentTime,
    advanceDays: (days) => {
      currentTime = new Date(currentTime.getTime() + days * MILLISECONDS_PER_DAY);
    },
  };

  const container = createContainer(
    {
      /* Never read: the database override is supplied, so no pool is opened. A
         value that would fail to connect is deliberate — if this string were ever
         used, the test should break rather than reach a real server. */
      databaseUrl: 'postgresql://unused-in-tests',
      jwtSecret: TEST_JWT_SECRET,
      accessTokenTtlMinutes: ACCESS_TOKEN_TTL_MINUTES,
      refreshTokenTtlDays: REFRESH_TOKEN_TTL_DAYS,
    },
    { database, now: clock.now },
  );

  const app = createApp({
    container,
    jwtSecret: TEST_JWT_SECRET,
    corsOrigins: [TEST_ORIGIN],
    secureCookies: options.secureCookies ?? false,
    trustProxyHops: options.trustProxyHops ?? 0,
    rateLimits: {
      windowMinutes: 15,
      loginMaxRequests: UNLIMITED,
      refreshMaxRequests: UNLIMITED,
      ...options.rateLimits,
    },
  });

  return { app, db: database.db, container, accounts, clock, close: () => container.close() };
}

/**
 * One login per role, with the two scoped roles attached to related people: the
 * employee reports to the manager, which is what makes an access-scope difference
 * visible later.
 */
async function seedAccounts(db: TestDb): Promise<TestAccounts> {
  const [department] = await db.insert(departments).values({ name: 'Engineering' }).returning();
  const [level] = await db.insert(jobLevels).values({ name: 'Senior', rank: 3 }).returning();

  if (!department || !level) {
    throw new Error('Failed to seed lookup rows.');
  }

  const [managerPerson] = await db
    .insert(employees)
    .values({
      fullName: 'Ada Team-Lead',
      email: 'ada.lead@acme.test',
      country: 'GB',
      departmentId: department.id,
      jobLevelId: level.id,
      hireDate: '2020-01-06',
    })
    .returning();

  if (!managerPerson) {
    throw new Error('Failed to seed the manager.');
  }

  const [reportPerson] = await db
    .insert(employees)
    .values({
      fullName: 'Grace Report',
      email: 'grace.report@acme.test',
      country: 'GB',
      departmentId: department.id,
      jobLevelId: level.id,
      hireDate: '2023-03-01',
      managerId: managerPerson.id,
    })
    .returning();

  if (!reportPerson) {
    throw new Error('Failed to seed the report.');
  }

  // Hashed once: argon2 is deliberately slow, and four identical hashes prove nothing.
  const passwordHash = await hashPassword(TEST_PASSWORD);

  const inserted = await db
    .insert(users)
    .values([
      { email: 'hr.admin@acme.test', passwordHash, role: 'HR_ADMIN' },
      { email: 'hr.viewer@acme.test', passwordHash, role: 'HR_VIEWER' },
      { email: 'manager@acme.test', passwordHash, role: 'MANAGER', employeeId: managerPerson.id },
      { email: 'employee@acme.test', passwordHash, role: 'EMPLOYEE', employeeId: reportPerson.id },
    ])
    .returning({
      id: users.id,
      email: users.email,
      role: users.role,
      employeeId: users.employeeId,
    });

  const byRole = new Map(inserted.map((account) => [account.role, account]));
  const require = (role: Role): TestAccount => {
    const account = byRole.get(role);
    if (!account) {
      throw new Error(`Failed to seed the ${role} account.`);
    }
    return account;
  };

  return {
    hrAdmin: require('HR_ADMIN'),
    hrViewer: require('HR_VIEWER'),
    manager: require('MANAGER'),
    employee: require('EMPLOYEE'),
  };
}
