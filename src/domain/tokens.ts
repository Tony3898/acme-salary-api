import { createHash, randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { z } from 'zod';

/**
 * Tokens, as pure functions. The secret is passed in rather than read from
 * config, so this module has no environment to arrange in a test — and the same
 * code can be exercised with a throwaway secret.
 *
 * An access token is signed, not encrypted: whoever holds it can read the
 * payload. It therefore carries only what authorisation needs — who the user is,
 * their role, and which employee they are — and never an email, a password hash
 * or a salary.
 */

/**
 * Pinned on verification as well as signing. Accepting whatever the token's own
 * header claims is how the `alg: none` forgery works.
 */
export const ACCESS_TOKEN_ALGORITHM = 'HS256' as const;

const SECONDS_PER_MINUTE = 60;
const REFRESH_TOKEN_BYTES = 32;

export const ROLES = ['HR_ADMIN', 'HR_VIEWER', 'MANAGER', 'EMPLOYEE'] as const;
export type Role = (typeof ROLES)[number];

/** Roles whose visibility depends on which employee the login belongs to. */
export const SCOPED_ROLES: readonly Role[] = ['MANAGER', 'EMPLOYEE'];

export interface AccessTokenClaims {
  userId: number;
  role: Role;
  /** The employee this login belongs to, or null for an HR account. */
  employeeId: number | null;
}

/**
 * A signature only proves we issued the token, not that its contents still make
 * sense. Claims are validated on the way out too, so a stale or hand-crafted
 * payload cannot reach an access-scope decision.
 */
const claimsSchema = z
  .object({
    userId: z.number().int().positive(),
    role: z.enum(ROLES, { message: 'Unknown role in token.' }),
    employeeId: z.number().int().positive().nullable(),
    exp: z.number({ message: 'Token has no expiry.' }),
    iat: z.number(),
  })
  .refine((claims) => !SCOPED_ROLES.includes(claims.role) || claims.employeeId !== null, {
    message: 'A scoped role must name an employee.',
  });

export function signAccessToken(
  claims: AccessTokenClaims,
  secret: string,
  ttlMinutes: number,
): string {
  return jwt.sign(claims, secret, {
    algorithm: ACCESS_TOKEN_ALGORITHM,
    expiresIn: ttlMinutes * SECONDS_PER_MINUTE,
  });
}

/** Throws on anything not currently valid: bad signature, expiry, or claims. */
export function verifyAccessToken(token: string, secret: string): AccessTokenClaims {
  const payload = jwt.verify(token, secret, { algorithms: [ACCESS_TOKEN_ALGORITHM] });
  const claims = claimsSchema.parse(payload);

  return { userId: claims.userId, role: claims.role, employeeId: claims.employeeId };
}

export interface IssuedRefreshToken {
  /** Sent to the browser in an httpOnly cookie. Never stored. */
  token: string;
  /** Stored. A leaked database cannot be replayed as a session. */
  tokenHash: string;
}

export function issueRefreshToken(): IssuedRefreshToken {
  const token = randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
  return { token, tokenHash: hashRefreshToken(token) };
}

/**
 * SHA-256, deliberately not argon2. Lookup happens by hash on every refresh, so
 * it has to be deterministic — and the input is already 256 bits of randomness,
 * so there is nothing to brute-force. Passwords are the opposite case: low
 * entropy, compared by verification, and hashed with argon2id.
 */
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
