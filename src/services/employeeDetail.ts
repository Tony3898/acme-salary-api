import type { Database } from '../db/database';
import { accessScopeFor, type ScopeSubject } from '../domain/accessScope';
import { currentRecordIndex, withChanges, type PayChange } from '../domain/compensation';
import {
  countDirectReports,
  findEmployeeById,
  listCompensationHistory,
  type CompensationHistoryEntry,
  type EmployeeListRow,
} from '../repositories/employees';

/**
 * One person's whole record, assembled once.
 *
 * Every write on an employee — a pay change, a status change, creating them —
 * answers with the record as it now stands rather than with the row it wrote, so
 * the screen that asked redraws from one response and shows what the database
 * says instead of what the client assumed the change would do. That makes this
 * the shared tail of five operations, which is why it is its own module rather
 * than a closure inside one of them.
 */

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

/**
 * One person, or null when the caller may not see them — which is also what a
 * caller gets for somebody who does not exist. The two are deliberately
 * indistinguishable: a different answer for "not yours" confirms the record is
 * there, which is enough to walk the ids and learn the shape of the company.
 */
export async function findEmployeeDetail(
  db: Database,
  subject: ScopeSubject,
  id: number,
  asOf: string,
): Promise<EmployeeDetail | null> {
  const scope = accessScopeFor(subject);

  const employee = await findEmployeeById(db, { id, scope, asOf });
  if (employee === null) {
    return null;
  }

  /* Only after the scope has allowed the record — fetching the history first and
     filtering afterwards would read one person's pay to decide whether to show
     it to somebody else. The two reads *after* that gate are independent of each
     other, so they go together: three round trips became two, and neither tells
     the other anything. */
  const [records, directReports] = await Promise.all([
    listCompensationHistory(db, id),
    countDirectReports(db, id),
  ]);
  const currentIndex = currentRecordIndex(records, asOf);

  const history = withChanges(records).map((entry, index) => ({
    ...entry,
    isCurrent: index === currentIndex,
    isScheduled: entry.effectiveFrom > asOf,
  }));

  return { employee, directReports, history, asOf };
}
