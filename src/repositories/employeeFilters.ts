import { sql, type SQL } from 'drizzle-orm';
import type { AccessScope } from '../domain/accessScope';

/**
 * Which employees a query is about, in one place.
 *
 * The list and the statistics ask the same question of the same table — this
 * country, this department, this level, employed or not — and they had a copy of
 * it each. The copies had already drifted: one treated `status` as optional, the
 * other as "unless ALL". The next filter to arrive is gender, for the pay-gap
 * work, and two files is two chances to add it to one of them.
 *
 * Every value here is a bound parameter. The only identifiers in these fragments
 * are column names written in this file.
 */

export interface EmployeeFilters {
  country?: string;
  departmentId?: number;
  jobLevelId?: number;
}

/**
 * Whether a query counts the currently employed, the leavers, or both.
 *
 * A tri-state rather than an optional string, because "no preference" and "both"
 * are the same intent and were previously spelled two different ways.
 */
export type StatusFilter = 'ACTIVE' | 'LEFT' | 'ALL';

/** The shared filters, as conditions on `e`. Empty when nothing narrows the set. */
export function employeeFilterConditions(filters: EmployeeFilters): SQL[] {
  const conditions: SQL[] = [];

  if (filters.country !== undefined) {
    conditions.push(sql`e.country = ${filters.country}`);
  }
  if (filters.departmentId !== undefined) {
    conditions.push(sql`e.department_id = ${filters.departmentId}`);
  }
  if (filters.jobLevelId !== undefined) {
    conditions.push(sql`e.job_level_id = ${filters.jobLevelId}`);
  }

  return conditions;
}

/** `ALL` adds no condition, which is what "both" means to a WHERE clause. */
export function statusCondition(status: StatusFilter): SQL[] {
  return status === 'ALL' ? [] : [sql`e.status = ${status}`];
}

/**
 * Free-text search over the two fields somebody is found by.
 *
 * The wildcards in the input are escaped, so a search for "50%" finds the text
 * "50%" rather than everything beginning with 50. Postgres treats a backslash as
 * the escape character in LIKE by default.
 */
export function searchCondition(search: string | undefined): SQL[] {
  const trimmed = search?.trim() ?? '';
  if (trimmed === '') {
    return [];
  }

  const pattern = `%${trimmed.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
  return [sql`(e.full_name ILIKE ${pattern} OR e.email ILIKE ${pattern})`];
}

/**
 * Everybody the scope allows, as a condition on `e`.
 *
 * NONE returns `false` rather than throwing: a scope with nobody in it is a
 * valid answer, and an empty page is the correct response to it.
 */
export function scopeCondition(scope: AccessScope): SQL {
  switch (scope.kind) {
    case 'ALL':
      return sql`true`;
    case 'SELF':
      return sql`e.id = ${scope.employeeId}`;
    case 'TEAM':
      return sql`e.id IN (SELECT id FROM team)`;
    case 'NONE':
      return sql`false`;
  }
}

/**
 * The recursive walk down a manager's reporting chain, including the manager.
 *
 * `UNION` rather than `UNION ALL`: duplicates are discarded, which also means a
 * cycle in `manager_id` terminates instead of running until the server gives up.
 * The data should never contain one, but a query that hangs is a poor way to
 * find out.
 */
export function teamCte(scope: AccessScope): SQL {
  if (scope.kind !== 'TEAM') {
    return sql``;
  }

  return sql`
    WITH RECURSIVE team AS (
      SELECT id FROM employees WHERE id = ${scope.managerEmployeeId}
      UNION
      SELECT reports.id
      FROM employees reports
      JOIN team ON reports.manager_id = team.id
    )
  `;
}

/** One WHERE clause from a set of conditions; `true` when there are none. */
export function whereFrom(conditions: readonly SQL[]): SQL {
  return conditions.length === 0 ? sql`true` : sql.join([...conditions], sql` AND `);
}
