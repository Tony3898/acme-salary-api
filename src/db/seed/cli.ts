import { config } from '../../config';
import { createDatabase } from '../client';
import { seed } from './seed';

/**
 * The one way to seed a production database, and it has to be typed out.
 *
 * A flag rather than an environment variable: a variable set once in `.env` stays set,
 * so the next person to run this by accident is no longer protected. This has to be
 * present in the command itself, every time.
 */
const FORCE_FLAG = '--yes-truncate-every-table';

/**
 * Replaces everything in the configured database with generated data. Refuses to
 * run in production: it truncates every table, which is not a mistake worth
 * making available.
 *
 * The deployed demo is the exception, because its whole database is generated and its
 * first deploy has to fill it. That deploy passes the flag above.
 */
async function main(): Promise<void> {
  if (config.isProduction && !process.argv.includes(FORCE_FLAG)) {
    throw new Error(
      'Refusing to seed: this deletes all data and NODE_ENV is production. ' +
        `Pass ${FORCE_FLAG} if that is genuinely what you mean.`,
    );
  }

  const startedAt = Date.now();
  const { db, close } = createDatabase(config.DATABASE_URL);
  const summary = await seed(db, { demoPassword: config.SEED_DEMO_PASSWORD }).finally(close);

  console.log(
    `Seeded ${summary.employees.toLocaleString()} employees and ` +
      `${summary.compensationRecords.toLocaleString()} salary records in ${Date.now() - startedAt}ms.`,
  );
  console.log('Demo accounts (password in README):');
  for (const account of summary.demoAccounts) {
    console.log(`  ${account.role.padEnd(10)} ${account.email}`);
  }
}

main().catch((error: unknown) => {
  console.error('Seed failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
