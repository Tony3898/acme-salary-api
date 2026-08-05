import type { Database } from '../db/database';
import { accessScopeFor, canSeeAggregates, type ScopeSubject } from '../domain/accessScope';
import { toIsoDate } from '../domain/dates';
import { forbidden } from '../errors';
import {
  computeStatistics,
  MIN_GROUP_FOR_MEDIAN,
  type StatisticsResult,
} from '../repositories/statistics';

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
}

export interface StatisticsService {
  overview: (subject: ScopeSubject, request: StatisticsRequest) => Promise<StatisticsOverview>;
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
  };
}
