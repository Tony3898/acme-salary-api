import path from 'node:path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { config } from '../config';
import { createDatabase } from './client';

/**
 * Applies the committed migrations, using `drizzle-orm` rather than `drizzle-kit`.
 *
 * Same migrations, same journal, same table — but `drizzle-kit` is a dev
 * dependency, and a production image that carries it is carrying TypeScript and
 * a schema-diffing tool onto a server whose only job is to serve HTTP. This is
 * about forty lines of runtime code that is already a dependency.
 *
 * Run it before the API starts, not from inside it: two containers racing to
 * apply the same migration is a deadlock, and a process that migrates on boot
 * cannot be scaled to two.
 *
 *   node dist/db/migrate.js
 */

/**
 * Beside the compiled output rather than beside the source.
 *
 * `.sql` files are not something `tsc` copies, so the Dockerfile copies them into
 * `dist/db/migrations` and this resolves relative to itself. Anchoring on
 * `__dirname` rather than the working directory matters: this is run by a
 * container entrypoint whose cwd is not guaranteed to be the app root.
 */
const MIGRATIONS_FOLDER = path.join(__dirname, 'migrations');

async function main(): Promise<void> {
  const handle = createDatabase(config.DATABASE_URL);

  try {
    await migrate(handle.db, { migrationsFolder: MIGRATIONS_FOLDER });
    process.stdout.write('Migrations applied.\n');
  } finally {
    await handle.close();
  }
}

void main();
