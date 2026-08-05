import { sql, type SQL } from 'drizzle-orm';
import type { Currency } from '../domain/money';
import { bandStanding, type BandStanding } from '../domain/payBand';
import { BAND_COLUMNS, BAND_JOIN, toPayBand, type RawBandColumns } from './payBands';

/**
 * What an employee row is, in one place: the columns, the joins, and the shape
 * they become.
 *
 * Three queries answer the same question about different numbers of people — the
 * list, one record, and the needs-attention list — and each needs pay as it stood
 * on a date, the manager's name, and the band that applies. Written three times
 * they drift: a column added to the list would be missing from the detail page,
 * or two of them would convert currency differently and disagree by a cent.
 *
 * Separated from repositories/employees.ts because that file owns *asking
 * questions about* employees, and this owns *what comes back*. The needs-attention
 * query needs the second without inheriting the first.
 */

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
  managerEmail: string | null;
  status: 'ACTIVE' | 'LEFT';
  /** The last day they were employed, or null while they still are. */
  leftOn: string | null;
  /** Null for somebody with no compensation record on or before the date asked for. */
  salary: {
    amountMinor: number;
    currency: Currency;
    /** The same amount in USD cents, for comparing across countries. */
    amountUsdMinor: number;
    effectiveFrom: string;
  } | null;
  /**
   * How their pay sits against the band for their level in their country.
   *
   * On every row rather than fetched separately, because it is the answer to "is
   * this person paid fairly" and that question is asked on the list, on their
   * page, and by the bulk-raise preview. One join here is cheaper than three
   * screens each deciding how to work it out.
   */
  band: BandStanding;
}

/**
 * The columns `EMPLOYEE_COLUMNS` selects.
 *
 * A window-function total is deliberately *not* here. It belongs to a page of
 * results, and having it on the shared type meant the single-record query
 * selected a hard-coded `1 AS total_count` to satisfy a field nothing reads — a
 * lie in the SQL to keep a type happy.
 */
export interface RawEmployeeColumns extends RawBandColumns {
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
  manager_email: string | null;
  status: 'ACTIVE' | 'LEFT';
  left_on: string | null;
  amount_minor: number | null;
  currency: Currency | null;
  effective_from: string | null;
  salary_usd_minor: number | null;
}

export const EMPLOYEE_COLUMNS = sql`
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
  /* The manager's address as well as their name, because the CSV export names
     managers by email and the import resolves them the same way — that symmetry
     is what makes an exported file re-importable. */
  m.email AS manager_email,
  e.status,
  e.left_on,
  current_pay.amount_minor,
  current_pay.currency,
  current_pay.effective_from,
  round(current_pay.amount_minor * fx.rate_to_usd)::bigint AS salary_usd_minor,
  ${BAND_COLUMNS}
`;

/**
 * The joins behind those columns, with pay resolved to a date.
 *
 * The aliases here — `e`, `d`, `jl`, `m`, `current_pay`, `fx`, `b` — are part of
 * the contract: the filter conditions in employeeFilters.ts and the band
 * predicates in payBands.ts are written against them.
 */
export function employeeFrom(asOf: string): SQL {
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
    ${BAND_JOIN}
  `;
}

export function toEmployeeListRow(row: RawEmployeeColumns): EmployeeListRow {
  const salary = toSalary(row);

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
    managerEmail: row.manager_email,
    status: row.status,
    leftOn: row.left_on,
    salary,
    /* The comparison is the domain's, from the band columns this row already
       carries. The needs-attention query has to express "below band" in SQL to
       filter and sort thousands of rows, and payBands.ts keeps the two
       definitions side by side so they can be held against each other. */
    band: bandStanding(salary, toPayBand(row)),
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
