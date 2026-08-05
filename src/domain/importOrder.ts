/**
 * The order to insert imported people in, so that every manager exists before
 * anybody who reports to them.
 *
 * A CSV names managers by email, and a file may list somebody above their own
 * manager — there is no reason a spreadsheet would be sorted by seniority. The
 * obvious fix is to insert everybody with no manager and then run an UPDATE pass
 * to fill the column in. This does it in one pass instead, and the reason is not
 * speed: an insert that already knows the manager's id can never leave a
 * half-linked hierarchy behind if the second statement fails, and working out the
 * order means the cycles have to be found, which the UPDATE version would happily
 * create.
 *
 * The result is layers rather than a flat order, because ids are assigned by the
 * database: a whole layer can be inserted in one statement, and its returned ids
 * are what the next layer's managers resolve to. Depth is the depth of the
 * reporting chain — around seven for a real company, not ten thousand.
 */

export interface ManagerLink {
  /** Lower-cased, as the email column is compared. */
  email: string;
  managerEmail: string | null;
}

export interface ImportOrder<T extends ManagerLink> {
  /** Insert in this order. Everything in a layer can go in one statement. */
  layers: T[][];
  /** Rows whose manager is nowhere to be found: not in the file, not in the database. */
  missingManager: T[];
  /**
   * Rows that manage each other, directly or through a chain.
   *
   * Reported rather than broken arbitrarily. A cycle means the file says A reports
   * to B and B reports to A, and there is no version of that anybody meant —
   * picking one to sever would import a hierarchy nobody described.
   */
  cyclic: T[];
}

export function orderByManager<T extends ManagerLink>(
  rows: readonly T[],
  existingEmails: ReadonlySet<string>,
): ImportOrder<T> {
  const inFile = new Set(rows.map((row) => row.email));
  const layers: T[][] = [];
  const placed = new Set<string>();

  /* Anybody whose manager is not in this file and not already in the database
     cannot be placed at all, and is not a cycle — separating them first means the
     remaining unplaceable rows are cycles by elimination. */
  const missingManager: T[] = [];
  let pending: T[] = [];

  for (const row of rows) {
    const manager = row.managerEmail;
    if (manager === null || existingEmails.has(manager) || inFile.has(manager)) {
      pending.push(row);
    } else {
      missingManager.push(row);
    }
  }

  while (pending.length > 0) {
    /* Ready now: no manager, a manager who is already in the database, or a
       manager placed in an earlier layer. */
    const ready = pending.filter(
      (row) =>
        row.managerEmail === null ||
        existingEmails.has(row.managerEmail) ||
        placed.has(row.managerEmail),
    );

    if (ready.length === 0) {
      // Nothing can move and nothing is missing, so what is left points at itself.
      return { layers, missingManager, cyclic: pending };
    }

    for (const row of ready) {
      placed.add(row.email);
    }
    layers.push(ready);
    pending = pending.filter((row) => !placed.has(row.email));
  }

  return { layers, missingManager, cyclic: [] };
}
