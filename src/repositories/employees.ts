import { and, eq, sql, type SQL } from 'drizzle-orm';
import { rawRows, type Database } from '../db/database';
import { compensationRecords } from '../db/schema';
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
 * What an employee row is, in one place.
 *
 * The list and a single record answer the same question about different numbers
 * of people, so they share the columns and the joins. Written twice they drift:
 * a column added to the list would be missing from the detail page, or the two
 * would convert currency differently and disagree by a cent.
 */
const EMPLOYEE_COLUMNS = sql`
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
  round(current_pay.amount_minor * fx.rate_to_usd)::bigint AS salary_usd_minor
`;

function employeeFrom(asOf: string): SQL {
  return sql`
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
      WHERE c.employee_id = e.id AND c.effective_from <= ${asOf}
      ORDER BY c.effective_from DESC, c.id DESC
      LIMIT 1
    ) current_pay ON true
    /* Also LEFT: a missing rate must surface as an error, not quietly drop
       those people from a list that reports a total. */
    LEFT JOIN fx_rates fx ON fx.currency = current_pay.currency
  `;
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
  const rows = await rawRows<RawEmployeeRow>(db, buildEmployeeListQuery(query));

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

/**
 * The list statement, built but not run.
 *
 * Separated from execution so scripts/verify-injection.ts can ask the dialect
 * for the SQL text and the bound parameters as two separate things, and check
 * that no user-supplied value is in the first of them. Reading the code and
 * reasoning about it is not the same check: it is the interpolation nobody
 * noticed that gets you.
 *
 * The only two strings here that are *not* bound parameters are the sort
 * direction, which is one of two literals, and the sort expression, which comes
 * from a fixed map keyed by an enum the route validates. A sort column cannot
 * be a bound parameter — it is part of the statement rather than a value in it
 * — so the only safe approach is to never let user text near it.
 */
export function buildEmployeeListQuery(query: EmployeeListQuery): SQL {
  const direction = sql.raw(query.sortDir === 'asc' ? 'ASC' : 'DESC');
  const offset = (query.page - 1) * query.pageSize;
  const where = sql.join(filterConditions(query), sql` AND `);

  return sql`
    ${teamCte(query.scope)}
    SELECT ${EMPLOYEE_COLUMNS}, count(*) OVER ()::int AS total_count
    ${employeeFrom(query.asOf)}
    WHERE ${where}
    /* id last, always. Sorting by a column where hundreds tie lets the database
       return them in a different order per request, so page 2 repeats people
       from page 1 and skips others — and nothing looks broken. */
    ORDER BY ${SORT_EXPRESSIONS[query.sortBy]} ${direction} NULLS LAST, e.id ASC
    LIMIT ${query.pageSize} OFFSET ${offset}
  `;
}

/** The count, built but not run. Reuses the same filters and the same team walk. */
export function buildEmployeeCountQuery(query: EmployeeListQuery): SQL {
  const where = sql.join(filterConditions(query), sql` AND `);

  return sql`
    ${teamCte(query.scope)}
    SELECT count(*)::int AS total
    FROM employees e
    WHERE ${where}
  `;
}

async function countEmployees(db: Database, query: EmployeeListQuery): Promise<number> {
  const [counted] = await rawRows<{ total: number }>(db, buildEmployeeCountQuery(query));

  return counted?.total ?? 0;
}

/**
 * One person, if the caller is allowed to see them.
 *
 * The scope is part of the WHERE clause rather than a check on the result,
 * which is the difference between "this row is not yours" and "there is no such
 * row". The caller cannot tell them apart, and neither can the person on the
 * other end of a 404 — which is the point. A 403 on somebody else's record
 * confirms that the record exists.
 */
export async function findEmployeeById(
  db: Database,
  query: { id: number; scope: AccessScope; asOf: string },
): Promise<EmployeeListRow | null> {
  const rows = await rawRows<RawEmployeeRow>(
    db,
    sql`
      ${teamCte(query.scope)}
      SELECT ${EMPLOYEE_COLUMNS}, 1 AS total_count
      ${employeeFrom(query.asOf)}
      WHERE ${scopeCondition(query.scope)} AND e.id = ${query.id}
      LIMIT 1
    `,
  );

  const [row] = rows;
  return row === undefined ? null : toEmployeeListRow(row);
}

/** Every salary a person has ever been on, oldest first. */
export interface CompensationHistoryEntry {
  id: number;
  amountMinor: number;
  currency: Currency;
  /** At today's rate. Historic rates are out of scope — see docs/requirements.md. */
  amountUsdMinor: number;
  effectiveFrom: string;
  reason: string | null;
  /** Null where the record was carried over from the spreadsheets, which had no author. */
  recordedByEmail: string | null;
  recordedAt: string;
}

interface RawHistoryRow {
  id: number;
  amount_minor: number;
  currency: Currency;
  amount_usd_minor: number | null;
  effective_from: string;
  reason: string | null;
  recorded_by_email: string | null;
  recorded_at: Date | string;
}

/**
 * A person's whole pay history, including records that have not started yet.
 *
 * Future-dated rows are deliberately included: a raise signed off for January is
 * something HR needs to see in August, and hiding it until it starts is how the
 * same raise gets awarded twice. Which of them is *current* is a separate
 * question, answered by the `asOf` join above.
 *
 * Ascending, so the change from one row to the next reads down the page in the
 * order the changes happened. The caller is expected to have established that
 * the employee is within scope; there is no scope condition here because there
 * is no employees table to hang one on.
 */
export async function listCompensationHistory(
  db: Database,
  employeeId: number,
): Promise<CompensationHistoryEntry[]> {
  const rows = await rawRows<RawHistoryRow>(
    db,
    sql`
      SELECT
        c.id,
        c.amount_minor,
        c.currency,
        round(c.amount_minor * fx.rate_to_usd)::bigint AS amount_usd_minor,
        c.effective_from,
        c.reason,
        u.email AS recorded_by_email,
        c.created_at AS recorded_at
      FROM compensation_records c
      LEFT JOIN fx_rates fx ON fx.currency = c.currency
      LEFT JOIN users u ON u.id = c.created_by
      WHERE c.employee_id = ${employeeId}
      /* id breaks a same-day tie the same way the current-salary join does, so
         "the latest record" means the same thing in both places. */
      ORDER BY c.effective_from ASC, c.id ASC
    `,
  );

  return rows.map((row) => {
    if (row.amount_usd_minor === null) {
      throw new Error(`No exchange rate for ${row.currency}; cannot convert record ${row.id}.`);
    }

    return {
      id: row.id,
      amountMinor: row.amount_minor,
      currency: row.currency,
      amountUsdMinor: row.amount_usd_minor,
      effectiveFrom: row.effective_from,
      reason: row.reason,
      recordedByEmail: row.recorded_by_email,
      recordedAt: new Date(row.recorded_at).toISOString(),
    };
  });
}

export interface NewCompensationRecord {
  employeeId: number;
  amountMinor: number;
  currency: Currency;
  effectiveFrom: string;
  reason: string | null;
  /** The account that recorded it. Every pay change has an author. */
  createdBy: number;
}

/**
 * Records a new salary. Nothing is ever updated: a raise is a row, and the
 * history is the table.
 */
export async function insertCompensationRecord(
  db: Database,
  record: NewCompensationRecord,
): Promise<number> {
  const [inserted] = await db
    .insert(compensationRecords)
    .values(record)
    .returning({ id: compensationRecords.id });

  if (inserted === undefined) {
    throw new Error(`Failed to record pay for employee ${String(record.employeeId)}.`);
  }
  return inserted.id;
}

/**
 * Whether the very same record already exists.
 *
 * A double-clicked button or a retried request would otherwise write the raise
 * twice, and an append-only table has no undo. Identical amount, currency and
 * start date on one person is a duplicate submission rather than a decision
 * anybody made twice — a correction to the same figure on the same day changes
 * nothing, so refusing it costs nothing either.
 */
export async function hasIdenticalCompensationRecord(
  db: Database,
  record: Pick<NewCompensationRecord, 'employeeId' | 'amountMinor' | 'currency' | 'effectiveFrom'>,
): Promise<boolean> {
  const [found] = await db
    .select({ id: compensationRecords.id })
    .from(compensationRecords)
    .where(
      and(
        eq(compensationRecords.employeeId, record.employeeId),
        eq(compensationRecords.amountMinor, record.amountMinor),
        eq(compensationRecords.currency, record.currency),
        eq(compensationRecords.effectiveFrom, record.effectiveFrom),
      ),
    )
    .limit(1);

  return found !== undefined;
}

/**
 * How many people report to somebody, directly.
 *
 * Not filtered by scope: a Manager may see their own report count, and the only
 * way to reach this is through a record the scope already allowed.
 */
export async function countDirectReports(db: Database, employeeId: number): Promise<number> {
  const [counted] = await rawRows<{ total: number }>(
    db,
    sql`SELECT count(*)::int AS total FROM employees WHERE manager_id = ${employeeId}`,
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
