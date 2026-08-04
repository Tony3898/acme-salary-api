import type { SQL } from 'drizzle-orm';
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
 * Rows from a raw query, as an array.
 *
 * `execute` is typed against the concrete driver, so on the shared `Database`
 * type its result is opaque — and the two drivers do not agree on the wrapper:
 * node-postgres returns a `QueryResult` with `.rows`, and a driver returning the
 * array directly is equally valid. Both shapes are handled here rather than in
 * every statistics query.
 *
 * The caller states the row type. Nothing validates it, so the SELECT list and
 * that type have to be read together — the price of the raw SQL the percentiles
 * and recursive lookups need.
 */
export async function rawRows<TRow>(db: Database, query: SQL): Promise<TRow[]> {
  const result: unknown = await db.execute(query);

  if (Array.isArray(result)) {
    return result as TRow[];
  }
  return (result as { rows: TRow[] }).rows;
}

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
