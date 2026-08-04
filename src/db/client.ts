import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool, types } from 'pg';
import { config } from '../config';
import * as schema from './schema';

/** Postgres OID for bigint. */
const PG_INT8 = 20;

/**
 * node-postgres returns bigint as a string, while PGlite returns a number — so
 * without this, tests would pass on one shape and production would receive the
 * other. Safe because amounts are capped at MAX_AMOUNT_MINOR by a check
 * constraint in schema.ts.
 *
 * `numeric` is deliberately left as a string: exchange rates keep full precision
 * and are multiplied by Postgres, never by JS.
 */
types.setTypeParser(PG_INT8, Number);

/**
 * One pool for the process. A long-lived Express server holds its connections
 * open, which is the main reason this runs on a server rather than as functions.
 */
export const pool = new Pool({
  connectionString: config.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

// An idle client erroring must not take the process down with an unhandled event.
pool.on('error', (error) => {
  console.error('Idle database client error:', error.message);
});

export const db = drizzle({ client: pool, schema });

export async function closeDatabase(): Promise<void> {
  await pool.end();
}
