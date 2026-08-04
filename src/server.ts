import { createApp } from './app';
import { config } from './config';
import { createContainer } from './container';
import { logger } from './logger';

/**
 * The process entry point, and the only place a container is created.
 *
 * Order matters: config is validated first, so a missing variable stops the
 * process before it opens a connection or accepts a request.
 */

/** How long a shutdown may take before the process is killed anyway. */
const SHUTDOWN_TIMEOUT_MS = 10_000;

const container = createContainer({
  databaseUrl: config.DATABASE_URL,
  jwtSecret: config.JWT_SECRET,
  accessTokenTtlMinutes: config.ACCESS_TOKEN_TTL_MINUTES,
  refreshTokenTtlDays: config.REFRESH_TOKEN_TTL_DAYS,
});

const app = createApp({
  container,
  jwtSecret: config.JWT_SECRET,
  corsOrigins: config.CORS_ORIGIN,
  secureCookies: config.isProduction,
  trustProxyHops: config.TRUST_PROXY_HOPS,
  rateLimits: {
    windowMinutes: config.AUTH_RATE_LIMIT_WINDOW_MINUTES,
    loginMaxRequests: config.LOGIN_RATE_LIMIT_MAX,
    refreshMaxRequests: config.REFRESH_RATE_LIMIT_MAX,
  },
});

const server = app.listen(config.PORT, () => {
  logger.info('server.started', { port: config.PORT, environment: config.NODE_ENV });
});

/**
 * Stop accepting connections, let the requests already running finish, then close
 * the pool. Without this, a deploy cuts off whatever was in flight — and a raise
 * being recorded is not something to interrupt.
 */
function shutdown(signal: string): void {
  logger.info('server.stopping', { signal });

  const killTimer = setTimeout(() => {
    logger.error('server.shutdownTimedOut', { timeoutMs: SHUTDOWN_TIMEOUT_MS });
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  // Do not keep the process alive purely for this timer.
  killTimer.unref();

  server.close(() => {
    container
      .close()
      .then(() => {
        logger.info('server.stopped', {});
        process.exit(0);
      })
      .catch((error: unknown) => {
        logger.error('server.shutdownFailed', { cause: error });
        process.exit(1);
      });
  });
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    shutdown(signal);
  });
}
