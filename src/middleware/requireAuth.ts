import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { verifyAccessToken, type AccessTokenClaims } from '../domain/tokens';
import { unauthenticated } from '../shared/errors';

/**
 * Who is making this request.
 *
 * Attached to the request rather than held in a module, because a shared instance
 * must never hold per-request state — two requests overlap at every `await`, and
 * one would end up answering with the other's identity.
 */
declare module 'express-serve-static-core' {
  interface Request {
    auth?: AccessTokenClaims;
  }
}

/** `Authorization: Bearer <token>` and nothing else — no token in a query string, where it would land in access logs. */
const BEARER_PATTERN = /^Bearer (\S+)$/;

/**
 * Rejects the request unless it carries a valid access token, and records the
 * claims for the handlers behind it.
 *
 * Expired, tampered, malformed and missing all produce the same 401. The client
 * does the same thing in every case — try to refresh, then send the user to the
 * login page — and distinguishing them would tell an attacker which part of a
 * forged token to work on next.
 */
export function requireAuth(jwtSecret: string): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const token = BEARER_PATTERN.exec(req.get('authorization') ?? '')?.[1];

    if (!token) {
      next(unauthenticated());
      return;
    }

    try {
      req.auth = verifyAccessToken(token, jwtSecret);
    } catch {
      next(unauthenticated());
      return;
    }

    next();
  };
}

/**
 * The claims for a request that has been through `requireAuth`.
 *
 * Throws rather than returning undefined: a route reaching here without the
 * middleware in front of it is a wiring mistake, and the honest response to that
 * is a 500, not a request quietly running with no identity.
 */
export function authContext(req: Request): AccessTokenClaims {
  if (!req.auth) {
    throw new Error('authContext called on a route that is not behind requireAuth.');
  }
  return req.auth;
}
