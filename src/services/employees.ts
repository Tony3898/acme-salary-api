import type { Database } from '../db/database';
import { accessScopeFor, type ScopeSubject } from '../domain/accessScope';
import { currentRecordIndex, withChanges, type PayChange } from '../domain/compensation';
import { toIsoDate } from '../domain/dates';
import { parseAmountToMinor, type Currency } from '../domain/money';
import { AppError, HTTP_STATUS } from '../errors';
import { logger } from '../logger';
import {
  countDirectReports,
  findEmployeeById,
  hasIdenticalCompensationRecord,
  insertCompensationRecord,
  listCompensationHistory,
  listEmployees,
  type CompensationHistoryEntry,
  type EmployeeListRow,
  type EmployeeSortField,
  type SortDirection,
} from '../repositories/employees';

/**
 * Reading the employee list.
 *
 * The service decides *who* the caller may see and turns a page number into an
 * answer; the repository decides how to ask the database. Neither is a route
 * concern, which is why neither lives in one.
 */

export const PAGE_SIZES = [25, 50, 100] as const;
export const DEFAULT_PAGE_SIZE = 25;

export type PageSize = (typeof PAGE_SIZES)[number];

export interface EmployeeListRequest {
  page: number;
  pageSize: PageSize;
  sortBy: EmployeeSortField;
  sortDir: SortDirection;
  search?: string;
  country?: string;
  departmentId?: number;
  jobLevelId?: number;
  status?: 'ACTIVE' | 'LEFT';
  /** Defaults to today. Salaries are reported as they stood on this date. */
  asOf?: string;
}

export interface EmployeeListPage {
  rows: EmployeeListRow[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  asOf: string;
}

export interface EmployeeServiceDeps {
  db: Database;
  now: () => Date;
}

/**
 * A pay record with what it changed, and where it sits relative to the date
 * being viewed.
 *
 * The flags are computed here rather than left to the UI because the rule for
 * "which record is in force" has to be the same one the list query uses. Two
 * implementations of it eventually disagree, and the disagreement looks like a
 * salary that is right on one screen and wrong on the next.
 */
export interface EmployeeHistoryEntry extends CompensationHistoryEntry {
  change: PayChange;
  /** The record in force on the date being viewed. Exactly one, or none. */
  isCurrent: boolean;
  /** Signed off but not yet started. Shown, so the same raise is not given twice. */
  isScheduled: boolean;
}

export interface EmployeeDetail {
  employee: EmployeeListRow;
  directReports: number;
  /** Oldest first, so the changes read down the page in the order they happened. */
  history: EmployeeHistoryEntry[];
  asOf: string;
}

export interface EmployeeService {
  list: (subject: ScopeSubject, request: EmployeeListRequest) => Promise<EmployeeListPage>;
  /**
   * One person, or null when the caller may not see them — which is also what a
   * caller gets for somebody who does not exist. The two are deliberately
   * indistinguishable: a different answer for "not yours" confirms the record
   * is there.
   */
  findById: (
    subject: ScopeSubject,
    request: { id: number; asOf?: string },
  ) => Promise<EmployeeDetail | null>;
  /**
   * Records a new salary and returns the person as they now stand.
   *
   * Returns the whole record rather than just the new row so the screen that
   * asked for it can redraw from one response — and so what it shows is what
   * the database says, not what the client assumed the change would do.
   */
  recordPay: (subject: ScopeSubject, request: RecordPayRequest) => Promise<EmployeeDetail | null>;
}

export interface RecordPayRequest {
  employeeId: number;
  /** A canonical decimal string: "85000.50". Parsed, never floated. */
  amount: string;
  currency: Currency;
  effectiveFrom: string;
  reason?: string;
  /** The account recording it, from the verified token rather than the body. */
  recordedByUserId: number;
}

/**
 * The amount, or a 400 explaining what was wrong with it.
 *
 * `parseAmountToMinor` throws `TypeError` and `RangeError`, which the error
 * handler correctly treats as bugs and answers with a 500. They are not bugs
 * here — they are the client sending "170,000.00" or three decimal places — and
 * a 500 tells whoever typed it nothing while filling the log with alarm.
 *
 * The messages are safe to pass on: they describe the rule and quote the input
 * the client itself just sent. Nothing about the system leaks through them.
 */
function parseAmount(amount: string): number {
  try {
    return parseAmountToMinor(amount);
  } catch (error) {
    if (error instanceof RangeError || error instanceof TypeError) {
      throw new AppError(HTTP_STATUS.BAD_REQUEST, 'INVALID_REQUEST', error.message);
    }
    throw error;
  }
}

export function createEmployeeService(deps: EmployeeServiceDeps): EmployeeService {
  /**
   * Declared once and called from two places, rather than one method reaching
   * for the other through `this`. `this` in an object literal depends on how the
   * method was called, so a caller doing `const { recordPay } = employees` would
   * break it — a bug that appears at the call site and is fixed here.
   */
  async function findDetail(
    subject: ScopeSubject,
    id: number,
    asOf: string,
  ): Promise<EmployeeDetail | null> {
    const scope = accessScopeFor(subject);

    const employee = await findEmployeeById(deps.db, { id, scope, asOf });
    if (employee === null) {
      return null;
    }

    /* Only after the scope has allowed the record. Fetching the history first
       and filtering afterwards would read one person's pay to decide whether to
       show it to somebody else. */
    const records = await listCompensationHistory(deps.db, id);
    const currentIndex = currentRecordIndex(records, asOf);
    const directReports = await countDirectReports(deps.db, id);

    const history = withChanges(records).map((entry, index) => ({
      ...entry,
      isCurrent: index === currentIndex,
      isScheduled: entry.effectiveFrom > asOf,
    }));

    return { employee, directReports, history, asOf };
  }

  return {
    async list(subject: ScopeSubject, request: EmployeeListRequest): Promise<EmployeeListPage> {
      const asOf = request.asOf ?? toIsoDate(deps.now());
      /* The scope is applied inside the query, before the count. A Manager's
         total has to be their team's, or the footer discloses the company
         headcount to somebody who cannot see a single one of those people. */
      const scope = accessScopeFor(subject);

      const { rows, total } = await listEmployees(deps.db, {
        ...request,
        scope,
        asOf,
      });

      return {
        rows,
        page: request.page,
        pageSize: request.pageSize,
        total,
        /* Zero results is zero pages, not one empty one — the difference the
           pager shows as "Page 1 of 0". */
        totalPages: Math.ceil(total / request.pageSize),
        asOf,
      };
    },

    async findById(
      subject: ScopeSubject,
      request: { id: number; asOf?: string },
    ): Promise<EmployeeDetail | null> {
      return findDetail(subject, request.id, request.asOf ?? toIsoDate(deps.now()));
    },

    async recordPay(
      subject: ScopeSubject,
      request: RecordPayRequest,
    ): Promise<EmployeeDetail | null> {
      const today = toIsoDate(deps.now());
      const scope = accessScopeFor(subject);

      /* The scope decides first, even though only HR Admin can reach this route.
         The route guard says which roles may write; the scope says whose records
         exist as far as this caller is concerned, and the answer for somebody
         they cannot see has to be the same 404 a reader gets. */
      const employee = await findEmployeeById(deps.db, {
        id: request.employeeId,
        scope,
        asOf: today,
      });
      if (employee === null) {
        return null;
      }

      const amountMinor = parseAmount(request.amount);

      if (request.effectiveFrom < employee.hireDate) {
        throw new AppError(
          HTTP_STATUS.BAD_REQUEST,
          'INVALID_REQUEST',
          `A salary cannot start before the hire date of ${employee.hireDate}.`,
        );
      }

      const duplicate = await hasIdenticalCompensationRecord(deps.db, {
        employeeId: request.employeeId,
        amountMinor,
        currency: request.currency,
        effectiveFrom: request.effectiveFrom,
      });

      if (duplicate) {
        throw new AppError(
          HTTP_STATUS.BAD_REQUEST,
          'INVALID_REQUEST',
          'That exact record already exists for this date. It has not been added again.',
        );
      }

      await insertCompensationRecord(deps.db, {
        employeeId: request.employeeId,
        amountMinor,
        currency: request.currency,
        effectiveFrom: request.effectiveFrom,
        reason: request.reason ?? null,
        createdBy: request.recordedByUserId,
      });

      logger.info('compensation.recorded', {
        employeeId: request.employeeId,
        effectiveFrom: request.effectiveFrom,
        currency: request.currency,
        recordedByUserId: request.recordedByUserId,
        /* The amount is deliberately absent. An operator debugging a failed
           write does not need to know what anybody earns, and a log is the
           easiest place in a system to read without being noticed. */
      });

      return findDetail(subject, request.employeeId, today);
    },
  };
}
