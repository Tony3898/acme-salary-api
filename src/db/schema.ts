import { sql } from 'drizzle-orm';
import {
  bigint,
  char,
  check,
  date,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { MAX_AMOUNT_MINOR, SUPPORTED_CURRENCIES } from '../domain/money';
import { ROLES } from '../domain/roles';

/**
 * Conventions used throughout:
 *
 * - Money is `bigint` in whole minor units, in mode 'number'. Exact to 2^53
 *   minor units — about $90tn — which is checked in src/domain/money.ts.
 * - Calendar dates are `date` in mode 'string', so they stay YYYY-MM-DD and
 *   never shift across time zones. Only audit timestamps are `timestamptz`.
 * - Constraints the database can enforce live here rather than in service code,
 *   so no code path can forget them.
 */

/**
 * Currencies come from the domain, so the database and the arithmetic cannot
 * disagree about which are supported. Adding one is a migration, deliberately:
 * a currency without two decimal places would break every calculation.
 */
export const currencyEnum = pgEnum('currency', SUPPORTED_CURRENCIES);

export const employeeStatusEnum = pgEnum('employee_status', ['ACTIVE', 'LEFT']);

/** NULL means not recorded, which is distinct from OTHER. */
export const genderEnum = pgEnum('gender', ['FEMALE', 'MALE', 'OTHER']);

/** From the domain, so a role the code knows and the database rejects cannot exist. */
export const userRoleEnum = pgEnum('user_role', ROLES);

export const departments = pgTable('departments', {
  id: serial('id').primaryKey(),
  name: text('name').notNull().unique(),
});

export const jobLevels = pgTable('job_levels', {
  id: serial('id').primaryKey(),
  name: text('name').notNull().unique(),
  /** Sort order for "seniority", so levels order correctly without parsing names. */
  rank: integer('rank').notNull().unique(),
});

export const employees = pgTable(
  'employees',
  {
    id: serial('id').primaryKey(),
    fullName: text('full_name').notNull(),
    email: text('email').notNull(),
    /** ISO 3166-1 alpha-2. Pay bands and exchange rates hang off this. */
    country: char('country', { length: 2 }).notNull(),
    departmentId: integer('department_id')
      .notNull()
      .references(() => departments.id),
    jobLevelId: integer('job_level_id')
      .notNull()
      .references(() => jobLevels.id),
    jobTitle: text('job_title'),
    hireDate: date('hire_date', { mode: 'string' }).notNull(),
    /** Self-reference: drives the recursive "everyone under this manager" scope. */
    managerId: integer('manager_id').references((): AnyPgColumn => employees.id),
    status: employeeStatusEnum('status').notNull().default('ACTIVE'),
    /**
     * The last day they were employed. NULL while they still are.
     *
     * A date rather than a flag beside `status`, because without it "who was on
     * the payroll last March" has no answer — a leaver looks as though they were
     * never there, and every historic total is quietly too small. Status alone
     * says *whether*; only this says *when*.
     */
    leftOn: date('left_on', { mode: 'string' }),
    gender: genderEnum('gender'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Case-insensitive: two people differing only in capitalisation is an ambiguity.
    uniqueIndex('employees_email_lower_idx').on(sql`lower(${table.email})`),
    index('employees_manager_idx').on(table.managerId),
    index('employees_department_idx').on(table.departmentId),
    index('employees_job_level_idx').on(table.jobLevelId),
    index('employees_country_idx').on(table.country),
    index('employees_status_idx').on(table.status),
    /* Both or neither, enforced here so no code path can produce a leaver with no
       leaving date or an active employee carrying one. The pair is read together
       everywhere — a historic payroll figure asks "had they left by then?" and
       needs the answer to be a date, not a guess. */
    check(
      'employee_left_on_matches_status',
      sql`(${table.status} = 'LEFT') = (${table.leftOn} IS NOT NULL)`,
    ),
    // Nobody leaves before they arrive, and a typo here silently rewrites history.
    check(
      'employee_left_on_after_hire',
      sql`${table.leftOn} IS NULL OR ${table.leftOn} >= ${table.hireDate}`,
    ),
  ],
);

/**
 * The index that refuses a duplicate pay record.
 *
 * Named here because two places need the same string: the index below, and the code
 * that recognises the violation it raises. A constraint whose name is typed out twice
 * is one rename away from an error message nobody catches.
 */
export const COMPENSATION_UNIQUE_RECORD = 'compensation_no_identical_record_idx';

/**
 * Append-only. A raise inserts a row; nothing here is ever updated, which is
 * what makes it an audit trail as well as a salary history.
 *
 * Not unique on (employee_id, effective_from): a correction issued the same day to a
 * *different* figure is legitimate, and reads break the tie with `id DESC`. It **is**
 * unique on the whole tuple, which is what makes refusing a duplicate atomic rather
 * than a check followed by a write — see the index below.
 */
export const compensationRecords = pgTable(
  'compensation_records',
  {
    id: serial('id').primaryKey(),
    employeeId: integer('employee_id')
      .notNull()
      .references(() => employees.id),
    amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
    currency: currencyEnum('currency').notNull(),
    effectiveFrom: date('effective_from', { mode: 'string' }).notNull(),
    reason: text('reason'),
    /* Who recorded it. NULL means the record predates this system — the history
       carried over from the spreadsheets it replaced, which has no author. */
    createdBy: integer('created_by').references((): AnyPgColumn => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /* Two checks rather than one, so a violation names the rule it broke. The
       ceiling is sql.raw because a CHECK constraint is DDL and cannot carry a
       bound parameter — the value is an imported constant, never user input. */
    check('compensation_amount_positive', sql`${table.amountMinor} > 0`),
    check(
      'compensation_amount_within_exact_range',
      sql`${table.amountMinor} <= ${sql.raw(String(MAX_AMOUNT_MINOR))}`,
    ),
    // Covers "current salary as of a date", which every list query needs.
    index('compensation_employee_effective_idx').on(table.employeeId, table.effectiveFrom.desc()),
    /**
     * The same amount, in the same currency, on the same day, for the same person.
     *
     * That is a double-submitted button or a retried request, never a decision
     * anybody made twice — a correction to the same figure on the same day changes
     * nothing, so refusing it costs nothing. A *different* figure on the same day is
     * still allowed, which is what makes this the whole tuple rather than the pair.
     *
     * Here rather than in application code, and *only* here. Reading "is there one
     * already?" and then inserting leaves a window between the two: two requests
     * arriving together both read "no" and both write — which in an append-only table
     * is a raise paid twice with no way to undo it. So the check is the write. The
     * application turns the violation into its message rather than trying to predict
     * it, which is both atomic and one query instead of two.
     */
    uniqueIndex(COMPENSATION_UNIQUE_RECORD).on(
      table.employeeId,
      table.effectiveFrom,
      table.amountMinor,
      table.currency,
    ),
  ],
);

/**
 * Expected pay range per level per country, in that country's own currency.
 * Fairness is judged against the local band, never against a converted amount.
 */
export const salaryBands = pgTable(
  'salary_bands',
  {
    id: serial('id').primaryKey(),
    jobLevelId: integer('job_level_id')
      .notNull()
      .references(() => jobLevels.id),
    country: char('country', { length: 2 }).notNull(),
    currency: currencyEnum('currency').notNull(),
    minMinor: bigint('min_minor', { mode: 'number' }).notNull(),
    midMinor: bigint('mid_minor', { mode: 'number' }).notNull(),
    maxMinor: bigint('max_minor', { mode: 'number' }).notNull(),
  },
  (table) => [
    // One band per level per country, or "is this person paid fairly" has two answers.
    uniqueIndex('salary_bands_level_country_idx').on(table.jobLevelId, table.country),
    check(
      'salary_band_ordered',
      sql`${table.minMinor} > 0 AND ${table.minMinor} <= ${table.midMinor} AND ${table.midMinor} <= ${table.maxMinor}`,
    ),
  ],
);

/**
 * A single dated snapshot, applied when reading. One row per currency, so a
 * conversion has exactly one answer. Rate history is out of scope — see
 * docs/requirements.md.
 */
export const fxRates = pgTable(
  'fx_rates',
  {
    currency: currencyEnum('currency').primaryKey(),
    /** numeric, not float: a rate multiplied across 10,000 salaries must not drift. */
    rateToUsd: numeric('rate_to_usd', { precision: 18, scale: 8 }).notNull(),
    asOf: date('as_of', { mode: 'string' }).notNull(),
  },
  (table) => [check('fx_rate_positive', sql`${table.rateToUsd} > 0`)],
);

/**
 * Logins are separate from employees: not every employee needs one, and a
 * service account belongs to no employee. `employeeId` links a login to the
 * person, which is what Manager and Employee access scopes resolve against.
 */
export const users = pgTable(
  'users',
  {
    id: serial('id').primaryKey(),
    email: text('email').notNull(),
    /** argon2id. There is deliberately no column that could hold a plaintext password. */
    passwordHash: text('password_hash').notNull(),
    role: userRoleEnum('role').notNull(),
    employeeId: integer('employee_id').references(() => employees.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('users_email_lower_idx').on(sql`lower(${table.email})`),
    /* A Manager or Employee login is scoped by *which* employee it belongs to, so
       one without an employee is a login that can see nothing — and would make
       the access-scope function answer a question with no answer. HR roles see
       everyone, so they need no link. */
    check(
      'users_scoped_role_needs_employee',
      sql`${table.role} IN ('HR_ADMIN', 'HR_VIEWER') OR ${table.employeeId} IS NOT NULL`,
    ),
  ],
);

/**
 * Why a refresh token stopped being usable.
 *
 * The distinction matters when a dead token is presented again. One that was
 * rotated should not be in anybody's hands, so a replay is a theft signal. One
 * the user logged out of is expected to be replayed — a background tab retrying
 * after another tab signed out — and must not end that person's other sessions.
 */
export const refreshTokenRevocationEnum = pgEnum('refresh_token_revocation', [
  'ROTATED',
  'LOGGED_OUT',
  'REUSE_DETECTED',
]);

/**
 * Refresh tokens are stored hashed, so a database leak cannot be replayed as a
 * session. `revokedAt` is what makes logout end the session rather than merely
 * dropping the cookie.
 */
export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedReason: refreshTokenRevocationEnum('revoked_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('refresh_tokens_user_idx').on(table.userId),
    /* Both or neither. A revoked token with no reason would make the replay check
       fall through to its safest branch for the wrong reason. */
    check(
      'refresh_token_revocation_complete',
      sql`(${table.revokedAt} IS NULL) = (${table.revokedReason} IS NULL)`,
    ),
  ],
);
