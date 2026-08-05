import { sql } from 'drizzle-orm';
import { rawRows, type Database } from '../db/database';
import { compensationRecords, employees } from '../db/schema';
import type { Currency } from '../domain/money';
import type { NewEmployee } from './employees';

/**
 * Writing a whole spreadsheet of people, or none of them.
 *
 * One transaction around everything. A half-applied import is the worst possible
 * outcome: nobody knows which half, the file cannot simply be uploaded again
 * because the first half would collide on email, and the only way back is to work
 * out by hand which rows landed. So the transaction is not a nicety here, it is
 * the feature.
 *
 * Inserted in layers, managers first — see src/domain/importOrder.ts for why the
 * order is worked out rather than patched up afterwards.
 */

/**
 * How many rows go into one INSERT.
 *
 * Postgres allows 65,535 bound parameters per statement and a row here carries ten
 * columns, so the hard ceiling is about 6,500. Five hundred is well inside it and
 * keeps any single statement's memory small; the round trips saved by going higher
 * are not the cost that matters in a transaction this size.
 */
const INSERT_CHUNK = 500;

/** How many addresses to look up at once, for the same parameter-limit reason. */
const LOOKUP_CHUNK = 2_000;

export interface ImportEmployee {
  /** Everything but the manager, which is resolved from the email as layers land. */
  employee: Omit<NewEmployee, 'managerId'>;
  /** Lower-cased. Null for somebody who reports to nobody. */
  managerEmail: string | null;
  pay: { amountMinor: number; currency: Currency; effectiveFrom: string } | null;
}

/**
 * Which of these addresses already belong to somebody, and to whom.
 *
 * Answers two questions with one query: whether an imported row would collide with
 * an existing person, and which id a `managerEmail` pointing at somebody already in
 * the database resolves to. Keyed by the lower-cased address, matching the unique
 * index.
 */
export async function findEmployeeIdsByEmail(
  db: Database,
  addresses: readonly string[],
): Promise<Map<string, number>> {
  const found = new Map<string, number>();

  for (let start = 0; start < addresses.length; start += LOOKUP_CHUNK) {
    const chunk = addresses.slice(start, start + LOOKUP_CHUNK);
    if (chunk.length === 0) {
      continue;
    }

    const rows = await rawRows<{ id: number; email: string }>(
      db,
      sql`
        SELECT id, lower(email) AS email
        FROM employees
        WHERE lower(email) IN (${sql.join(
          chunk.map((address) => sql`${address.toLowerCase()}`),
          sql`, `,
        )})
      `,
    );

    for (const row of rows) {
      found.set(row.email, row.id);
    }
  }

  return found;
}

/**
 * Inserts everybody, layer by layer, and their starting salaries.
 *
 * `existingIdByEmail` is seeded with the people already in the database, so a row
 * whose manager is an existing employee resolves on the first layer. Each layer's
 * returned ids are added to it, which is how a manager listed further down the file
 * than their report still ends up on the right row.
 *
 * Returns how many people were created.
 */
export async function insertImportedEmployees(
  db: Database,
  layers: readonly (readonly ImportEmployee[])[],
  existingIdByEmail: ReadonlyMap<string, number>,
  createdBy: number,
): Promise<number> {
  return db.transaction(async (tx) => {
    const idByEmail = new Map(existingIdByEmail);
    let created = 0;

    for (const layer of layers) {
      for (let start = 0; start < layer.length; start += INSERT_CHUNK) {
        const chunk = layer.slice(start, start + INSERT_CHUNK);

        const inserted = await tx
          .insert(employees)
          .values(
            chunk.map((row) => ({
              ...row.employee,
              /* Null only for somebody who reports to nobody. A manager named in
                 the file is guaranteed to be in the map by now, because the layer
                 ordering put them in an earlier one. */
              managerId:
                row.managerEmail === null ? null : (idByEmail.get(row.managerEmail) ?? null),
            })),
          )
          .returning({ id: employees.id, email: employees.email });

        for (const row of inserted) {
          idByEmail.set(row.email.toLowerCase(), row.id);
        }
        created += inserted.length;

        /* Salaries for this chunk, straight away rather than in a pass at the end:
           the ids are in hand here, and holding ten thousand of them to write later
           is a list that only exists to be walked once. */
        const pay = chunk.flatMap((row, index) => {
          const id = inserted[index]?.id;

          if (row.pay === null || id === undefined) {
            return [];
          }
          return [
            {
              employeeId: id,
              amountMinor: row.pay.amountMinor,
              currency: row.pay.currency,
              effectiveFrom: row.pay.effectiveFrom,
              // Named, so an imported figure is distinguishable from one typed in.
              reason: 'Imported',
              createdBy,
            },
          ];
        });

        if (pay.length > 0) {
          await tx.insert(compensationRecords).values(pay);
        }
      }
    }

    return created;
  });
}
