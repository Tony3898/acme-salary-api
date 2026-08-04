import type { Role } from './roles';

/**
 * Which employees a signed-in user is allowed to see.
 *
 * Decided once, here, and applied inside the query rather than checked on each
 * route. A route guard stops somebody *doing* things; it does not stop a Manager
 * opening a page that reads company-wide figures, because that is only reading.
 * Applying the scope at the data layer covers every path, including the ones
 * written later.
 *
 * This module stays free of SQL: it answers *what* a user may see, and
 * repositories/employees.ts turns that answer into a condition. That keeps the
 * rule testable without a database, and keeps one place to change when a role is
 * added.
 */

export type AccessScope =
  /** Both HR roles. Read-only versus read-write is a route concern, not a scope. */
  | { kind: 'ALL' }
  /** A Manager: everybody below them in the reporting chain, and themselves. */
  | { kind: 'TEAM'; managerEmployeeId: number }
  /** An Employee: exactly one record. */
  | { kind: 'SELF'; employeeId: number }
  /** Nobody. A scoped login with no employee attached — see below. */
  | { kind: 'NONE' };

export interface ScopeSubject {
  role: Role;
  employeeId: number | null;
}

export function accessScopeFor(subject: ScopeSubject): AccessScope {
  switch (subject.role) {
    case 'HR_ADMIN':
    case 'HR_VIEWER':
      return { kind: 'ALL' };

    case 'MANAGER':
      /* Should be unreachable: the database refuses a scoped login without an
         employee, and the token schema refuses such a claim. If both are somehow
         bypassed, the answer is nothing rather than everything — the failure a
         permissions bug should have. */
      return subject.employeeId === null
        ? { kind: 'NONE' }
        : { kind: 'TEAM', managerEmployeeId: subject.employeeId };

    case 'EMPLOYEE':
      return subject.employeeId === null
        ? { kind: 'NONE' }
        : { kind: 'SELF', employeeId: subject.employeeId };
  }
}

/**
 * Whether a scope covers enough people for aggregate figures to be publishable.
 *
 * A median over three people is not a statistic, it is those three salaries with
 * one step of arithmetic in front. So the statistics screens are HR-only, and a
 * Manager is told so rather than being shown their team's averages.
 */
export function canSeeAggregates(scope: AccessScope): boolean {
  return scope.kind === 'ALL';
}
