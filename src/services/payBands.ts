import type { Database } from '../db/database';
import { accessScopeFor, canSeeAggregates, type ScopeSubject } from '../domain/accessScope';
import { toIsoDate } from '../domain/dates';
import { parseAmountToMinor, type Currency } from '../domain/money';
import { AppError, HTTP_STATUS, forbidden, notFound } from '../shared/errors';
import { logger } from '../shared/logger';
import { listNeedsAttention, type AttentionRow } from '../repositories/attention';
import {
  deleteBand,
  jobLevelExists,
  listBandCoverage,
  upsertBand,
  type BandCoverageRow,
} from '../repositories/bands';
import type { LookupService } from './lookups';

/**
 * Who is paid below what the company says their job is worth.
 *
 * There is no aggregate gate here, unlike the dashboard. This is a list of named
 * individuals rather than a statistic, and the access scope already answers who
 * may see it: a Manager gets their own team's, which is a list of people whose
 * salaries they can already read, and an Employee gets themselves. The one figure
 * that *is* aggregate — the total cost to fix — is computed inside the same scoped
 * query, so it can never total people the caller cannot see.
 */

export interface NeedsAttentionRequest {
  page: number;
  pageSize: number;
  country?: string;
  departmentId?: number;
  jobLevelId?: number;
  /** Defaults to today. Pay is compared to bands as it stood on this date. */
  asOf?: string;
}

export interface NeedsAttentionPage {
  rows: AttentionRow[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  /**
   * What it would cost to bring everybody in the filtered set to the bottom of
   * their band, in USD cents.
   *
   * Converted, and the only converted figure here. Comparing a salary to a band
   * is always done in one currency; adding up what those gaps cost the company is
   * a different question, and it needs a common unit to have an answer at all.
   */
  totalShortfallUsdMinor: number;
  asOf: string;
}

/**
 * The bands, with the coverage they have.
 *
 * Includes level-and-country pairs with **no band set**, which is the point: a
 * missing band is invisible everywhere else, showing up one person at a time as "no
 * band set" with nobody adding up how many.
 */
export interface BandCoverage {
  rows: BandCoverageRow[];
  /** Pairs with people in them and no band. The work this screen exists to surface. */
  pairsWithoutBand: number;
  /** People at a level and country with no band, so not comparable to anything. */
  peopleWithoutBand: number;
  asOf: string;
}

/** A band as somebody types it: amounts are decimal strings, never JSON numbers. */
export interface SaveBandRequest {
  jobLevelId: number;
  country: string;
  currency: Currency;
  min: string;
  mid: string;
  max: string;
  /** The account setting it, from the verified token rather than the body. */
  changedByUserId: number;
}

export interface PayBandService {
  needsAttention: (
    subject: ScopeSubject,
    request: NeedsAttentionRequest,
  ) => Promise<NeedsAttentionPage>;
  /** Every band and every gap, for the screen that manages them. */
  coverage: (subject: ScopeSubject, request: { asOf?: string }) => Promise<BandCoverage>;
  /** Sets the band for a level in a country, replacing whatever was there. */
  save: (subject: ScopeSubject, request: SaveBandRequest) => Promise<BandCoverage>;
  /** Removes a band, leaving those people with nothing to be compared against. */
  remove: (
    subject: ScopeSubject,
    request: { jobLevelId: number; country: string; changedByUserId: number },
  ) => Promise<BandCoverage>;
}

export interface PayBandServiceDeps {
  db: Database;
  now: () => Date;
  /** Invalidated after a write: the bands are part of the cached lookup data. */
  lookups: LookupService;
}

export function createPayBandService(deps: PayBandServiceDeps): PayBandService {
  /**
   * The whole picture, which every write answers with.
   *
   * Returning the list rather than the row that changed means the screen redraws
   * from what the database says — including the recomputed below/within/above counts,
   * which are the reason somebody was editing a band in the first place.
   */
  async function coverageFor(asOf: string): Promise<BandCoverage> {
    const rows = await listBandCoverage(deps.db, asOf);
    const missing = rows.filter((row) => row.band === null && row.headcount > 0);

    return {
      rows,
      pairsWithoutBand: missing.length,
      peopleWithoutBand: missing.reduce((total, row) => total + row.headcount, 0),
      asOf,
    };
  }

  /**
   * Reading and writing bands are both HR-only, and for a different reason from the
   * needs-attention list above.
   *
   * That list is individual salaries the caller can already see. This is the
   * company's pay policy for every level in every country — a Manager reading it
   * learns what the company pays two levels above them, which is not theirs, and
   * writing it is setting policy.
   */
  function requireHr(subject: ScopeSubject): void {
    if (!canSeeAggregates(accessScopeFor(subject))) {
      throw forbidden('Pay bands are available to HR roles only.');
    }
  }

  return {
    async needsAttention(
      subject: ScopeSubject,
      request: NeedsAttentionRequest,
    ): Promise<NeedsAttentionPage> {
      const asOf = request.asOf ?? toIsoDate(deps.now());

      const result = await listNeedsAttention(deps.db, {
        scope: accessScopeFor(subject),
        asOf,
        page: request.page,
        pageSize: request.pageSize,
        ...(request.country === undefined ? {} : { country: request.country }),
        ...(request.departmentId === undefined ? {} : { departmentId: request.departmentId }),
        ...(request.jobLevelId === undefined ? {} : { jobLevelId: request.jobLevelId }),
      });

      return {
        rows: result.rows,
        page: request.page,
        pageSize: request.pageSize,
        total: result.total,
        // Zero results is zero pages, not one empty one.
        totalPages: Math.ceil(result.total / request.pageSize),
        totalShortfallUsdMinor: result.totalShortfallUsdMinor,
        asOf,
      };
    },

    async coverage(subject: ScopeSubject, request: { asOf?: string }): Promise<BandCoverage> {
      requireHr(subject);
      return coverageFor(request.asOf ?? toIsoDate(deps.now()));
    },

    async save(subject: ScopeSubject, request: SaveBandRequest): Promise<BandCoverage> {
      requireHr(subject);

      const minMinor = parseAmount(request.min, 'minimum');
      const midMinor = parseAmount(request.mid, 'midpoint');
      const maxMinor = parseAmount(request.max, 'maximum');

      /* Checked here as well as by the database, because the constraint's message
         names a constraint and this one names the field somebody has to fix. The
         ordering is the whole meaning of a band: a midpoint outside its own range is
         not a band with an odd midpoint, it is three numbers that do not describe
         one. */
      if (minMinor > midMinor || midMinor > maxMinor) {
        throw new AppError(
          HTTP_STATUS.BAD_REQUEST,
          'INVALID_REQUEST',
          'A band has to read minimum, midpoint, maximum in order.',
        );
      }

      if (!(await jobLevelExists(deps.db, request.jobLevelId))) {
        throw new AppError(
          HTTP_STATUS.BAD_REQUEST,
          'INVALID_REQUEST',
          'That job level does not exist. It may have been removed since this page loaded.',
        );
      }

      await upsertBand(deps.db, {
        jobLevelId: request.jobLevelId,
        country: request.country,
        currency: request.currency,
        minMinor,
        midMinor,
        maxMinor,
      });

      /* The bands ride along in the cached lookup data, so a write that did not
         invalidate would leave the dropdowns and the detail pages showing the old
         range for up to an hour. */
      deps.lookups.invalidate();

      logger.info('band.saved', {
        jobLevelId: request.jobLevelId,
        country: request.country,
        currency: request.currency,
        changedByUserId: request.changedByUserId,
        /* The figures are deliberately absent, as everywhere else. A band is not one
           person's pay, but it is what the company pays for a job, and a log is the
           easiest place in a system to read without being noticed. */
      });

      return coverageFor(toIsoDate(deps.now()));
    },

    async remove(
      subject: ScopeSubject,
      request: { jobLevelId: number; country: string; changedByUserId: number },
    ): Promise<BandCoverage> {
      requireHr(subject);

      const removed = await deleteBand(deps.db, {
        jobLevelId: request.jobLevelId,
        country: request.country,
      });

      if (!removed) {
        throw notFound('There is no band for that level and country.');
      }

      deps.lookups.invalidate();

      logger.info('band.removed', {
        jobLevelId: request.jobLevelId,
        country: request.country,
        changedByUserId: request.changedByUserId,
      });

      return coverageFor(toIsoDate(deps.now()));
    },
  };
}

/**
 * One band edge, or a 400 naming which of the three was wrong.
 *
 * `parseAmountToMinor` throws TypeError and RangeError, which the error handler
 * correctly treats as bugs. They are not bugs here — they are somebody typing
 * "120,000" — and naming the edge matters because the form has three of them and a
 * message about "the amount" does not say which.
 */
function parseAmount(amount: string, edge: string): number {
  try {
    return parseAmountToMinor(amount);
  } catch (error) {
    if (error instanceof RangeError || error instanceof TypeError) {
      throw new AppError(
        HTTP_STATUS.BAD_REQUEST,
        'INVALID_REQUEST',
        `The ${edge} is not a valid amount: ${error.message}`,
      );
    }
    throw error;
  }
}
