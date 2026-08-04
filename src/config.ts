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
  /* Password for the seeded demo logins. Defaulted so local setup needs no
     configuration, and overridable so a public deployment is not using the
     password printed in the README. */
  SEED_DEMO_PASSWORD: z.string().min(8).default('AcmeDemo!2026'),
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
