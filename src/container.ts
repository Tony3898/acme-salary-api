import { createDatabase } from './db/client';
import type { Database, DatabaseHandle } from './db/database';
import { createAuthService, type AuthService } from './services/auth';
import { createEmployeeService, type EmployeeService } from './services/employees';
import { createLookupService, type LookupService } from './services/lookups';
import { createStatisticsService, type StatisticsService } from './services/statistics';

/**
 * The composition root: one connection pool and one instance of each service,
 * built once when the process starts and handed to everything that needs them.
 *
 * Why a factory rather than `export const auth = ...`:
 *
 * - A module-level instance is created by whoever imports the module first, which
 *   in a test run is whichever file Jest happened to load — connecting to the real
 *   database as a side effect of an import.
 * - Two test files sharing one instance share its state, so a test can pass or
 *   fail depending on what ran before it.
 * - Dependencies become invisible. A function reaching for a global connection
 *   cannot be given a different one, so it cannot be tested without the real
 *   database behind it.
 *
 * `createContainer` is called exactly once in server.ts. Tests build their own
 * with an in-process Postgres. Nothing else constructs a service.
 *
 * The rule that keeps this safe: **services hold dependencies, never request
 * state.** No current user, no request id, no open transaction on a service —
 * every request would see it. Per-request values travel on the request; a
 * transaction is passed to the repository call that needs it.
 */

export interface ContainerConfig {
  databaseUrl: string;
  jwtSecret: string;
  accessTokenTtlMinutes: number;
  refreshTokenTtlDays: number;
}

export interface ContainerOverrides {
  /**
   * Supplied by tests, which run against an in-process Postgres. When present, no
   * pool is opened and `databaseUrl` is not read at all.
   */
  database?: DatabaseHandle;
  /** Injected so a test can move time without waiting for it. */
  now?: () => Date;
  /** Shortened by tests that are about expiry rather than about the data. */
  lookupTtlMs?: number;
}

export interface Container {
  readonly db: Database;
  readonly auth: AuthService;
  readonly employees: EmployeeService;
  readonly lookups: LookupService;
  readonly statistics: StatisticsService;
  /** Releases everything the container opened. Called once, on shutdown. */
  close: () => Promise<void>;
}

export function createContainer(
  config: ContainerConfig,
  overrides: ContainerOverrides = {},
): Container {
  const database = overrides.database ?? createDatabase(config.databaseUrl);
  const now = overrides.now ?? (() => new Date());

  const auth = createAuthService({
    db: database.db,
    jwtSecret: config.jwtSecret,
    accessTokenTtlMinutes: config.accessTokenTtlMinutes,
    refreshTokenTtlDays: config.refreshTokenTtlDays,
    now,
  });

  const employees = createEmployeeService({ db: database.db, now });

  const lookups = createLookupService({
    db: database.db,
    // The cache works in milliseconds; the same clock, read differently.
    now: () => now().getTime(),
    ttlMs: overrides.lookupTtlMs,
  });

  const statistics = createStatisticsService({ db: database.db, now });

  return {
    db: database.db,
    auth,
    employees,
    lookups,
    statistics,
    close: () => database.close(),
  };
}
