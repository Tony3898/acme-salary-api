/**
 * The four roles, in one place.
 *
 * Kept apart from tokens.ts so the database schema can build its enum from this
 * list without importing a JWT library — the same trick as currencies, and for
 * the same reason: the database and the code cannot disagree about what a role
 * is, because there is only one list.
 */
export const ROLES = ['HR_ADMIN', 'HR_VIEWER', 'MANAGER', 'EMPLOYEE'] as const;

export type Role = (typeof ROLES)[number];

/**
 * Roles whose visibility depends on which employee the login belongs to. An
 * HR role sees everyone, so it needs no link to a person; a Manager or Employee
 * login is meaningless without one.
 */
export const SCOPED_ROLES: readonly Role[] = ['MANAGER', 'EMPLOYEE'];

export function isScopedRole(role: Role): boolean {
  return SCOPED_ROLES.includes(role);
}
