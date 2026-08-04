import { sql } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import type { Database } from '../database';
import {
  compensationRecords,
  departments,
  employees,
  fxRates,
  jobLevels,
  refreshTokens,
  salaryBands,
  users,
} from '../schema';
import { buildDemoAccounts } from './accounts';
import { createSalaryBands } from './bands';
import { COUNTRIES, DEPARTMENTS, JOB_LEVELS } from './data';
import { buildSalaryHistory } from './history';
import { generatePeople } from './people';
import { SeededRandom } from './random';

export interface SeedOptions {
  employeeCount?: number;
  /** Same seed, same data. Other tests depend on this. */
  randomSeed?: number;
  /** Reference date, passed in rather than read from the clock so runs are repeatable. */
  today?: string;
  /* Required, with no default here: config.ts is the only place that decides it,
     so a deployment cannot end up using a password from source by accident. */
  demoPassword: string;
}

export interface SeedSummary {
  employees: number;
  compensationRecords: number;
  demoAccounts: { email: string; role: string }[];
}

const DEFAULTS = {
  employeeCount: 10_000,
  randomSeed: 20_260_804,
} as const;

/** Postgres caps parameters per statement; 500 rows stays well clear of it. */
const BATCH_SIZE = 500;

/**
 * Replaces all data with a generated company of the requested size.
 *
 * Ids are assigned in code rather than read back from inserts: it avoids relying
 * on the order Postgres returns rows in, and lets a manager be set on the same
 * insert as the employee.
 */
export async function seed(db: Database, options: SeedOptions): Promise<SeedSummary> {
  const today = options.today ?? new Date().toISOString().slice(0, 10);
  const random = new SeededRandom(options.randomSeed ?? DEFAULTS.randomSeed);
  const bands = createSalaryBands();

  const people = generatePeople(
    options.employeeCount ?? DEFAULTS.employeeCount,
    today,
    bands,
    random,
  );
  const history = buildSalaryHistory(people.profiles, today, random);
  const accounts = await buildDemoAccounts(people.rows, options.demoPassword);

  await clearExistingData(db);

  await db.insert(departments).values(DEPARTMENTS.map(({ id, name }) => ({ id, name })));
  await db.insert(jobLevels).values(JOB_LEVELS.map(({ id, name, rank }) => ({ id, name, rank })));
  await db
    .insert(fxRates)
    .values(COUNTRIES.map(({ currency, rateToUsd }) => ({ currency, rateToUsd, asOf: today })));
  await db.insert(salaryBands).values(bands.rows);
  await insertInBatches(db, employees, people.rows);
  await insertInBatches(db, compensationRecords, history);
  await db.insert(users).values(accounts);

  await resetSequences(db);

  return {
    employees: people.rows.length,
    compensationRecords: history.length,
    demoAccounts: accounts.map(({ email, role }) => ({ email, role })),
  };
}

/**
 * One statement, so it cannot half-succeed, and RESTART IDENTITY means a reseed
 * produces the same ids as a first run.
 */
async function clearExistingData(db: Database): Promise<void> {
  await db.execute(sql`
    TRUNCATE TABLE
      ${refreshTokens}, ${users}, ${compensationRecords},
      ${employees}, ${salaryBands}, ${fxRates}, ${jobLevels}, ${departments}
    RESTART IDENTITY CASCADE
  `);
}

async function insertInBatches<TTable extends PgTable>(
  db: Database,
  table: TTable,
  rows: TTable['$inferInsert'][],
): Promise<void> {
  for (let from = 0; from < rows.length; from += BATCH_SIZE) {
    await db.insert(table).values(rows.slice(from, from + BATCH_SIZE));
  }
}

/**
 * Moves each sequence past the explicitly assigned ids, so ordinary inserts carry
 * on where the seed left off. Read from the table rather than passed in as a
 * count, which would be a second place the number could be wrong.
 */
async function resetSequences(db: Database): Promise<void> {
  const tables = [
    'departments',
    'job_levels',
    'salary_bands',
    'employees',
    'compensation_records',
    'users',
  ];

  await Promise.all(
    tables.map((table) =>
      db.execute(
        sql`SELECT setval(
              pg_get_serial_sequence(${table}, 'id'),
              (SELECT coalesce(max(id), 1) FROM ${sql.identifier(table)})
            )`,
      ),
    ),
  );
}
