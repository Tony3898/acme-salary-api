import { accessScopeFor, canSeeAggregates } from '../../src/domain/accessScope';
import { ROLES } from '../../src/domain/roles';

describe('accessScopeFor', () => {
  it.each(['HR_ADMIN', 'HR_VIEWER'] as const)(
    'given a %s, when the scope is decided, then it covers everybody',
    (role) => {
      // Read-only versus read-write is a route concern; it does not narrow visibility.
      expect(accessScopeFor({ role, employeeId: null })).toEqual({ kind: 'ALL' });
    },
  );

  it('given a Manager, when the scope is decided, then it is their reporting chain', () => {
    expect(accessScopeFor({ role: 'MANAGER', employeeId: 42 })).toEqual({
      kind: 'TEAM',
      managerEmployeeId: 42,
    });
  });

  it('given an Employee, when the scope is decided, then it is only themselves', () => {
    expect(accessScopeFor({ role: 'EMPLOYEE', employeeId: 42 })).toEqual({
      kind: 'SELF',
      employeeId: 42,
    });
  });

  it.each(['MANAGER', 'EMPLOYEE'] as const)(
    'given a %s with no employee attached, when the scope is decided, then it is nobody',
    (role) => {
      /* Should be unreachable — the database and the token schema both refuse it.
         If they are ever bypassed, the failure has to be "sees nothing", which is
         noticed, rather than "sees everything", which is not. */
      expect(accessScopeFor({ role, employeeId: null })).toEqual({ kind: 'NONE' });
    },
  );

  it('given every role, when the scope is decided, then one is defined for each', () => {
    /* Adding a role without deciding its scope is the mistake this catches. The
       compiler catches it too, but only for someone who runs it. */
    for (const role of ROLES) {
      expect(accessScopeFor({ role, employeeId: 1 }).kind).not.toBeUndefined();
    }
  });
});

describe('canSeeAggregates', () => {
  it('given an HR role, when statistics are requested, then they are allowed', () => {
    expect(canSeeAggregates(accessScopeFor({ role: 'HR_ADMIN', employeeId: null }))).toBe(true);
  });

  it.each(['MANAGER', 'EMPLOYEE'] as const)(
    'given a %s, when statistics are requested, then they are not',
    (role) => {
      /* Not "statistics narrowed to their team": a median over three people is
         those three salaries with one step of arithmetic in front of it. */
      expect(canSeeAggregates(accessScopeFor({ role, employeeId: 9 }))).toBe(false);
    },
  );
});
