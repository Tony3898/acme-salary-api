import rateLimit from 'express-rate-limit';
import type { RequestHandler } from 'express';
import { rateLimited } from '../shared/errors';

const MILLISECONDS_PER_MINUTE = 60_000;

export interface RateLimitOptions {
  windowMinutes: number;
  maxRequests: number;
}

/**
 * Counts requests per client IP over a rolling window.
 *
 * In-memory, which means the count is per server process. That is the right
 * trade-off for one server; a second server would each allow the full quota, and
 * the fix at that point is a shared store — the same boundary as the lookup cache
 * in docs/design-notes.md.
 *
 * The limits themselves come from config, so a deployment under attack can be
 * tightened without a release.
 */
export function createRateLimiter(options: RateLimitOptions): RequestHandler {
  return rateLimit({
    windowMs: options.windowMinutes * MILLISECONDS_PER_MINUTE,
    limit: options.maxRequests,
    /* Standard RateLimit headers so the client can back off deliberately rather
       than by guessing. The legacy X- headers add nothing. */
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    /* Refused requests go through the error handler like every other failure, so
       the body shape is the same one the client already parses. */
    handler: (_req, _res, next) => {
      next(rateLimited());
    },
  });
}
