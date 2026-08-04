import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Role } from '../domain/roles';
import { forbidden } from '../errors';
import { authContext } from './requireAuth';

/**
 * Restricts a route to particular roles. Runs behind `requireAuth`, which is what
 * put the claims on the request.
 *
 * This stops a role *doing* things. It deliberately says nothing about which
 * employees a request may see — that is decided by the access scope applied
 * inside the query, because a check here would only guard the routes somebody
 * remembered to decorate.
 */
export function requireRole(...allowed: readonly Role[]): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!allowed.includes(authContext(req).role)) {
      next(forbidden());
      return;
    }
    next();
  };
}
