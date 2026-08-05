import { PGlite } from '@electric-sql/pglite';
import { pushSchema } from 'drizzle-kit/api';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import * as schema from '../../src/db/schema';

/**
 * The committed migrations, applied to an empty database.
 *
 * Every other test builds its schema from `schema.ts` directly, which is the right
 * default — it means no test is ever asserting against a hand-written copy of the
 * schema. It also means nothing else in the suite touches the migration files at
 * all, and a migration that is malformed, out of order, or simply missing would pass
 * the entire suite and fail on the one database that cannot be rebuilt.
 *
 * So this file is the other direction: start from the SQL, and check where it lands.
 */
describe('the committed migrations', () => {
  it('given an empty database, when the migrations are applied, then the result is exactly schema.ts', async () => {
    /* The strongest form of this check available without a second database. Rather
       than listing tables and hoping the list is complete, the migrated database is
       handed to the same schema diff that generates migrations in the first place:
       if it can find nothing to change, the SQL and `schema.ts` describe the same
       database — including constraints, indexes, defaults and enum members that a
       list of table names would never notice. */
    const client = new PGlite();

    try {
      const db = drizzle({ client, schema });
      await migrate(db, { migrationsFolder: 'src/db/migrations' });

      const { statementsToExecute } = await pushSchema(
        schema,
        db as unknown as Parameters<typeof pushSchema>[1],
      );

      expect(statementsToExecute).toEqual([]);
    } finally {
      await client.close();
    }
  });

  it('given the migrations already applied, when they are applied again, then nothing changes', async () => {
    /* What a deploy does when it is re-run — a retried pipeline, a second instance
       starting, somebody running it by hand to be sure. The journal table is what
       makes that safe, and it is only proved by doing it. */
    const client = new PGlite();

    try {
      const db = drizzle({ client, schema });
      await migrate(db, { migrationsFolder: 'src/db/migrations' });
      await migrate(db, { migrationsFolder: 'src/db/migrations' });

      const { statementsToExecute } = await pushSchema(
        schema,
        db as unknown as Parameters<typeof pushSchema>[1],
      );

      expect(statementsToExecute).toEqual([]);
    } finally {
      await client.close();
    }
  });
});
