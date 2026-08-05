import { sql, type SQL } from 'drizzle-orm';
import { config } from '../src/config';
import { createDatabase, type PostgresDatabaseHandle } from '../src/db/client';
import { rawRows } from '../src/db/database';
import type { AccessScope } from '../src/domain/accessScope';
import { buildAttentionQuery } from '../src/repositories/attention';
import { buildBandCoverageQuery } from '../src/repositories/bands';
import { buildRaiseCandidatesQuery } from '../src/repositories/bulkRaise';
import { buildEmployeeListQuery } from '../src/repositories/employees';
import { buildPayGapQuery } from '../src/repositories/payGap';
import { buildPayrollTrendQuery } from '../src/repositories/payrollTrend';
import { buildStatisticsQuery } from '../src/repositories/statistics';

/**
 * Times the queries that carry the product, against a real seeded database.
 *
 * The point is that the numbers in `docs/performance.md` are reproducible rather
 * than remembered. Every one of them was typed out of a `psql \timing` session
 * once, which is fine until the seed changes and nobody notices that the row
 * counts moved — so this runs the *same builders the API runs*, not hand-written
 * copies of them that can drift out of step with the code.
 *
 * Median of a handful of runs, not the mean: one 200 ms outlier from an autovacuum
 * or a laptop deciding to index the disk should not become the published figure.
 * The first run is thrown away, because a cold buffer cache is not what an HR
 * Manager on their tenth page of the day experiences.
 *
 *   npm run bench
 */

/** Enough runs for a stable middle value without turning this into a coffee break. */
const RUNS = 7;

const AS_OF = '2026-08-04';
const PAST = '2025-01-01';

const HR: AccessScope = { kind: 'ALL' };
const MANAGER: AccessScope = { kind: 'TEAM', managerEmployeeId: 64 };
const EMPLOYEE: AccessScope = { kind: 'SELF', employeeId: 229 };

interface Case {
  readonly name: string;
  readonly query: SQL;
}

function cases(): readonly Case[] {
  const list = (
    name: string,
    overrides: Partial<Parameters<typeof buildEmployeeListQuery>[0]>,
  ) => ({
    name,
    query: buildEmployeeListQuery({
      scope: HR,
      asOf: AS_OF,
      page: 1,
      pageSize: 25,
      sortBy: 'name',
      sortDir: 'asc',
      ...overrides,
    }),
  });

  return [
    list('Employee list, page 1 of 400 sorted by name', {}),
    list('Employee list, sorted by converted salary', { sortBy: 'salary', sortDir: 'desc' }),
    list('Employee list, page 400 of 400', { page: 400 }),
    list('Employee list, as of a past date', { asOf: PAST }),
    list('Employee list, searched by name', { search: 'grace' }),
    list('Employee list, scoped to a Manager', { scope: MANAGER }),
    list('Employee list, scoped to one Employee', { scope: EMPLOYEE }),
    {
      name: 'Dashboard: nine figures in one query, whole company',
      query: buildStatisticsQuery({ asOf: AS_OF, status: 'ACTIVE' }),
    },
    {
      name: 'Dashboard, filtered to one department',
      query: buildStatisticsQuery({ asOf: AS_OF, status: 'ACTIVE', departmentId: 1 }),
    },
    {
      name: 'Dashboard, as of a past date',
      query: buildStatisticsQuery({ asOf: PAST, status: 'ACTIVE' }),
    },
    {
      name: 'Pay gap within level and country',
      query: buildPayGapQuery({ asOf: AS_OF }),
    },
    {
      name: 'Payroll trend, 12 months back and 6 forward',
      query: buildPayrollTrendQuery({ asOf: AS_OF, historyMonths: 12, horizonMonths: 6 }),
    },
    {
      name: 'Needs attention, everyone below their band',
      query: buildAttentionQuery({ scope: HR, asOf: AS_OF, page: 1, pageSize: 25 }),
    },
    {
      name: 'Band coverage across every level and country',
      query: buildBandCoverageQuery(AS_OF),
    },
    {
      name: 'Bulk raise candidates, whole company',
      query: buildRaiseCandidatesQuery({ scope: HR, asOf: AS_OF, effectiveFrom: AS_OF }),
    },
  ];
}

async function timeQuery(db: PostgresDatabaseHandle['db'], one: Case): Promise<number> {
  const times: number[] = [];

  // RUNS + 1: the first is a warm-up and is discarded.
  for (let run = 0; run <= RUNS; run++) {
    const started = performance.now();
    await rawRows(db, one.query);
    const elapsed = performance.now() - started;

    if (run > 0) {
      times.push(elapsed);
    }
  }

  times.sort((left, right) => left - right);
  return times[Math.floor(times.length / 2)] ?? Number.NaN;
}

async function main(): Promise<void> {
  const handle = createDatabase(config.DATABASE_URL);

  try {
    const [counts] = await rawRows<{ employees: number; pay: number }>(
      handle.db,
      sql`
        SELECT
          (SELECT count(*)::int FROM employees) AS employees,
          (SELECT count(*)::int FROM compensation_records) AS pay
      `,
    );

    process.stdout.write(
      `${String(counts?.employees ?? 0)} employees, ${String(counts?.pay ?? 0)} salary records\n` +
        `median of ${String(RUNS)} runs, first discarded\n\n`,
    );

    const results: { name: string; ms: number }[] = [];
    for (const one of cases()) {
      results.push({ name: one.name, ms: await timeQuery(handle.db, one) });
    }

    // Slowest last, because the slowest is the only one anybody has to think about.
    for (const { name, ms } of results.sort((left, right) => left.ms - right.ms)) {
      process.stdout.write(`| ${name.padEnd(52)} | ${ms.toFixed(1).padStart(7)} ms |\n`);
    }
  } finally {
    await handle.close();
  }
}

void main();
