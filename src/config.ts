import 'dotenv/config';
import { z } from 'zod';

/**
 * Every environment variable is read here and nowhere else, and validated once at
 * startup. A missing or malformed value fails the process immediately rather than
 * surfacing as `undefined` somewhere in a request months later.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  /* Signs access tokens. Deliberately has no default: a fallback secret in
     source would mean anybody could mint a valid token for a deployment whose
     operator forgot to set one. 32 characters minimum. */
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  /** Short-lived by design: the refresh token is what provides continuity. */
  ACCESS_TOKEN_TTL_MINUTES: z.coerce.number().int().positive().max(60).default(15),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().max(90).default(7),
  /* Password for the seeded demo logins. Defaulted so local setup needs no
     configuration, and overridable so a public deployment is not using the
     password printed in the README. */
  SEED_DEMO_PASSWORD: z.string().min(8).default('AcmeDemo!2026'),
  /* Whether the employee data is generated rather than real. The pay-gap screen
     says so, because the gap in the seeded data was introduced on purpose —
     randomly generated salaries show none, and a screen that always reads 0%
     demonstrates nothing. Defaults to true because that is what a fresh checkout
     has; the deployment that loads real people sets it to false, and the caveat
     disappears from one place rather than from however many screens repeat it. */
  SYNTHETIC_DATA: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  /* How many reverse proxies sit in front of this process. 0 locally; 1 behind a
     single nginx or load balancer. Used for the client IP, which is what the rate
     limiter counts — so guessing high lets a client forge X-Forwarded-For and
     guessing low lumps every client behind the proxy together. */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  AUTH_RATE_LIMIT_WINDOW_MINUTES: z.coerce.number().int().positive().max(1440).default(15),
  /** Password guesses per IP per window. */
  LOGIN_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
  /* Higher: a legitimate client refreshes on a timer, and several open tabs each
     refresh on their own. A refresh token is 256 bits of randomness, so this is a
     brake on abuse rather than a defence against guessing. */
  REFRESH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(60),
  CORS_ORIGIN: z
    .string()
    .default('http://localhost:5173')
    .transform((value) =>
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
    ),
});

/**
 * A pure function of the environment, so it can be tested by calling it rather
 * than by reloading modules with a doctored `process.env`.
 */
export function parseConfig(env: NodeJS.ProcessEnv) {
  const parsed = schema.safeParse(env);

  if (!parsed.success) {
    /* Names and rules only, never values: DATABASE_URL contains the database
       password, and this message goes to a log. */
    const problems = parsed.error.issues.map(
      (issue) => `${issue.path.join('.')}: ${issue.message}`,
    );
    throw new Error(`Invalid environment configuration:\n  ${problems.join('\n  ')}`);
  }

  return Object.freeze({
    ...parsed.data,
    isProduction: parsed.data.NODE_ENV === 'production',
    isTest: parsed.data.NODE_ENV === 'test',
  });
}

export const config = parseConfig(process.env);

export type Config = ReturnType<typeof parseConfig>;
