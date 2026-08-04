import type { Database } from '../db/database';
import { accessScopeFor, type ScopeSubject } from '../domain/accessScope';
import { toIsoDate } from '../domain/dates';
import {
  listEmployees,
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

export interface EmployeeService {
  list: (subject: ScopeSubject, request: EmployeeListRequest) => Promise<EmployeeListPage>;
}

export function createEmployeeService(deps: EmployeeServiceDeps): EmployeeService {
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
  };
}
