import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { isValidIsoDate } from '../domain/dates';
import { HTTP_STATUS } from '../errors';
import { authContext } from '../middleware/requireAuth';
import type { StatisticsService } from '../services/statistics';

/**
 * The dashboard's figures.
 *
 * The role check is in the service, not here. A route guard would stop the
 * request, but the reason these are HR-only is about the data rather than about
 * the URL — so the rule lives with the access scope, where every future endpoint
 * that summarises pay will find it.
 */

const COUNTRY_PATTERN = /^[A-Za-z]{2}$/;

const overviewQuerySchema = z.object({
  asOf: z.string().refine(isValidIsoDate, 'asOf must be a date as YYYY-MM-DD.').optional(),
  status: z.enum(['ACTIVE', 'LEFT', 'ALL']).optional(),
  country: z
    .string()
    .regex(COUNTRY_PATTERN, 'country must be a two-letter code.')
    .transform((value) => value.toUpperCase())
    .optional(),
  departmentId: z.coerce.number().int().positive().optional(),
  jobLevelId: z.coerce.number().int().positive().optional(),
});

/**
 * The window the chart asks for. Both are clamped in the service rather than
 * refused here: a request for two centuries of history is somebody exploring
 * the API, and the sensible answer is as much as we will draw.
 */
const trendQuerySchema = z.object({
  asOf: z.string().refine(isValidIsoDate, 'asOf must be a date as YYYY-MM-DD.').optional(),
  historyMonths: z.coerce.number().int().positive().optional(),
  /* Zero is allowed and means "no forecast": a legitimate thing to ask for when
     somebody wants the history on its own. */
  horizonMonths: z.coerce.number().int().nonnegative().optional(),
});

export interface StatisticsRouterDeps {
  statistics: StatisticsService;
  requireAuth: RequestHandler;
}

export function createStatisticsRouter(deps: StatisticsRouterDeps): Router {
  const router = Router();

  router.get('/overview', deps.requireAuth, async (req, res) => {
    const query = overviewQuerySchema.parse(req.query);
    const { role, employeeId } = authContext(req);

    const overview = await deps.statistics.overview({ role, employeeId }, query);

    /* Not cacheable by anything in between. These are salary figures, and the
       same URL answers differently per role — a shared cache would be one
       misconfiguration away from serving them to the wrong person. */
    res.setHeader('Cache-Control', 'no-store');
    res.status(HTTP_STATUS.OK).json(overview);
  });

  router.get('/payroll-trend', deps.requireAuth, async (req, res) => {
    const query = trendQuerySchema.parse(req.query);
    const { role, employeeId } = authContext(req);

    const trend = await deps.statistics.payrollTrend({ role, employeeId }, query);

    res.setHeader('Cache-Control', 'no-store');
    res.status(HTTP_STATUS.OK).json(trend);
  });

  return router;
}
