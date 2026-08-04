import { hash } from '@node-rs/argon2';
import type { users } from '../schema';
import type { EmployeeRow } from './people';

export type UserRow = typeof users.$inferInsert;

/** argon2id. The default cost is chosen by the library and applies to real logins too. */
const ARGON2ID = 2;

/**
 * One login per role.
 *
 * The Manager and Employee accounts are attached to real people, and to *related*
 * people: the employee reports to the manager, so the difference between the two
 * access scopes is visible by logging in as each.
 */
export async function buildDemoAccounts(
  people: readonly EmployeeRow[],
  password: string,
): Promise<UserRow[]> {
  const reportCounts = new Map<number, number>();
  for (const person of people) {
    if (person.managerId != null) {
      reportCounts.set(person.managerId, (reportCounts.get(person.managerId) ?? 0) + 1);
    }
  }

  /* The busiest manager who is not the person at the top: a mid-level manager
     demonstrates a limited scope, where the root would see almost everybody. */
  const managerId =
    [...reportCounts.entries()]
      .filter(([id]) => id !== 1)
      .sort(([, left], [, right]) => right - left)[0]?.[0] ?? 1;
  /* An active report: an employee login belonging to somebody who has left would
     demonstrate the wrong thing. */
  const employeeId =
    people.find((person) => person.managerId === managerId && person.status !== 'LEFT')?.id ?? 1;

  const passwordHash = await hash(password, { algorithm: ARGON2ID });

  return [
    { id: 1, email: 'hr.admin@acme.test', passwordHash, role: 'HR_ADMIN' },
    { id: 2, email: 'hr.viewer@acme.test', passwordHash, role: 'HR_VIEWER' },
    { id: 3, email: 'manager@acme.test', passwordHash, role: 'MANAGER', employeeId: managerId },
    { id: 4, email: 'employee@acme.test', passwordHash, role: 'EMPLOYEE', employeeId },
  ];
}
