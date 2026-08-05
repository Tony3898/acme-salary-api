import request from 'supertest';
import { accessTokenFrom } from './http';
import { TEST_PASSWORD, type TestHarness } from './testApp';

/**
 * Signing in as each role once, and handing out the headers.
 *
 * Every HTTP test needs this and each was writing its own loop over the four
 * accounts. It matters more than tidiness: argon2 is deliberately slow, so logging
 * in per test rather than per file is seconds of every run spent proving the
 * password hasher works.
 */

export const ALL_ROLE_EMAILS = [
  'hr.admin@acme.test',
  'hr.viewer@acme.test',
  'manager@acme.test',
  'employee@acme.test',
] as const;

export type RoleEmail = (typeof ALL_ROLE_EMAILS)[number];

export interface Signins {
  /** The Authorization header for that account, or a clear failure if it never signed in. */
  as: (email: RoleEmail) => string;
}

export async function signInEveryone(
  harness: TestHarness,
  emails: readonly RoleEmail[] = ALL_ROLE_EMAILS,
): Promise<Signins> {
  const headers = new Map<string, string>();

  for (const email of emails) {
    const login = await request(harness.app)
      .post('/api/auth/login')
      .send({ email, password: TEST_PASSWORD });

    headers.set(email, `Bearer ${accessTokenFrom(login)}`);
  }

  return {
    as: (email) => {
      const header = headers.get(email);
      if (header === undefined) {
        throw new Error(`${email} was not signed in for this test file.`);
      }
      return header;
    },
  };
}
