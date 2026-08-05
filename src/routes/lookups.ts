import { Router, type RequestHandler } from 'express';
import { HTTP_STATUS } from '../shared/errors';
import type { LookupService } from '../services/lookups';

/** How long a browser may reuse this before asking again. */
const BROWSER_CACHE_SECONDS = 300;

export interface LookupRouterDeps {
  lookups: LookupService;
  requireAuth: RequestHandler;
}

/**
 * Reference data for the filter bar and the pay-band comparisons.
 *
 * Behind authentication, even though none of it is personal: pay bands say what
 * the company pays for a level in a country, which is not something to publish.
 *
 * `private` on the cache header, so a shared proxy never holds it — the response
 * is the same for every user today, and a header that stops being true later is
 * worse than one that was never there.
 */
export function createLookupRouter(deps: LookupRouterDeps): Router {
  const router = Router();

  router.get('/', deps.requireAuth, async (_req, res) => {
    const lookups = await deps.lookups.get();

    res.set('Cache-Control', `private, max-age=${BROWSER_CACHE_SECONDS}`);
    res.status(HTTP_STATUS.OK).json(lookups);
  });

  return router;
}
