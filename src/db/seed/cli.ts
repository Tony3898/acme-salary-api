import { config } from '../../config';
import { createDatabase } from '../client';
import { seed } from './seed';

/**
 * Replaces everything in the configured database with generated data. Refuses to
 * run in production: it truncates every table, which is not a mistake worth
 * making available.
 */
async function main(): Promise<void> {
  if (config.isProduction) {
    throw new Error('Refusing to seed: this deletes all data and NODE_ENV is production.');
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
