import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import type * as schema from './schema';

/**
 * A Drizzle handle on this schema, whichever driver is behind it.
 *
 * Repositories, the seed and the tests all take this rather than a concrete
 * driver type, so the same code runs against node-postgres in production and
 * PGlite in tests. Declared here rather than in client.ts because importing that
 * module constructs a connection pool.
 */
export type Database = PgDatabase<PgQueryResultHKT, typeof schema>;

/**
 * A connection plus the means to release it. Held by the container, which closes
 * it on shutdown; tests supply their own so nothing opens a real pool.
 */
export interface DatabaseHandle {
  db: Database;
  /* A property rather than a method: it is a closure over the pool and carries no
     `this`, so passing it straight to `.finally(close)` is safe. */
  close: () => Promise<void>;
}
