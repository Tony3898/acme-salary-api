import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import type { Container } from './container';
import { HTTP_STATUS } from './errors';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { createRateLimiter } from './middleware/rateLimit';
import { requireAuth } from './middleware/requireAuth';
import { createAuthRouter } from './routes/auth';
import { createEmployeeRouter } from './routes/employees';
import { createLookupRouter } from './routes/lookups';

/**
 * Builds the HTTP layer around an already-built container.
 *
 * Takes the container rather than creating one, so a test can start an app over an
 * in-process Postgres, and so nothing here decides how a service is constructed.
 * The app is a shape; the container is the instance.
 */

/** Enough for a login or a filter; the CSV importer will raise its own route's limit. */
const JSON_BODY_LIMIT = '100kb';

export interface AppOptions {
  container: Container;
  jwtSecret: string;
  /** Exact origins. No wildcard is possible: the UI sends a cookie. */
  corsOrigins: readonly string[];
  secureCookies: boolean;
  /**
   * How many reverse proxies sit in front. 0 means none, and the client IP is the
   * socket's.
   */
  trustProxyHops: number;
  rateLimits: {
    windowMinutes: number;
    loginMaxRequests: number;
    refreshMaxRequests: number;
  };
}

export function createApp(options: AppOptions): Express {
  const app = express();

  /* Deliberately explicit, and never `true`. Trusting every hop lets a client set
     X-Forwarded-For itself, which makes it look like a new IP on each request and
     turns the login rate limit into decoration. */
  if (options.trustProxyHops > 0) {
    app.set('trust proxy', options.trustProxyHops);
  }

  // Security headers first, so they are set even on a rejected request.
  app.use(helmet());
  app.use(
    cors({
      /* Spread because config freezes its array, and an exact list because
         `credentials: true` forbids a wildcard. An origin that is not on the list
         simply gets no CORS header, and the browser stops it. */
      origin: [...options.corsOrigins],
      credentials: true,
    }),
  );
  app.use(express.json({ limit: JSON_BODY_LIMIT }));
  app.use(cookieParser());

  /* Separate counters. Signing in is the guessable one and is held tight;
     refreshing is done by legitimate clients on a timer and needs more room. */
  const loginLimiter = createRateLimiter({
    windowMinutes: options.rateLimits.windowMinutes,
    maxRequests: options.rateLimits.loginMaxRequests,
  });
  const refreshLimiter = createRateLimiter({
    windowMinutes: options.rateLimits.windowMinutes,
    maxRequests: options.rateLimits.refreshMaxRequests,
  });

  /** Unauthenticated and does not touch the database, so a health check cannot become a load test. */
  app.get('/health', (_req, res) => {
    res.status(HTTP_STATUS.OK).json({ status: 'ok' });
  });

  // One instance, shared by every route that needs a signed-in caller.
  const authenticated = requireAuth(options.jwtSecret);

  app.use(
    '/api/auth',
    createAuthRouter({
      auth: options.container.auth,
      requireAuth: authenticated,
      loginLimiter,
      refreshLimiter,
      secureCookies: options.secureCookies,
    }),
  );

  app.use(
    '/api/employees',
    createEmployeeRouter({ employees: options.container.employees, requireAuth: authenticated }),
  );

  app.use(
    '/api/lookups',
    createLookupRouter({ lookups: options.container.lookups, requireAuth: authenticated }),
  );

  // Last: an unmatched URL is a 404 in the same shape as any other failure.
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
