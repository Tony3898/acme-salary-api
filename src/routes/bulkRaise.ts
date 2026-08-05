import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { HTTP_STATUS } from '../shared/errors';
import { authContext } from '../middleware/requireAuth';
import { MAX_SELECTABLE, type BulkRaiseService } from '../services/bulkRaise';
import {
  employeeFilterSchema,
  isoDateSchema,
  MAX_REASON_LENGTH,
  positiveIdSchema,
} from './schemas';

/**
 * Applying one percentage to a lot of people.
 *
 * `apply` is a query parameter and the body is identical either way, so a client
 * previews and then applies the same request twice. Two endpoints would let the
 * two drift, and the whole promise of this feature is that they cannot.
 */

/*
 * The filters come from employeeFilterSchema: absent means everybody, which is a real
 * thing to want for a company-wide cost-of-living award — and the preview is there so
 * that nobody does it by accident.
 */
const bulkRaiseSchema = employeeFilterSchema.extend({
  /* A string. "3.5" as a JSON number is a double, and the percentage that decides
     ten thousand salaries should be the digits somebody typed. Bounded because the
     rejection message quotes it back. */
  percent: z.string().trim().min(1, 'A percentage is required.').max(16),
  effectiveFrom: isoDateSchema('effectiveFrom'),
  reason: z.string().trim().max(MAX_REASON_LENGTH).optional(),
  /**
   * Apply to only these people, of the ones the filters matched.
   *
   * Bounded by the same number the report will list, because a selection can only be
   * made from a list somebody has seen — and because an unbounded array of ids is a
   * way to make one request do arbitrary work.
   *
   * It narrows and can never widen: the service intersects it with what the filters
   * and the access scope already allowed, so naming an id outside those changes
   * nothing rather than reaching it.
   */
  employeeIds: z.array(positiveIdSchema).max(MAX_SELECTABLE).optional(),
});

const applyQuerySchema = z.object({
  apply: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
});

export interface BulkRaiseRouterDeps {
  bulkRaise: BulkRaiseService;
  requireAuth: RequestHandler;
  requireHrAdmin: RequestHandler;
}

export function createBulkRaiseRouter(deps: BulkRaiseRouterDeps): Router {
  const router = Router();

  /**
   * POST for a preview as well as for an apply.
   *
   * A preview writes nothing, so GET is tempting. But the request carries filters,
   * a percentage and a date, and putting a company-wide pay decision in a URL puts
   * it in every access log and every browser history — and makes it linkable, which
   * for something one query parameter away from being applied is the wrong
   * affordance entirely.
   */
  router.post('/', deps.requireAuth, deps.requireHrAdmin, async (req, res) => {
    const { apply } = applyQuerySchema.parse(req.query);
    const body = bulkRaiseSchema.parse(req.body);
    const { role, employeeId, userId } = authContext(req);

    const report = await deps.bulkRaise.run(
      { role, employeeId },
      {
        percent: body.percent,
        effectiveFrom: body.effectiveFrom,
        ...(body.reason === undefined ? {} : { reason: body.reason }),
        ...(body.country === undefined ? {} : { country: body.country }),
        ...(body.departmentId === undefined ? {} : { departmentId: body.departmentId }),
        ...(body.jobLevelId === undefined ? {} : { jobLevelId: body.jobLevelId }),
        ...(body.employeeIds === undefined ? {} : { employeeIds: body.employeeIds }),
        apply,
        // From the verified token, never from the body. Every pay change has an author.
        recordedByUserId: userId,
      },
    );

    res.setHeader('Cache-Control', 'no-store');
    res.status(HTTP_STATUS.OK).json(report);
  });

  return router;
}
