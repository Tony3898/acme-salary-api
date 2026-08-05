import { readdirSync } from 'node:fs';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { AccessScope } from '../../src/domain/accessScope';
import { buildAttentionQuery, buildAttentionTotalsQuery } from '../../src/repositories/attention';
import { buildBandCoverageQuery } from '../../src/repositories/bands';
import { buildRaiseCandidatesQuery } from '../../src/repositories/bulkRaise';
import { buildEmployeeCountQuery, buildEmployeeListQuery } from '../../src/repositories/employees';
import { buildPayGapQuery } from '../../src/repositories/payGap';
import { buildPayrollTrendQuery } from '../../src/repositories/payrollTrend';
import { buildStatisticsQuery } from '../../src/repositories/statistics';

/**
 * That every query about people applies the access scope — mechanically, rather than
 * because somebody remembered.
 *
 * The scope is applied inside the query on purpose: a route guard stops a Manager
 * *doing* things and does nothing about what a query returns, so the filter lives at
 * the data layer where every path goes through it. That is the right design and it has
 * one weakness, which is that it is a habit. `buildAttentionQuery` was written months
 * after `buildEmployeeListQuery` and had to remember to do the same thing. The next
 * one will too.
 *
 * So the query builders are discovered rather than listed. Every export in
 * `src/repositories/` whose name looks like a query builder must appear in one of the
 * two tables below, and the first test fails until it does — a new builder cannot be
 * quietly absent from this file, only deliberately classified in it.
 *
 * The two classifications are the two honest answers:
 *
 * - **Scoped.** It takes an `AccessScope` and must put it in the SQL. Checked by
 *   rendering the statement under a Manager's scope and an Employee's and looking for
 *   the condition — the generated SQL, not the source text, so a builder that takes a
 *   scope and forgets to use it fails.
 * - **Aggregate.** It takes no scope, because the endpoint is HR-only. Then it must
 *   name nobody: no `full_name`, no `email`. A query with no scope that returns
 *   individuals is one route mistake away from disclosing the payroll, and the route
 *   mistake is the thing that is easy to make.
 */

const dialect = new PgDialect();
const render = (query: SQL): string => dialect.sqlToQuery(query).sql;

const MANAGER: AccessScope = { kind: 'TEAM', managerEmployeeId: 42 };
const SELF: AccessScope = { kind: 'SELF', employeeId: 42 };
const EVERYBODY: AccessScope = { kind: 'ALL' };

const ASOF = '2026-08-01';

/** Builders that take a scope, each with enough arguments to render. */
const SCOPED: Record<string, (scope: AccessScope) => SQL> = {
  buildEmployeeListQuery: (scope) =>
    buildEmployeeListQuery({
      scope,
      asOf: ASOF,
      page: 1,
      pageSize: 25,
      sortBy: 'name',
      sortDir: 'asc',
    }),
  buildEmployeeCountQuery: (scope) =>
    buildEmployeeCountQuery({
      scope,
      asOf: ASOF,
      page: 1,
      pageSize: 25,
      sortBy: 'name',
      sortDir: 'asc',
    }),
  buildAttentionQuery: (scope) => buildAttentionQuery({ scope, asOf: ASOF, page: 1, pageSize: 25 }),
  buildAttentionTotalsQuery: (scope) =>
    buildAttentionTotalsQuery({ scope, asOf: ASOF, page: 1, pageSize: 25 }),
  buildRaiseCandidatesQuery: (scope) =>
    buildRaiseCandidatesQuery({ scope, asOf: ASOF, effectiveFrom: '2026-09-01' }),
};

/**
 * Builders that take no scope, and why that is safe.
 *
 * The reason is required, and it is the same reason in every case: the figures are
 * company-wide, the service refuses anybody who is not HR, and the route inventory
 * test proves that refusal actually happens. Anything added here that cannot say
 * something as specific should be taking a scope instead.
 */
const AGGREGATE: Record<string, { reason: string; build: () => SQL }> = {
  buildStatisticsQuery: {
    reason: 'Medians and headcounts. HR-only via canSeeAggregates in the statistics service.',
    build: () => buildStatisticsQuery({ asOf: ASOF, status: 'ACTIVE' }),
  },
  buildPayrollTrendQuery: {
    reason: 'Monthly payroll cost. HR-only via canSeeAggregates in the statistics service.',
    build: () => buildPayrollTrendQuery({ asOf: ASOF, historyMonths: 12, horizonMonths: 3 }),
  },
  buildPayGapQuery: {
    reason:
      'Medians per country and level, suppressed below five people. HR-only, and the most sensitive of these.',
    build: () => buildPayGapQuery({ asOf: ASOF }),
  },
  buildBandCoverageQuery: {
    reason: 'Counts per level and country for the pay-bands screen. HR-only via requireHr.',
    build: () => buildBandCoverageQuery(ASOF),
  },
};

/** Every export across the repositories that looks like a query builder. */
async function discoverBuilders(): Promise<string[]> {
  const names: string[] = [];
  const files = readdirSync('src/repositories').filter((file) => file.endsWith('.ts'));

  for (const file of files) {
    const module = (await import(`../../src/repositories/${file.replace('.ts', '')}`)) as Record<
      string,
      unknown
    >;

    for (const [name, value] of Object.entries(module)) {
      if (typeof value === 'function' && /^build[A-Za-z]*Query$/.test(name)) {
        names.push(name);
      }
    }
  }

  return names.sort();
}

describe('every query about people applies the access scope', () => {
  it('given the repositories, when their exports are read, then every query builder is classified', async () => {
    const discovered = await discoverBuilders();
    const classified = [...Object.keys(SCOPED), ...Object.keys(AGGREGATE)].sort();

    /* The message matters as much as the assertion: whoever hits this is holding a
       new query builder and needs to know the question is "does this return
       individuals?" rather than "which list do I add it to?". */
    expect(discovered).toEqual(classified);
  });

  describe.each(Object.entries(SCOPED))('%s', (name, build) => {
    it('given a Manager, when the query is built, then it is limited to their reporting chain', () => {
      const statement = render(build(MANAGER));

      expect(statement).toContain('e.id IN (SELECT id FROM team)');
      /* And the CTE that defines `team` is actually there. Referring to it without
         declaring it is a query that fails rather than one that over-shares, but the
         two live in different functions and only one of them is easy to forget. */
      expect(statement).toMatch(/WITH RECURSIVE team/i);
    });

    it('given an Employee, when the query is built, then it is limited to their own row', () => {
      const statement = render(build(SELF));

      /* The id is a bound parameter, which is the other half of the promise: the
         scope narrows the query and cannot become part of it. */
      expect(statement).toMatch(/e\.id = \$\d+/);
    });

    it('given the same query for HR and for an Employee, when both are built, then they differ', () => {
      /* The assertion that catches a builder which takes a scope and ignores it —
         the failure that would look completely correct in a review. */
      expect(render(build(SELF))).not.toBe(render(build(EVERYBODY)));
    });
  });

  describe.each(Object.entries(AGGREGATE))('%s', (_name, { reason, build }) => {
    /* The reason is in the test's name rather than sitting in the table unread: it is
       the argument for this query having no scope, so it belongs where somebody reads
       it — in the output, next to the assertion that depends on it being true. */
    it(`given no scope (${reason}), when the query is built, then it names nobody`, () => {
      const statement = render(build());

      expect(statement).not.toMatch(/full_name/i);
      expect(statement).not.toMatch(/\bemail\b/i);
    });
  });
});
