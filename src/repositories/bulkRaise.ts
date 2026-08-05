import { sql, type SQL } from 'drizzle-orm';
import { rawRows, type Database } from '../db/database';
import { compensationRecords } from '../db/schema';
import type { AccessScope } from '../domain/accessScope';
import type { Currency } from '../domain/money';
import {
  employeeFilterConditions,
  scopeCondition,
  statusCondition,
  teamCte,
  whereFrom,
  type EmployeeFilters,
} from './employeeFilters';
import {
  EMPLOYEE_COLUMNS,
  employeeFrom,
  toEmployeeListRow,
  type EmployeeListRow,
  type RawEmployeeColumns,
} from './employeeRow';
import type { NewCompensationRecord } from './employees';

/**
 * Everybody a bulk raise would touch, and what they are on now.
 *
 * The rows come back whole rather than pre-filtered, because deciding who a raise
 * actually applies to is a judgement — somebody hired after the effective date,
 * somebody with no salary recorded, somebody who already has this exact record —
 * and every one of those has to be *reported* rather than silently dropped. A
 * preview that says "412 affected" out of 430 matched, and says what happened to
 * the other 18, is the difference between a tool somebody trusts and one they
 * check by hand afterwards.
 */

/** As many rows as go into one INSERT; see the note in employeeImport.ts. */
const INSERT_CHUNK = 500;

export interface RaiseCandidateQuery extends EmployeeFilters {
  scope: AccessScope;
  /** Pay as it stands on the day the raise starts, which is what a raise is applied to. */
  asOf: string;
  /** Used to spot a record already dated the same day, which makes applying idempotent. */
  effectiveFrom: string;
}

export interface RaiseCandidate {
  employee: EmployeeListRow;
  /**
   * A record this person already has dated exactly the day the raise starts.
   *
   * What makes applying the same raise twice a no-op. Without it a double-clicked
   * button writes every salary again, and the table is append-only.
   */
  existingOnDate: { amountMinor: number; currency: Currency } | null;
}

interface RawCandidate extends RawEmployeeColumns {
  existing_amount_minor: number | null;
  existing_currency: Currency | null;
}

/**
 * The statement, built but not run — so scripts/verify-injection.ts can hold the
 * SQL text and the bound parameters apart.
 */
export function buildRaiseCandidatesQuery(query: RaiseCandidateQuery): SQL {
  const where = whereFrom([
    scopeCondition(query.scope),
    /* Currently employed only, and not a parameter. A raise for somebody who has
       left is not a decision anybody makes; it is a filter left on by accident. */
    ...statusCondition('ACTIVE'),
    ...employeeFilterConditions(query),
  ]);

  return sql`
    ${teamCte(query.scope)}
    SELECT
      ${EMPLOYEE_COLUMNS},
      same_day.amount_minor AS existing_amount_minor,
      same_day.currency AS existing_currency
    ${employeeFrom(query.asOf)}
    /* Whatever this person already has on the raise's own date. LEFT, because
       almost nobody will — and the ones who do are the ones a retried request
       must not pay twice. */
    LEFT JOIN LATERAL (
      SELECT c.amount_minor, c.currency
      FROM compensation_records c
      WHERE c.employee_id = e.id AND c.effective_from = ${query.effectiveFrom}
      ORDER BY c.id DESC
      LIMIT 1
    ) same_day ON true
    WHERE ${where}
    ORDER BY e.id ASC
  `;
}

export async function listRaiseCandidates(
  db: Database,
  query: RaiseCandidateQuery,
): Promise<RaiseCandidate[]> {
  const rows = await rawRows<RawCandidate>(db, buildRaiseCandidatesQuery(query));

  return rows.map((row) => ({
    employee: toEmployeeListRow(row),
    existingOnDate:
      row.existing_amount_minor === null || row.existing_currency === null
        ? null
        : { amountMinor: row.existing_amount_minor, currency: row.existing_currency },
  }));
}

/**
 * Writes every raise, or none of them, and never the same one twice.
 *
 * One transaction for the same reason the import has one: a bulk raise that half
 * applied leaves nobody able to say which half, and the operation cannot be repeated
 * to finish the job without paying the first half twice.
 *
 * `onConflictDoNothing` is what makes repeating it safe. The preview already skips
 * anybody who has this exact record — that is what produces the `skippedAlreadyRecorded`
 * count — but between reading the candidates and writing them there is a window, and
 * two clicks of Apply arriving together both pass that check. Here the second one
 * writes nothing rather than paying the raise twice.
 *
 * The count returned is rows actually written, not rows attempted, so the report says
 * what happened rather than what was intended.
 */
export async function insertRaiseRecords(
  db: Database,
  records: readonly NewCompensationRecord[],
): Promise<number> {
  if (records.length === 0) {
    return 0;
  }

  return db.transaction(async (tx) => {
    let written = 0;

    for (let start = 0; start < records.length; start += INSERT_CHUNK) {
      const chunk = records.slice(start, start + INSERT_CHUNK);
      const inserted = await tx
        .insert(compensationRecords)
        .values([...chunk])
        /* Silent here, unlike the single-record path, which answers a 400. One
           person recording one raise twice has made a mistake worth telling them
           about; a bulk apply of 400 people where 3 were already written is the
           constraint doing its job, and the report's counts carry it. */
        .onConflictDoNothing({
          target: [
            compensationRecords.employeeId,
            compensationRecords.effectiveFrom,
            compensationRecords.amountMinor,
            compensationRecords.currency,
          ],
        })
        .returning({ id: compensationRecords.id });

      written += inserted.length;
    }

    return written;
  });
}
