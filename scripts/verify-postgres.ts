import { sql } from 'drizzle-orm';
import { closeDatabase, db } from '../src/db/client';

/**
 * Checks the things PGlite cannot prove, because they are properties of the
 * node-postgres driver rather than of Postgres itself.
 *
 * The important one is the bigint parser: node-postgres returns bigint as a
 * string by default, PGlite as a number. Every test runs on PGlite, so this is
 * the only place that behaviour is exercised at all.
 */
async function main(): Promise<void> {
  const checks: { name: string; passed: boolean; detail: string }[] = [];
  const record = (name: string, passed: boolean, detail: string) =>
    checks.push({ name, passed, detail });

  const amounts = await db.execute<{ amount_minor: number; total: number; rate: string }>(sql`
    SELECT c.amount_minor,
           (SELECT sum(amount_minor)::bigint FROM compensation_records) AS total,
           (SELECT rate_to_usd FROM fx_rates WHERE currency = 'INR') AS rate
      FROM compensation_records c ORDER BY c.id LIMIT 1
  `);
  const row = amounts.rows[0];

  record(
    'bigint column arrives as a number',
    typeof row?.amount_minor === 'number' && Number.isSafeInteger(row.amount_minor),
    `typeof=${typeof row?.amount_minor} value=${String(row?.amount_minor)}`,
  );
  record(
    'sum(...)::bigint arrives as a number',
    typeof row?.total === 'number',
    `typeof=${typeof row?.total} value=${String(row?.total)}`,
  );
  record(
    'numeric stays a string, so a rate never becomes a float',
    typeof row?.rate === 'string',
    `typeof=${typeof row?.rate} value=${String(row?.rate)}`,
  );

  const dates = await db.execute<{ effective_from: string }>(
    sql`SELECT effective_from FROM compensation_records ORDER BY id LIMIT 1`,
  );
  record(
    'date arrives as a plain YYYY-MM-DD string',
    /^\d{4}-\d{2}-\d{2}$/.test(String(dates.rows[0]?.effective_from)),
    String(dates.rows[0]?.effective_from),
  );

  const stats = await db.execute<{ median: number; buckets: number; people: number }>(sql`
    WITH current_pay AS (
      SELECT DISTINCT ON (employee_id) employee_id, amount_minor
        FROM compensation_records
       ORDER BY employee_id, effective_from DESC, id DESC)
    SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY amount_minor)::bigint AS median,
           count(DISTINCT width_bucket(amount_minor, 0, 100000000, 10)) AS buckets,
           count(*)::int AS people
      FROM current_pay
  `);
  const statistics = stats.rows[0];
  record(
    'the statistics run on real Postgres',
    (statistics?.people ?? 0) === 10_000 && (statistics?.median ?? 0) > 0,
    `people=${String(statistics?.people)} median=${String(statistics?.median)} buckets=${String(statistics?.buckets)}`,
  );

  const payCuts = await db.execute<{ pay_cuts: number }>(sql`
    SELECT count(*)::int AS pay_cuts FROM (
      SELECT amount_minor - lag(amount_minor)
               OVER (PARTITION BY employee_id ORDER BY effective_from, id) AS delta
        FROM compensation_records) deltas
     WHERE delta < 0
  `);
  record(
    'no salary decreases anywhere in the seeded history',
    payCuts.rows[0]?.pay_cuts === 0,
    `pay_cuts=${String(payCuts.rows[0]?.pay_cuts)}`,
  );

  for (const check of checks) {
    console.log(`${check.passed ? 'PASS' : 'FAIL'}  ${check.name}  [${check.detail}]`);
  }
  if (checks.some((check) => !check.passed)) {
    process.exitCode = 1;
  }
}

main()
  .catch((error: unknown) => {
    console.error('Verification failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(closeDatabase);
