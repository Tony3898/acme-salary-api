import type { Database } from '../db/database';
import { accessScopeFor, type ScopeSubject } from '../domain/accessScope';
import { previousDay } from '../domain/dates';
import type { Currency } from '../domain/money';
import { parsePercentToBasisPoints, raisedAmountMinor } from '../domain/raise';
import { AppError, HTTP_STATUS } from '../shared/errors';
import { logger } from '../shared/logger';
import {
  insertRaiseRecords,
  listRaiseCandidates,
  type RaiseCandidate,
} from '../repositories/bulkRaise';
import type { EmployeeListRow } from '../repositories/employeeRow';
import type { NewCompensationRecord } from '../repositories/employees';

/**
 * The annual review, as one operation: work out what a percentage would cost,
 * then apply it.
 *
 * **Preview and apply are the same call.** Not two endpoints and not two code
 * paths — one function with a flag, which computes the whole set of changes and
 * then either describes them or writes them. That is the only structure in which
 * "the preview matched what was applied" is guaranteed rather than tested for: the
 * numbers on screen and the rows in the table come from the same arithmetic on the
 * same rows.
 *
 * **Nobody is dropped quietly.** Somebody with no salary recorded, somebody hired
 * after the date, somebody who already has this exact record — each is counted and
 * named in the report. A total that silently covers fewer people than the filter
 * matched is a figure somebody will sign off.
 */

/** Named individuals in the report, capped. Enough to act on, not a way to export the payroll. */
const MAX_LISTED = 50;

/**
 * How many individual changes the report will list, and therefore how many people a
 * caller may name in a selection.
 *
 * The two are the same number on purpose: a selection can only be made from a list
 * somebody has seen. Nobody reviews nine thousand checkboxes, so beyond this the
 * honest answer is "narrow the filters" rather than a list too long to read and a
 * payload the plan exists to avoid.
 */
export const MAX_SELECTABLE = 500;

export interface BulkRaiseRequest {
  /** As written: "3.5". A string, because a percentage as a JSON number is a float. */
  percent: string;
  effectiveFrom: string;
  reason?: string;
  country?: string;
  departmentId?: number;
  jobLevelId?: number;
  /**
   * Apply to only these people, of the ones the filters matched.
   *
   * Absent means everybody, which is what a first preview asks for. Sent on both the
   * preview and the apply, so a narrowed selection is costed by the same arithmetic
   * over the same rows — the whole point of preview and apply being one call.
   */
  employeeIds?: readonly number[];
  /** False produces the identical report and writes nothing. */
  apply: boolean;
  /** The account applying it, from the verified token rather than the body. */
  recordedByUserId: number;
}

/**
 * One person's change, as the report lists it.
 *
 * Sent so somebody can review the individual changes and deselect any of them. Capped
 * at MAX_SELECTABLE — the figures below always cover the whole matched set, whether or
 * not the individual rows fitted.
 */
export interface PlannedChange {
  employeeId: number;
  fullName: string;
  country: string;
  jobLevelName: string;
  currency: string;
  currentMinor: number;
  newMinor: number;
  /** Whether this change takes them past the top of their band. */
  exceedsBand: boolean;
}

/** One person the raise would take past the top of their band. */
export interface BandBreach {
  employeeId: number;
  fullName: string;
  currency: Currency;
  newAmountMinor: number;
  bandMaxMinor: number;
}

/** The exact figures, per currency, never added across them. */
export interface CurrencyTotal {
  currency: Currency;
  affected: number;
  currentTotalMinor: number;
  newTotalMinor: number;
  increaseMinor: number;
}

export interface BulkRaiseReport {
  effectiveFrom: string;
  percent: string;
  /** Everybody the filters matched, before any of the reasons below removed them. */
  matched: number;
  /** Who would actually get a record written. */
  affected: number;
  skippedNoPay: number;
  skippedHiredLater: number;
  /** Already has this exact raise on this date, so applying again would pay it twice. */
  skippedAlreadyRecorded: number;
  /**
   * Already has a *different* pay change dated that day, so this one was not added.
   *
   * Reported separately from the one above because it means something different:
   * not "nothing to do" but "somebody else has already decided something about this
   * person on this date, go and look".
   */
  skippedChangedOnDate: number;
  /**
   * The exact cost, one entry per currency.
   *
   * Never summed across currencies here. Adding rupees to pounds is the mistake
   * this whole system is arranged to prevent, and a per-currency breakdown is the
   * answer that is true.
   */
  byCurrency: CurrencyTotal[];
  /**
   * The same cost converted, as one comparable figure.
   *
   * An estimate, and deliberately labelled as one. It converts each person's
   * current USD figure and applies the percentage to that, rather than converting
   * the raised local amount — a difference of at most a cent per person, against a
   * total that already depends on a single exchange-rate snapshot. The figures that
   * get *written* are the local ones above, and those are exact.
   */
  increaseUsdMinorEstimate: number;
  currentTotalUsdMinor: number;
  /** People the raise would take above their band. Named, capped, and counted. */
  wouldExceedBand: BandBreach[];
  wouldExceedBandCount: number;
  /**
   * The individual changes, for review and deselection. Capped at MAX_SELECTABLE.
   *
   * Every total in this report covers the whole affected set regardless — the rows
   * are what somebody reads, not what the arithmetic is done from.
   */
  changes: PlannedChange[];
  /** True when there were more changes than the cap, so a selection cannot be made. */
  changesTruncated: boolean;
  /** How many the filters matched but the caller's selection left out. */
  skippedNotSelected: number;
  applied: boolean;
  recorded: number;
}

export interface BulkRaiseService {
  run: (subject: ScopeSubject, request: BulkRaiseRequest) => Promise<BulkRaiseReport>;
}

/**
 * No clock. Unlike every other service here, a bulk raise has no sensible default
 * date: "today" for a change that lands in an append-only table is a decision
 * somebody has to make on purpose, so `effectiveFrom` is required.
 */
export interface BulkRaiseServiceDeps {
  db: Database;
}

/** One person's change, worked out once and then either described or written. */
interface PlannedRaise {
  employeeId: number;
  fullName: string;
  country: string;
  jobLevelName: string;
  currency: Currency;
  currentMinor: number;
  newMinor: number;
  currentUsdMinor: number;
  newUsdMinorEstimate: number;
  breach: BandBreach | null;
}

export function createBulkRaiseService(deps: BulkRaiseServiceDeps): BulkRaiseService {
  return {
    async run(subject: ScopeSubject, request: BulkRaiseRequest): Promise<BulkRaiseReport> {
      const scope = accessScopeFor(subject);

      /* Only HR Admin reaches this route. The scope is checked anyway, so a role
         added later cannot give raises outside what it can see. */
      if (scope.kind !== 'ALL') {
        throw new AppError(
          HTTP_STATUS.FORBIDDEN,
          'FORBIDDEN',
          'Bulk pay changes are available to HR Admin only.',
        );
      }

      const basisPoints = parsePercent(request.percent);

      const candidates = await listRaiseCandidates(deps.db, {
        scope,
        /**
         * The salary in force the day *before* the raise starts.
         *
         * Not on the day itself, and this is the difference between an operation
         * that can be run twice and one that compounds. Reading the salary on the
         * effective date means a record this very operation wrote becomes its own
         * starting point: apply 4% from 1 December, run it again, and the second
         * pass takes 4% of the already-raised figure.
         *
         * It is also the more defensible reading. "4% from 1 December" is a
         * statement about what people were on in November, and it means the same
         * thing however many times somebody presses the button.
         */
        asOf: previousDay(request.effectiveFrom),
        effectiveFrom: request.effectiveFrom,
        ...(request.country === undefined ? {} : { country: request.country }),
        ...(request.departmentId === undefined ? {} : { departmentId: request.departmentId }),
        ...(request.jobLevelId === undefined ? {} : { jobLevelId: request.jobLevelId }),
      });

      /* Null means everybody. A Set rather than the array, because this is asked once
         per candidate and the candidate list is the whole company by default. */
      const selected =
        request.employeeIds === undefined ? null : new Set<number>(request.employeeIds);
      let skippedNotSelected = 0;

      const planned: PlannedRaise[] = [];
      const skipped: Record<SkipReason, number> = {
        skippedNoPay: 0,
        skippedHiredLater: 0,
        skippedAlreadyRecorded: 0,
        skippedChangedOnDate: 0,
      };

      for (const candidate of candidates) {
        const decision = decide(candidate, request.effectiveFrom, basisPoints);

        if (decision.raise === null) {
          skipped[decision.reason] += 1;
          continue;
        }

        /* Deselection is applied after the change is worked out, not before. A person
           left out is still counted and reported — a total that silently covers fewer
           people than the filter matched is the thing this report exists to prevent,
           and that is as true of a deselection as of a skip. */
        if (selected !== null && !selected.has(decision.raise.employeeId)) {
          skippedNotSelected += 1;
          continue;
        }

        planned.push(decision.raise);
      }

      const report = summarise(request, candidates.length, planned, skipped, skippedNotSelected);

      if (!request.apply) {
        return report;
      }

      const recorded = await insertRaiseRecords(
        deps.db,
        planned.map((entry): NewCompensationRecord => ({
          employeeId: entry.employeeId,
          amountMinor: entry.newMinor,
          currency: entry.currency,
          effectiveFrom: request.effectiveFrom,
          reason: request.reason ?? `Bulk change of ${request.percent}%`,
          createdBy: request.recordedByUserId,
        })),
      );

      logger.info('compensation.bulkApplied', {
        percent: request.percent,
        effectiveFrom: request.effectiveFrom,
        recorded,
        recordedByUserId: request.recordedByUserId,
        /* No names and no amounts. Who got what is exactly the information a log
           should not be the easiest place to read. */
      });

      return { ...report, applied: true, recorded };
    },
  };
}

/** Why somebody the filters matched is not getting a record written. */
type SkipReason =
  'skippedNoPay' | 'skippedHiredLater' | 'skippedAlreadyRecorded' | 'skippedChangedOnDate';

/**
 * What happens to one person: a change, or a named reason for none.
 *
 * One function per candidate, returning either, so the loop above is a tally and
 * every reason for exclusion is decided in one readable place. The four reasons
 * were previously four early exits threaded through the arithmetic, which is the
 * shape where a fifth gets added in the wrong order.
 */
function decide(
  candidate: RaiseCandidate,
  effectiveFrom: string,
  basisPoints: number,
): { raise: PlannedRaise; reason: null } | { raise: null; reason: SkipReason } {
  const { employee } = candidate;

  if (employee.hireDate > effectiveFrom) {
    // Not yet employed on the day it starts. Their first salary is their offer.
    return { raise: null, reason: 'skippedHiredLater' };
  }
  if (employee.salary === null) {
    return { raise: null, reason: 'skippedNoPay' };
  }

  const newMinor = raise(employee.salary.amountMinor, basisPoints, employee.fullName);

  if (candidate.existingOnDate !== null) {
    const identical =
      candidate.existingOnDate.amountMinor === newMinor &&
      candidate.existingOnDate.currency === employee.salary.currency;

    /* Identical means this exact record is already there: a retried request, or
       somebody pressing the button twice.

       Different means somebody else has already dated a change that day — a
       promotion, or a correction. Left alone rather than added to, because the
       salary in force is decided by the latest record on a date and writing another
       would silently override whatever they decided. Counted either way, so the
       person signing this off can see it and go and look. */
    return { raise: null, reason: identical ? 'skippedAlreadyRecorded' : 'skippedChangedOnDate' };
  }

  return {
    reason: null,
    raise: {
      employeeId: employee.id,
      fullName: employee.fullName,
      country: employee.country,
      jobLevelName: employee.jobLevelName,
      currency: employee.salary.currency,
      currentMinor: employee.salary.amountMinor,
      newMinor,
      currentUsdMinor: employee.salary.amountUsdMinor,
      newUsdMinorEstimate: raise(employee.salary.amountUsdMinor, basisPoints, employee.fullName),
      breach: breachOf(employee, newMinor),
    },
  };
}

function summarise(
  request: BulkRaiseRequest,
  matched: number,
  planned: readonly PlannedRaise[],
  skipped: Record<SkipReason, number>,
  skippedNotSelected: number,
): BulkRaiseReport {
  const byCurrency = new Map<Currency, CurrencyTotal>();
  let currentTotalUsdMinor = 0;
  let increaseUsdMinorEstimate = 0;
  const breaches: BandBreach[] = [];

  for (const entry of planned) {
    const total = byCurrency.get(entry.currency) ?? {
      currency: entry.currency,
      affected: 0,
      currentTotalMinor: 0,
      newTotalMinor: 0,
      increaseMinor: 0,
    };

    total.affected += 1;
    total.currentTotalMinor += entry.currentMinor;
    total.newTotalMinor += entry.newMinor;
    total.increaseMinor += entry.newMinor - entry.currentMinor;
    byCurrency.set(entry.currency, total);

    currentTotalUsdMinor += entry.currentUsdMinor;
    increaseUsdMinorEstimate += entry.newUsdMinorEstimate - entry.currentUsdMinor;

    if (entry.breach !== null) {
      breaches.push(entry.breach);
    }
  }

  return {
    effectiveFrom: request.effectiveFrom,
    percent: request.percent,
    matched,
    affected: planned.length,
    ...skipped,
    // Largest cost first, and currency as a tie-break so the order never wobbles.
    byCurrency: [...byCurrency.values()].sort(
      (left, right) =>
        Math.abs(right.increaseMinor) - Math.abs(left.increaseMinor) ||
        left.currency.localeCompare(right.currency),
    ),
    increaseUsdMinorEstimate,
    currentTotalUsdMinor,
    /* Furthest past the band first: the ones somebody will actually want to look
       at before signing off, rather than whoever happens to have the lowest id. */
    wouldExceedBand: breaches
      .toSorted(
        (left, right) =>
          right.newAmountMinor - right.bandMaxMinor - (left.newAmountMinor - left.bandMaxMinor),
      )
      .slice(0, MAX_LISTED),
    wouldExceedBandCount: breaches.length,
    /* Ordered by name, because this list is read rather than acted on in order — and
       a stable order means a checkbox does not move under somebody's cursor when the
       selection changes and the preview comes back. */
    changes: planned
      .toSorted((left, right) => left.fullName.localeCompare(right.fullName))
      .slice(0, MAX_SELECTABLE)
      .map(toPlannedChange),
    changesTruncated: planned.length > MAX_SELECTABLE,
    skippedNotSelected,
    applied: false,
    recorded: 0,
  };
}

function toPlannedChange(entry: PlannedRaise): PlannedChange {
  return {
    employeeId: entry.employeeId,
    fullName: entry.fullName,
    country: entry.country,
    jobLevelName: entry.jobLevelName,
    currency: entry.currency,
    currentMinor: entry.currentMinor,
    newMinor: entry.newMinor,
    exceedsBand: entry.breach !== null,
  };
}

/**
 * Whether the new amount goes past the top of the band.
 *
 * Only when the band is in the same currency as the pay, which is the same rule
 * `bandStanding` applies: a comparison through an exchange rate is a comparison of
 * the exchange rate. Somebody with no band, or one in another currency, simply is
 * not reported as breaching — the band screen already says so about them, and
 * repeating it here would put a warning in front of a decision it cannot inform.
 */
function breachOf(employee: EmployeeListRow, newMinor: number): BandBreach | null {
  const band = employee.band.band;
  const currency = employee.salary?.currency;

  if (band === null || currency === undefined || band.currency !== currency) {
    return null;
  }
  if (newMinor <= band.maxMinor) {
    return null;
  }

  return {
    employeeId: employee.id,
    fullName: employee.fullName,
    currency,
    newAmountMinor: newMinor,
    bandMaxMinor: band.maxMinor,
  };
}

/**
 * The percentage, or a 400 explaining what is wrong with it.
 *
 * `parsePercentToBasisPoints` throws TypeError and RangeError, which the error
 * handler correctly treats as bugs and answers with a 500. They are not bugs here
 * — they are somebody typing "3,5" or "500" — and a 500 tells them nothing.
 */
function parsePercent(percent: string): number {
  try {
    return parsePercentToBasisPoints(percent);
  } catch (error) {
    if (error instanceof RangeError || error instanceof TypeError) {
      throw new AppError(HTTP_STATUS.BAD_REQUEST, 'INVALID_REQUEST', error.message);
    }
    throw error;
  }
}

/**
 * One person's new amount, with an arithmetic refusal turned into a 400 that names
 * them.
 *
 * A cut deep enough to round somebody's salary to nothing is the realistic case:
 * "-100%" passes the percentage check and then fails on the first row. Naming the
 * person is what makes the message actionable, and it fails before anything is
 * written because the whole plan is computed before the transaction opens.
 */
function raise(amountMinor: number, basisPoints: number, fullName: string): number {
  try {
    return raisedAmountMinor(amountMinor, basisPoints);
  } catch (error) {
    if (error instanceof RangeError || error instanceof TypeError) {
      throw new AppError(
        HTTP_STATUS.BAD_REQUEST,
        'INVALID_REQUEST',
        `${error.message} It would apply to ${fullName}.`,
      );
    }
    throw error;
  }
}
