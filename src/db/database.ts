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
