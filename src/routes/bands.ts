import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { SUPPORTED_CURRENCIES } from '../domain/money';
import { HTTP_STATUS } from '../shared/errors';
import { authContext } from '../middleware/requireAuth';
import type { PayBandService } from '../services/payBands';
import { amountSchema, asOfSchema, countrySchema, positiveIdSchema } from './schemas';

/**
 * Setting what the company pays for a job.
 *
 * The only screen in the app that edits reference data rather than employee data,
 * and the reason it exists is plain: without it, "below band" is a judgement made by
 * whoever last ran the seed script, and changing it means database access. An HR team
 * cannot be asked for that.
 */

/**
 * A band, identified by the level and country it belongs to.
 *
 * `PUT` on the natural key rather than `POST` and `PATCH`, because
 * (job level, country) *is* the identity of a band — the table is unique on it. That
 * makes the operation idempotent, and it means the client does not have to know
 * whether a band already exists in order to choose a method. Two people setting the
 * same band land on the same row rather than racing to create it twice.
 */
const bandKeySchema = z.object({
  jobLevelId: positiveIdSchema,
  country: countrySchema,
});

const saveBandSchema = z.object({
  currency: z.enum(SUPPORTED_CURRENCIES),
  /* Strings, like every other amount here. A band's edges are money, and money as a
     JSON number is a double — 192000.1 arrives as 192000.09999999999. The ordering
     rule between the three is checked in the service, where the message can name
     which edge is wrong. */
  min: amountSchema,
  mid: amountSchema,
  max: amountSchema,
});

export interface BandRouterDeps {
  payBands: PayBandService;
  requireAuth: RequestHandler;
  /** Reading is HR; writing is HR Admin. The service checks the first, this the second. */
  requireHrAdmin: RequestHandler;
}

export function createBandRouter(deps: BandRouterDeps): Router {
  const router = Router();

  /**
   * Every band, and every level-and-country pair that has people but no band.
   *
   * The gaps are the point. A missing band is otherwise invisible: those people show
   * "no band set" one at a time on their own pages, and nobody ever adds up how many
   * are not being checked against anything.
   */
  router.get('/', deps.requireAuth, async (req, res) => {
    const { asOf } = asOfSchema.parse(req.query);
    const { role, employeeId } = authContext(req);

    const coverage = await deps.payBands.coverage(
      { role, employeeId },
      asOf === undefined ? {} : { asOf },
    );

    /* Not cached, unlike /api/lookups which also carries the bands. This response
       includes headcounts per band, which move whenever anybody is paid — and it is
       the screen somebody is looking at while editing. */
    res.setHeader('Cache-Control', 'no-store');
    res.status(HTTP_STATUS.OK).json(coverage);
  });

  router.put('/:jobLevelId/:country', deps.requireAuth, deps.requireHrAdmin, async (req, res) => {
    const key = bandKeySchema.parse(req.params);
    const body = saveBandSchema.parse(req.body);
    const { role, employeeId, userId } = authContext(req);

    const coverage = await deps.payBands.save(
      { role, employeeId },
      { ...key, ...body, changedByUserId: userId },
    );

    /* 200 with the whole list rather than 201 with the row. The figures that
         matter after setting a band are how many people are now below it, and those
         are only knowable by recomputing — so the screen redraws from one response
         instead of guessing and then refetching. */
    res.setHeader('Cache-Control', 'no-store');
    res.status(HTTP_STATUS.OK).json(coverage);
  });

  router.delete(
    '/:jobLevelId/:country',
    deps.requireAuth,
    deps.requireHrAdmin,
    async (req, res) => {
      const key = bandKeySchema.parse(req.params);
      const { role, employeeId, userId } = authContext(req);

      const coverage = await deps.payBands.remove(
        { role, employeeId },
        { ...key, changedByUserId: userId },
      );

      res.setHeader('Cache-Control', 'no-store');
      res.status(HTTP_STATUS.OK).json(coverage);
    },
  );

  return router;
}
