import { PGlite } from '@electric-sql/pglite';
import { pushSchema } from 'drizzle-kit/api';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import * as schema from '../../src/db/schema';

export type TestDb = PgliteDatabase<typeof schema>;

export interface TestDatabaseHandle {
  db: TestDb;
  close: () => Promise<void>;
}

/**
 * A fresh Postgres per call, in-process, with the schema built from schema.ts
 * itself — so there is no hand-written SQL copy of the schema to drift out of
 * step with the real one.
 *
 * Shaped like the production `DatabaseHandle`, so the container accepts it and
 * tests exercise the same wiring the server uses rather than a parallel one.
 */
export async function createTestDatabaseHandle(): Promise<TestDatabaseHandle> {
  const client = new PGlite();
  const db = drizzle({ client, schema });

  const { apply } = await pushSchema(schema, db as unknown as Parameters<typeof pushSchema>[1]);
  await apply();

  return { db, close: () => client.close() };
}

/**
 * Every database a test file opens, closed together at the end of it.
 *
 * Each one is a WebAssembly Postgres holding memory and a message port. Left open
 * they keep the Jest worker alive after the file finishes, which shows up as
 * "a worker process has failed to exit gracefully" — a warning today, and a
 * genuinely leaking test suite once there are more of them.
 */
export function useTestDatabases(): {
  create: () => Promise<TestDb>;
  closeAll: () => Promise<void>;
} {
  const handles: TestDatabaseHandle[] = [];

  return {
    create: async () => {
      const handle = await createTestDatabaseHandle();
      handles.push(handle);
      return handle.db;
    },
    closeAll: async () => {
      await Promise.all(handles.map((handle) => handle.close()));
      handles.length = 0;
    },
  };
}

/**
 * The single row a query was expected to return, failing loudly if it did not.
 * Keeps setup readable without turning off the strictness that makes `rows[0]`
 * possibly-undefined — which is the same check that catches the empty-result
 * pagination trap in real code.
 */
export function one<T>(rows: T[]): T {
  const [row] = rows;
  if (!row) {
    throw new Error('Expected exactly one row, got none.');
  }
  return row;
}

/**
 * Resolves with the reason a query was refused.
 *
 * Drizzle reports "Failed query: ..." and puts the database's actual complaint
 * on `error.cause`, so matching on the top-level message would pass for the
 * wrong reason. This walks the chain, and throws if the query unexpectedly
 * succeeded — which is what a missing constraint looks like.
 */
export async function rejectionReason(query: Promise<unknown>): Promise<string> {
  try {
    await query;
  } catch (error) {
    const reasons: string[] = [];
    for (let current: unknown = error; current instanceof Error; current = current.cause) {
      reasons.push(current.message);
    }
    return reasons.join(' | ');
  }

  throw new Error('Expected the database to refuse this query, but it succeeded.');
}
