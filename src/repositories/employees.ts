import { and, eq, sql, type SQL } from 'drizzle-orm';
import { rawRows, type Database } from '../db/database';
import { compensationRecords, employees } from '../db/schema';
import type { AccessScope } from '../domain/accessScope';
import {
  employeeFilterConditions,
  scopeCondition,
  searchCondition,
  statusCondition,
  teamCte,
  whereFrom,
} from './employeeFilters';
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

/**
 * The columns `EMPLOYEE_COLUMNS` selects, for both the list and one record.
 *
 * The window-function total is *not* here. It belongs to a page of results, and
 * having it on the shared type meant the single-record query selected a
 * hard-coded `1 AS total_count` to satisfy a field nothing reads — a lie in the
 * SQL to keep a type happy.
 */
interface RawEmployeeColumns {
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
}

/** A row from the list, which also carries how many the filters matched. */
interface RawEmployeeListRow extends RawEmployeeColumns {
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
 * Who this page is about: the scope, the filters and the search, together.
 *
 * The filters themselves are shared with the statistics — see
 * employeeFilters.ts, which exists because these two had a copy each and the
 * copies had already drifted.
 */
function listConditions(query: EmployeeListQuery): SQL[] {
  return [
    scopeCondition(query.scope),
    ...searchCondition(query.search),
    ...employeeFilterConditions(query),
    ...statusCondition(query.status ?? 'ALL'),
  ];
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
  const rows = await rawRows<RawEmployeeListRow>(db, buildEmployeeListQuery(query));

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
  const where = whereFrom(listConditions(query));

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
  const where = whereFrom(listConditions(query));

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
  const rows = await rawRows<RawEmployeeColumns>(
    db,
    sql`
      ${teamCte(query.scope)}
      SELECT ${EMPLOYEE_COLUMNS}
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

/** Everything the employees table needs, with nothing optional left implicit. */
export interface NewEmployee {
  fullName: string;
  /** Already trimmed and lower-cased by the service; the index is on lower(email). */
  email: string;
  country: string;
  departmentId: number;
  jobLevelId: number;
  jobTitle: string | null;
  hireDate: string;
  managerId: number | null;
  status: 'ACTIVE' | 'LEFT';
}

/** The salary somebody starts on, if it is known when the record is created. */
export interface FirstPay {
  amountMinor: number;
  currency: Currency;
  effectiveFrom: string;
  reason: string | null;
  createdBy: number;
}

/**
 * Whether the ids a new record points at actually exist.
 *
 * Checked before inserting rather than letting the foreign keys refuse it. A
 * constraint violation is a 500 with a message written for whoever is on call;
 * this turns the same mistake into a 400 that names the field.
 *
 * One statement rather than three: they are three questions about three tables
 * and there is no reason to pay three round trips for them.
 */
export async function findMissingReferences(
  db: Database,
  references: { departmentId: number; jobLevelId: number; managerId: number | null },
): Promise<{ department: boolean; jobLevel: boolean; manager: boolean }> {
  const [row] = await rawRows<{ department: boolean; job_level: boolean; manager: boolean }>(
    db,
    sql`
      SELECT
        NOT EXISTS (SELECT 1 FROM departments WHERE id = ${references.departmentId}) AS department,
        NOT EXISTS (SELECT 1 FROM job_levels WHERE id = ${references.jobLevelId}) AS job_level,
        (
          ${references.managerId}::int IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM employees WHERE id = ${references.managerId})
        ) AS manager
    `,
  );

  if (row === undefined) {
    throw new Error('The reference check returned no row, which should be impossible.');
  }
  return { department: row.department, jobLevel: row.job_level, manager: row.manager };
}

/**
 * Whether an address is already on somebody's record.
 *
 * Case-insensitively, matching the unique index. Two people differing only in
 * capitalisation is an ambiguity, and the address is how a person is found.
 */
export async function emailIsTaken(db: Database, email: string): Promise<boolean> {
  const [found] = await rawRows<{ id: number }>(
    db,
    sql`SELECT id FROM employees WHERE lower(email) = lower(${email}) LIMIT 1`,
  );

  return found !== undefined;
}

/**
 * Creates a person, with their starting salary if one is known.
 *
 * In a transaction, because the two halves are one decision. Without it, a
 * failure between them leaves somebody hired with no pay and nobody aware of
 * it — and the fix is a salary backdated by however long it took to notice.
 */
export async function insertEmployee(
  db: Database,
  employee: NewEmployee,
  pay: FirstPay | null,
): Promise<number> {
  return db.transaction(async (tx) => {
    const [inserted] = await tx.insert(employees).values(employee).returning({ id: employees.id });

    if (inserted === undefined) {
      throw new Error(`Failed to create the record for ${employee.email}.`);
    }

    if (pay !== null) {
      await tx.insert(compensationRecords).values({ employeeId: inserted.id, ...pay });
    }

    return inserted.id;
  });
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

function toEmployeeListRow(row: RawEmployeeColumns): EmployeeListRow {
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

function toSalary(row: RawEmployeeColumns): EmployeeListRow['salary'] {
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
