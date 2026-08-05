import { isUniqueViolation, type Database } from '../db/database';
import { COMPENSATION_UNIQUE_RECORD } from '../db/schema';
import { accessScopeFor, type ScopeSubject } from '../domain/accessScope';
import { toIsoDate } from '../domain/dates';
import { parseAmountToMinor, type Currency } from '../domain/money';
import { AppError, HTTP_STATUS } from '../shared/errors';
import { logger } from '../shared/logger';
import type { BandFitFilter } from '../repositories/payBands';
import {
  countActiveDirectReports,
  emailIsTaken,
  findEmployeeById,
  findMissingReferences,
  insertCompensationRecord,
  insertEmployee,
  listEmployees,
  updateEmployeeStatus,
  type EmployeeListRow,
  type EmployeeSortField,
  type SortDirection,
} from '../repositories/employees';
import { findEmployeeDetail, type EmployeeDetail } from './employeeDetail';

export type { EmployeeDetail, EmployeeHistoryEntry } from './employeeDetail';

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
  /** How their pay sits against their band. See the repository for the six outcomes. */
  bandFit?: BandFitFilter;
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
  /** Adds somebody, and returns their record as it now reads. */
  create: (subject: ScopeSubject, request: CreateEmployeeRequest) => Promise<EmployeeDetail>;
  /** Marks somebody as having left, or brings them back. */
  changeStatus: (
    subject: ScopeSubject,
    request: ChangeStatusRequest,
  ) => Promise<EmployeeDetail | null>;
}

/**
 * Ending somebody's employment, or reversing that.
 *
 * Deliberately not a general "update the employee" request. Status is the one
 * field on an employee whose change has consequences elsewhere — it moves them in
 * and out of every payroll total, every median and every band comparison — so it
 * is its own operation with its own rules, rather than one key in a patch body
 * where those rules would have to be found before they could be applied.
 */
export interface ChangeStatusRequest {
  employeeId: number;
  status: 'ACTIVE' | 'LEFT';
  /**
   * Their last day. Required when marking somebody as having left; refused when
   * bringing them back, where there is no such day.
   */
  leftOn?: string;
  /** The account making the change, from the verified token rather than the body. */
  changedByUserId: number;
}

export interface CreateEmployeeRequest {
  fullName: string;
  email: string;
  country: string;
  departmentId: number;
  jobLevelId: number;
  jobTitle?: string;
  hireDate: string;
  managerId?: number;
  status?: 'ACTIVE' | 'LEFT';
  /** Required when the status is LEFT. Ignored otherwise. */
  leftOn?: string;
  /**
   * What they start on, if it is known. Optional because a record is often
   * created before the offer is signed off, and an invented starting salary is
   * worse than a gap the list can show as "not recorded".
   */
  startingPay?: {
    /** A canonical decimal string: "85000.50". Parsed, never floated. */
    amount: string;
    currency: Currency;
    /** Defaults to the hire date, which is when the salary starts by definition. */
    effectiveFrom?: string;
  };
  /** The account creating it, from the verified token rather than the body. */
  createdByUserId: number;
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
   * The record as it now stands, which every write below answers with.
   *
   * A local function rather than one method reaching for another through `this`.
   * `this` in an object literal depends on how the method was called, so a caller
   * doing `const { recordPay } = employees` would break it — a bug that appears
   * at the call site and is fixed here.
   */
  const findDetail = (
    subject: ScopeSubject,
    id: number,
    asOf: string,
  ): Promise<EmployeeDetail | null> => findEmployeeDetail(deps.db, subject, id, asOf);

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

      /* The duplicate check is the insert itself. Asking first and then writing
         leaves a window in which a double-clicked button writes the raise twice, and
         the table is append-only — there is no undo. So the write goes ahead and the
         constraint's refusal becomes the message. */
      try {
        await insertCompensationRecord(deps.db, {
          employeeId: request.employeeId,
          amountMinor,
          currency: request.currency,
          effectiveFrom: request.effectiveFrom,
          reason: request.reason ?? null,
          createdBy: request.recordedByUserId,
        });
      } catch (error) {
        if (isUniqueViolation(error, COMPENSATION_UNIQUE_RECORD)) {
          throw new AppError(
            HTTP_STATUS.BAD_REQUEST,
            'INVALID_REQUEST',
            'That exact record already exists for this date. It has not been added again.',
          );
        }
        throw error;
      }

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

    async create(subject: ScopeSubject, request: CreateEmployeeRequest): Promise<EmployeeDetail> {
      /* Lower-cased once, here, because the unique index is on lower(email) and
         because an address that differs only in capitalisation is the same
         address. Storing what was typed and searching for something else is how
         a duplicate gets in. */
      const email = request.email.trim().toLowerCase();
      const managerId = request.managerId ?? null;

      /* Both checks at once — they ask different tables and neither depends on
         the other's answer. The *order the failures are reported in* is still
         chosen rather than incidental: a duplicate address is the mistake
         somebody actually made, where a missing department usually means a
         dropdown went stale under them, so the email wins when both are wrong. */
      const [taken, missing] = await Promise.all([
        emailIsTaken(deps.db, email),
        findMissingReferences(deps.db, {
          departmentId: request.departmentId,
          jobLevelId: request.jobLevelId,
          managerId,
        }),
      ]);

      if (taken) {
        throw new AppError(
          HTTP_STATUS.BAD_REQUEST,
          'INVALID_REQUEST',
          'Somebody already has that email address.',
        );
      }

      /* Named individually. "Invalid request" for a stale dropdown option tells
         whoever is filling the form nothing about which field to look at. */
      if (missing.department) {
        throw invalidReference('department');
      }
      if (missing.jobLevel) {
        throw invalidReference('job level');
      }
      if (missing.manager) {
        throw invalidReference('manager');
      }

      /* A record can be created for somebody who has already left — historic
         staff arriving with the spreadsheet import — so the leaving date is
         validated on the way in rather than assumed absent. */
      const status = request.status ?? 'ACTIVE';
      const leftOn = leavingDateFor({
        status,
        leftOn: request.leftOn,
        hireDate: request.hireDate,
      });

      const pay = request.startingPay;
      const effectiveFrom = pay?.effectiveFrom ?? request.hireDate;

      if (pay !== undefined && effectiveFrom < request.hireDate) {
        throw new AppError(
          HTTP_STATUS.BAD_REQUEST,
          'INVALID_REQUEST',
          `A salary cannot start before the hire date of ${request.hireDate}.`,
        );
      }

      const id = await insertEmployee(
        deps.db,
        {
          fullName: request.fullName,
          email,
          country: request.country,
          departmentId: request.departmentId,
          jobLevelId: request.jobLevelId,
          jobTitle: request.jobTitle ?? null,
          hireDate: request.hireDate,
          managerId,
          status,
          leftOn: status === 'LEFT' ? leftOn : null,
        },
        pay === undefined
          ? null
          : {
              amountMinor: parseAmount(pay.amount),
              currency: pay.currency,
              effectiveFrom,
              reason: 'Hired',
              createdBy: request.createdByUserId,
            },
      );

      logger.info('employee.created', {
        employeeId: id,
        country: request.country,
        departmentId: request.departmentId,
        jobLevelId: request.jobLevelId,
        withStartingPay: pay !== undefined,
        createdByUserId: request.createdByUserId,
        /* No name, no email, no amount. An operator debugging a failed write
           does not need to know who was hired or on what. */
      });

      const detail = await findDetail(subject, id, toIsoDate(deps.now()));
      if (detail === null) {
        /* Only reachable if the caller's scope excludes what they just created,
           which HR Admin's does not. A 500 is right: it would mean the guard on
           this route and the scope disagree. */
        throw new Error(`Created employee ${String(id)} is not visible to its creator.`);
      }
      return detail;
    },

    async changeStatus(
      subject: ScopeSubject,
      request: ChangeStatusRequest,
    ): Promise<EmployeeDetail | null> {
      const today = toIsoDate(deps.now());
      const scope = accessScopeFor(subject);

      /* The scope decides first, as it does for every write. The route guard says
         which roles may change a status; the scope says whose records exist as far
         as this caller is concerned, and for somebody they cannot see the answer
         has to be the same 404 a reader gets. */
      const employee = await findEmployeeById(deps.db, {
        id: request.employeeId,
        scope,
        asOf: today,
      });
      if (employee === null) {
        return null;
      }

      const leftOn = leavingDateFor({
        status: request.status,
        leftOn: request.leftOn,
        hireDate: employee.hireDate,
      });

      if (request.status === 'LEFT') {
        /* Refused while anybody still reports to them. A departed manager leaves
           their team pointing at somebody who is no longer here, which quietly
           breaks the Manager access scope for everybody underneath — they would
           be scoped to a person who cannot sign in. Naming the count makes the
           next step obvious: reassign them first. */
        const reports = await countActiveDirectReports(deps.db, request.employeeId);

        if (reports > 0) {
          throw new AppError(
            HTTP_STATUS.BAD_REQUEST,
            'INVALID_REQUEST',
            `${String(reports)} ${reports === 1 ? 'person still reports' : 'people still report'} to ${employee.fullName}. Move them to another manager first.`,
          );
        }
      }

      /* Not refused when the status is already what was asked for. Setting a
         leaver's date to a corrected day goes through this same call, and
         rejecting "no change" would also make the button fail for anybody who
         clicked it twice. The write is idempotent, so there is nothing to
         protect against. */
      const changed = await updateEmployeeStatus(deps.db, {
        id: request.employeeId,
        status: request.status,
        leftOn,
      });

      if (!changed) {
        /* The row existed a moment ago and the scope allowed it. Deleted in
           between is the only way here, and employees are not deleted. */
        return null;
      }

      logger.info('employee.statusChanged', {
        employeeId: request.employeeId,
        status: request.status,
        changedByUserId: request.changedByUserId,
        /* No name and no leaving date. Who left and when is personnel
           information, and a log is the easiest place in a system to read
           without being noticed. */
      });

      return findDetail(subject, request.employeeId, today);
    },
  };
}

/**
 * The leaving date a status implies, or a 400 explaining what is wrong with it.
 *
 * The database enforces "both or neither" as a constraint, which would surface as
 * a 500 written for whoever is on call. This turns the same three mistakes into
 * messages that name the field, and is the only place the pairing rule is
 * expressed in application code — the create path and the status change both come
 * through here.
 */
function leavingDateFor(request: {
  status: 'ACTIVE' | 'LEFT';
  leftOn: string | undefined;
  hireDate: string;
}): string | null {
  if (request.status === 'ACTIVE') {
    if (request.leftOn !== undefined) {
      throw new AppError(
        HTTP_STATUS.BAD_REQUEST,
        'INVALID_REQUEST',
        'Somebody who is still employed has no leaving date.',
      );
    }
    return null;
  }

  if (request.leftOn === undefined) {
    throw new AppError(
      HTTP_STATUS.BAD_REQUEST,
      'INVALID_REQUEST',
      'A leaving date is required. Without one, every historic payroll figure would count this person as never having been here.',
    );
  }

  if (request.leftOn < request.hireDate) {
    throw new AppError(
      HTTP_STATUS.BAD_REQUEST,
      'INVALID_REQUEST',
      `A leaving date cannot come before the hire date of ${request.hireDate}.`,
    );
  }

  return request.leftOn;
}

/** A dropdown option that no longer exists, or an id somebody typed by hand. */
function invalidReference(field: string): AppError {
  return new AppError(
    HTTP_STATUS.BAD_REQUEST,
    'INVALID_REQUEST',
    `That ${field} does not exist. It may have been removed since this page loaded.`,
  );
}
