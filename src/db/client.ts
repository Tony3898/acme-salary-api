import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool, types } from 'pg';
import type { DatabaseHandle } from './database';
import * as schema from './schema';

/** Postgres OID for bigint. */
const PG_INT8 = 20;

/** One pool holds up to this many server connections. */
const MAX_POOL_CLIENTS = 10;
const IDLE_TIMEOUT_MS = 30_000;
const CONNECTION_TIMEOUT_MS = 5_000;

/**
 * node-postgres returns bigint as a string, while PGlite returns a number — so
 * without this, tests would pass on one shape and production would receive the
 * other. Safe because amounts are capped at MAX_AMOUNT_MINOR by a check
 * constraint in schema.ts.
 *
 * Process-wide by design: the driver has one parser table, and every connection
 * this process opens must decode bigint the same way.
 *
 * `numeric` is deliberately left as a string: exchange rates keep full precision
 * and are multiplied by Postgres, never by JS.
 */
types.setTypeParser(PG_INT8, Number);

/**
 * The node-postgres flavour of `DatabaseHandle`, keeping the concrete driver type
 * for the few callers that need driver-specific results — the verification script
 * reads `QueryResult.rows` directly. Everything else takes the abstract
 * `Database`, which PGlite also satisfies.
 */
export interface PostgresDatabaseHandle extends DatabaseHandle {
  db: NodePgDatabase<typeof schema>;
}

/**
 * Opens a connection pool.
 *
 * Called exactly once per process, from the composition root in container.ts —
 * never at import time. A pool created as a module side effect connects to a
 * database merely because something imported a type from nearby, which is how a
 * test run or a CLI script ends up holding a production connection.
 *
 * A long-lived Express server keeping its connections open is the main reason
 * this runs on a server rather than as functions.
 */
export function createDatabase(connectionString: string): PostgresDatabaseHandle {
  const pool = new Pool({
    connectionString,
    max: MAX_POOL_CLIENTS,
    idleTimeoutMillis: IDLE_TIMEOUT_MS,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
  });

  // An idle client erroring must not take the process down with an unhandled event.
  pool.on('error', (error) => {
    console.error('Idle database client error:', error.message);
  });

  return {
    db: drizzle({ client: pool, schema }),
    close: () => pool.end(),
  };
}
