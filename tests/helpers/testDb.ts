import { PGlite } from '@electric-sql/pglite';
import { pushSchema } from 'drizzle-kit/api';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import * as schema from '../../src/db/schema';

export type TestDb = PgliteDatabase<typeof schema>;

/**
 * A fresh Postgres per call, in-process, with the schema built from schema.ts
 * itself — so there is no hand-written SQL copy of the schema to drift out of
 * step with the real one.
 */
export async function createTestDb(): Promise<TestDb> {
  const client = new PGlite();
  const db = drizzle({ client, schema });

  const { apply } = await pushSchema(schema, db as unknown as Parameters<typeof pushSchema>[1]);
  await apply();

  return db;
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
