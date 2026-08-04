import { sql, type SQL } from 'drizzle-orm';
import { rawRows, type Database } from '../db/database';
import type { AccessScope } from '../domain/accessScope';
import type { Currency } from '../domain/money';

/**
 * Reading employees, with their pay as it stood on a given date.
 *
 * Raw SQL rather than the query builder: this needs `DISTINCT ON` for the current
 * salary, `COUNT(*) OVER ()` for the total, and a recursive walk down the
 * reporting chain. No ORM expresses those well, and pretending otherwise costs
 * more than it saves. Every value below is a bound parameter — the only strings
 * built into the SQL come from fixed maps in this file.
 */

export const EMPLOYEE_SORT_FIELDS = [
  'name',
  'salary',
  'hireDate',
  'country',
  'department',
  'level',
  'status',
] as const;

export type EmployeeSortField = (typeof EMPLOYEE_SORT_FIELDS)[number];
export type SortDirection = 'asc' | 'desc';

/**
 * The whitelist. A sort column cannot be a bound parameter — it is part of the
 * statement — so the only safe approach is to never let user text near it. An
 * unrecognised `sortBy` is rejected at the route before it reaches this map.
 *
 * `salary` sorts on the *converted* amount: ₹2,000,000 is a bigger number than
 * $150,000 and a smaller salary.
 */
const SORT_EXPRESSIONS: Record<EmployeeSortField, SQL> = {
  name: sql`e.full_name`,
  salary: sql`salary_usd_minor`,
  hireDate: sql`e.hire_date`,
  country: sql`e.country`,
  department: sql`d.name`,
  level: sql`jl.rank`,
  status: sql`e.status`,
};

export interface EmployeeListRow {
  id: number;
  fullName: string;
  email: string;
  country: string;
  departmentId: number;
  departmentName: string;
  jobLevelId: number;
  jobLevelName: string;
  jobTitle: string | null;
  hireDate: string;
  managerId: number | null;
  managerName: string | null;
  status: 'ACTIVE' | 'LEFT';
  /** Null for somebody with no compensation record on or before the date asked for. */
  salary: {
    amountMinor: number;
    currency: Currency;
    /** The same amount in USD cents, for comparing across countries. */
    amountUsdMinor: number;
    effectiveFrom: string;
  } | null;
}

export interface EmployeeListQuery {
  scope: AccessScope;
  /** Salaries as they stood on this date, as YYYY-MM-DD. */
  asOf: string;
  page: number;
  pageSize: number;
  sortBy: EmployeeSortField;
  sortDir: SortDirection;
  search?: string;
  country?: string;
  departmentId?: number;
  jobLevelId?: number;
  status?: 'ACTIVE' | 'LEFT';
}

export interface EmployeeListResult {
  rows: EmployeeListRow[];
  total: number;
}

interface RawEmployeeRow {
  id: number;
  full_name: string;
  email: string;
  country: string;
  department_id: number;
  department_name: string;
  job_level_id: number;
  job_level_name: string;
  job_title: string | null;
  hire_date: string;
  manager_id: number | null;
  manager_name: string | null;
  status: 'ACTIVE' | 'LEFT';
  amount_minor: number | null;
  currency: Currency | null;
  effective_from: string | null;
  salary_usd_minor: number | null;
  total_count: number;
}

/**
 * Everybody the scope allows, as a condition on `e`.
 *
 * NONE returns `false` rather than throwing: a scope with nobody in it is a valid
 * answer, and an empty page is the correct response to it.
 */
function scopeCondition(scope: AccessScope): SQL {
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
 * The data should never contain one, but a query that hangs is a poor way to find
 * out.
 */
function teamCte(scope: AccessScope): SQL {
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

/**
 * Escapes the wildcards so a search for "50%" finds the text "50%" rather than
 * everything beginning with 50. Postgres treats a backslash as the escape
 * character in LIKE by default.
 */
function escapeLikeWildcards(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function filterConditions(query: EmployeeListQuery): SQL[] {
  const conditions: SQL[] = [scopeCondition(query.scope)];

  if (query.search !== undefined && query.search.trim() !== '') {
    const pattern = `%${escapeLikeWildcards(query.search.trim())}%`;
    conditions.push(sql`(e.full_name ILIKE ${pattern} OR e.email ILIKE ${pattern})`);
  }
  if (query.country !== undefined) {
    conditions.push(sql`e.country = ${query.country}`);
  }
  if (query.departmentId !== undefined) {
    conditions.push(sql`e.department_id = ${query.departmentId}`);
  }
  if (query.jobLevelId !== undefined) {
    conditions.push(sql`e.job_level_id = ${query.jobLevelId}`);
  }
  if (query.status !== undefined) {
    conditions.push(sql`e.status = ${query.status}`);
  }

  return conditions;
}

/**
 * One page of employees, and the number of people the filters matched.
 *
 * The total comes from the same statement through `COUNT(*) OVER ()`. Counting
 * separately means a second copy of the filters and the scope, and eventually one
 * of them disagrees — a footer that says 300 above a list that can only reach 40.
 */
export async function listEmployees(
  db: Database,
  query: EmployeeListQuery,
): Promise<EmployeeListResult> {
  const direction = sql.raw(query.sortDir === 'asc' ? 'ASC' : 'DESC');
  const offset = (query.page - 1) * query.pageSize;
  const where = sql.join(filterConditions(query), sql` AND `);

  const rows = await rawRows<RawEmployeeRow>(
    db,
    sql`
      ${teamCte(query.scope)}
      SELECT
        e.id,
        e.full_name,
        e.email,
        e.country,
        e.department_id,
        d.name AS department_name,
        e.job_level_id,
        jl.name AS job_level_name,
        e.job_title,
        e.hire_date,
        e.manager_id,
        m.full_name AS manager_name,
        e.status,
        current_pay.amount_minor,
        current_pay.currency,
        current_pay.effective_from,
        round(current_pay.amount_minor * fx.rate_to_usd)::bigint AS salary_usd_minor,
        count(*) OVER ()::int AS total_count
      FROM employees e
      JOIN departments d ON d.id = e.department_id
      JOIN job_levels jl ON jl.id = e.job_level_id
      LEFT JOIN employees m ON m.id = e.manager_id
      /* The salary in force on the date asked for: the latest record that had
         already started, with id breaking a same-day tie. LEFT so somebody with
         no record yet appears with no pay rather than vanishing from the list. */
      LEFT JOIN LATERAL (
        SELECT c.amount_minor, c.currency, c.effective_from
        FROM compensation_records c
        WHERE c.employee_id = e.id AND c.effective_from <= ${query.asOf}
        ORDER BY c.effective_from DESC, c.id DESC
        LIMIT 1
      ) current_pay ON true
      /* Also LEFT: a missing rate must surface as an error, not quietly drop
         those people from a list that reports a total. */
      LEFT JOIN fx_rates fx ON fx.currency = current_pay.currency
      WHERE ${where}
      /* id last, always. Sorting by a column where hundreds tie lets the database
         return them in a different order per request, so page 2 repeats people
         from page 1 and skips others — and nothing looks broken. */
      ORDER BY ${SORT_EXPRESSIONS[query.sortBy]} ${direction} NULLS LAST, e.id ASC
      LIMIT ${query.pageSize} OFFSET ${offset}
    `,
  );

  if (rows.length > 0) {
    return { rows: rows.map(toEmployeeListRow), total: rows[0]?.total_count ?? 0 };
  }

  /* No rows, so the window function produced no total either — and "no matches"
     and "asked for page 99 of 3" are indistinguishable from here. They need
     different answers: the first is genuinely zero, the second must still report
     the real total or the pager loses its way back.

     Counting separately is the exception rather than the rule, and it reuses the
     same `where` fragment and the same team walk, so there is still one definition
     of who is being counted. It only runs on an empty page. */
  return { rows: [], total: await countEmployees(db, query) };
}

async function countEmployees(db: Database, query: EmployeeListQuery): Promise<number> {
  const where = sql.join(filterConditions(query), sql` AND `);

  const [counted] = await rawRows<{ total: number }>(
    db,
    sql`
      ${teamCte(query.scope)}
      SELECT count(*)::int AS total
      FROM employees e
      WHERE ${where}
    `,
  );

  return counted?.total ?? 0;
}

function toEmployeeListRow(row: RawEmployeeRow): EmployeeListRow {
  return {
    id: row.id,
    fullName: row.full_name,
    email: row.email,
    country: row.country,
    departmentId: row.department_id,
    departmentName: row.department_name,
    jobLevelId: row.job_level_id,
    jobLevelName: row.job_level_name,
    jobTitle: row.job_title,
    hireDate: row.hire_date,
    managerId: row.manager_id,
    managerName: row.manager_name,
    status: row.status,
    salary: toSalary(row),
  };
}

function toSalary(row: RawEmployeeRow): EmployeeListRow['salary'] {
  if (row.amount_minor === null || row.currency === null || row.effective_from === null) {
    return null;
  }

  if (row.salary_usd_minor === null) {
    /* The rate is missing from fx_rates. Refusing is the point: converting is how
       every cost figure is produced, and silently omitting these people would make
       a payroll total quietly too small. */
    throw new Error(`No exchange rate for ${row.currency}; cannot convert employee ${row.id}.`);
  }

  return {
    amountMinor: row.amount_minor,
    currency: row.currency,
    amountUsdMinor: row.salary_usd_minor,
    effectiveFrom: row.effective_from,
  };
}
