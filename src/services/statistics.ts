import type { Database } from '../db/database';
import { accessScopeFor, canSeeAggregates, type ScopeSubject } from '../domain/accessScope';
import { toIsoDate } from '../domain/dates';
import { MIN_GROUP_FOR_MEDIAN } from '../domain/disclosure';
import { forbidden } from '../shared/errors';
import {
  computePayrollTrend,
  DEFAULT_HISTORY_MONTHS,
  DEFAULT_HORIZON_MONTHS,
  MAX_HISTORY_MONTHS,
  MAX_HORIZON_MONTHS,
  type PayrollTrendPoint,
} from '../repositories/payrollTrend';
import { computePayGap, type PayGapResult } from '../repositories/payGap';
import { computeStatistics, type StatisticsResult } from '../repositories/statistics';

/**
 * The figures behind the dashboard.
 *
 * Two decisions live here rather than in the query, because both are about what
 * it is reasonable to publish rather than about how to compute it.
 */

export interface StatisticsRequest {
  asOf?: string;
  /** Defaults to the people currently employed — see below. */
  status?: 'ACTIVE' | 'LEFT' | 'ALL';
  country?: string;
  departmentId?: number;
  jobLevelId?: number;
}

export interface StatisticsOverview extends StatisticsResult {
  asOf: string;
  /** Published so the UI can explain a missing median rather than show a gap. */
  minimumGroupForMedian: number;
}

export interface StatisticsServiceDeps {
  db: Database;
  now: () => Date;
  /** Passed in from config, so the caveat on the pay-gap screen has one source. */
  syntheticData: boolean;
}

export interface PayrollTrendRequest {
  asOf?: string;
  historyMonths?: number;
  horizonMonths?: number;
}

export interface PayrollTrendResult {
  asOf: string;
  months: PayrollTrendPoint[];
  /**
   * What the pay changes already signed off will add to the monthly bill by the
   * end of the horizon, against this month. Zero when nothing is scheduled.
   */
  committedChangeUsdMinor: number;
}

export interface PayGapRequest {
  asOf?: string;
  country?: string;
  departmentId?: number;
  jobLevelId?: number;
}

export interface PayGapOverview extends PayGapResult {
  asOf: string;
  /**
   * That the gap in this data was put there deliberately.
   *
   * Sent by the API rather than written into the UI, because a screen that says
   * "synthetic data" in hard-coded text keeps saying it after the data becomes
   * real. This flag is the one thing that would have to change.
   */
  syntheticData: boolean;
}

export interface StatisticsService {
  overview: (subject: ScopeSubject, request: StatisticsRequest) => Promise<StatisticsOverview>;
  /** Payroll month by month, and what is already committed beyond today. */
  payrollTrend: (
    subject: ScopeSubject,
    request: PayrollTrendRequest,
  ) => Promise<PayrollTrendResult>;
  /** Median pay by gender, within one country and one level at a time. */
  payGap: (subject: ScopeSubject, request: PayGapRequest) => Promise<PayGapOverview>;
}

export function createStatisticsService(deps: StatisticsServiceDeps): StatisticsService {
  return {
    async overview(subject: ScopeSubject, request: StatisticsRequest): Promise<StatisticsOverview> {
      /**
       * Refused rather than narrowed.
       *
       * The tempting alternative is to apply the Manager's scope and show them
       * their team's averages. That is worse: a median over three people is
       * those three salaries with one step of arithmetic in front, and a figure
       * that looks company-wide but covers four people is a number somebody
       * will quote in a meeting. A clear "not for your role" is the honest
       * answer, and the UI hides the menu item so nobody has to receive it.
       */
      if (!canSeeAggregates(accessScopeFor(subject))) {
        throw forbidden('Company-wide figures are available to HR roles only.');
      }

      const asOf = request.asOf ?? toIsoDate(deps.now());

      /**
       * Active by default.
       *
       * "What does payroll cost" is a question about the people currently
       * employed. Counting leavers would inflate every total with salaries
       * nobody is paying, and the median would drift towards whoever happened
       * to leave. It stays overridable, because "what did last year cost" is a
       * real question and needs the people who were there.
       */
      const statistics = await computeStatistics(deps.db, {
        asOf,
        status: request.status ?? 'ACTIVE',
        ...(request.country === undefined ? {} : { country: request.country }),
        ...(request.departmentId === undefined ? {} : { departmentId: request.departmentId }),
        ...(request.jobLevelId === undefined ? {} : { jobLevelId: request.jobLevelId }),
      });

      if (statistics.overall.unconvertible > 0) {
        /* Refusing is the point. Every cost figure on the dashboard is produced
           by converting, and quietly leaving these people out would make the
           payroll total too small in a way nobody would notice. */
        throw new Error(
          `${String(statistics.overall.unconvertible)} salaries are in a currency with no exchange rate.`,
        );
      }

      return { ...statistics, asOf, minimumGroupForMedian: MIN_GROUP_FOR_MEDIAN };
    },

    async payrollTrend(
      subject: ScopeSubject,
      request: PayrollTrendRequest,
    ): Promise<PayrollTrendResult> {
      // The same gate as the overview: a payroll total is a company-wide figure.
      if (!canSeeAggregates(accessScopeFor(subject))) {
        throw forbidden('Company-wide figures are available to HR roles only.');
      }

      const asOf = request.asOf ?? toIsoDate(deps.now());
      const historyMonths = bounded(
        request.historyMonths ?? DEFAULT_HISTORY_MONTHS,
        MAX_HISTORY_MONTHS,
      );
      /* A horizon of zero is history on its own, which is a fair thing to ask
         for — so unlike the history window it is allowed to be empty. */
      const horizonMonths = bounded(
        request.horizonMonths ?? DEFAULT_HORIZON_MONTHS,
        MAX_HORIZON_MONTHS,
        0,
      );

      const months = await computePayrollTrend(deps.db, { asOf, historyMonths, horizonMonths });

      return { asOf, months, committedChangeUsdMinor: committedChange(months) };
    },

    async payGap(subject: ScopeSubject, request: PayGapRequest): Promise<PayGapOverview> {
      /**
       * The strictest of the three gates, and for the clearest reason.
       *
       * Narrowing this to a Manager's team would not produce a smaller analysis;
       * it would produce cells of two and three people, every one of them under
       * the disclosure threshold, and the handful that survived would be a
       * comparison between two named colleagues. HR-only is the only version of
       * this feature that is not a way to read individual salaries.
       */
      if (!canSeeAggregates(accessScopeFor(subject))) {
        throw forbidden('Pay-gap analysis is available to HR roles only.');
      }

      const asOf = request.asOf ?? toIsoDate(deps.now());

      const gap = await computePayGap(deps.db, {
        asOf,
        ...(request.country === undefined ? {} : { country: request.country }),
        ...(request.departmentId === undefined ? {} : { departmentId: request.departmentId }),
        ...(request.jobLevelId === undefined ? {} : { jobLevelId: request.jobLevelId }),
      });

      return { ...gap, asOf, syntheticData: deps.syntheticData };
    },
  };
}

/** A window somebody asked for, kept inside what the chart can draw and the database should scan. */
function bounded(value: number, maximum: number, minimum = 1): number {
  return Math.min(Math.max(Math.trunc(value), minimum), maximum);
}

/**
 * The difference between this month and the last committed one.
 *
 * Reported separately because it is the number worth acting on: it is money
 * already promised, and it is the one figure on the dashboard that is not
 * visible anywhere else in the product.
 */
function committedChange(months: readonly PayrollTrendPoint[]): number {
  const actual = months.filter((point) => point.kind === 'ACTUAL');
  const current = actual.at(-1);
  const last = months.at(-1);

  if (current === undefined || last === undefined || last.kind !== 'COMMITTED') {
    return 0;
  }
  return last.payrollUsdMinor - current.payrollUsdMinor;
}
