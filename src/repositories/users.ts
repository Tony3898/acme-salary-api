import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Database } from '../db/database';
import { refreshTokens, users, type refreshTokenRevocationEnum } from '../db/schema';
import type { Role } from '../domain/roles';

/**
 * All database access for logins and sessions. Every column is listed explicitly
 * rather than selecting the row, so adding a column to `users` cannot silently
 * widen what a caller receives — and `passwordHash` only reaches the one function
 * that has a reason to compare it.
 */

/** A login as the auth service needs it: the hash included, for comparison only. */
export interface UserAccount {
  id: number;
  email: string;
  passwordHash: string;
  role: Role;
  employeeId: number | null;
}

/** The same login without the hash, for anything that ends up in a response. */
export type UserIdentity = Omit<UserAccount, 'passwordHash'>;

const accountColumns = {
  id: users.id,
  email: users.email,
  passwordHash: users.passwordHash,
  role: users.role,
  employeeId: users.employeeId,
};

const identityColumns = {
  id: users.id,
  email: users.email,
  role: users.role,
  employeeId: users.employeeId,
};

/**
 * Case-insensitive, matching the `users_email_lower_idx` unique index — so the
 * lookup uses that index rather than scanning, and "Ada@acme.test" reaches the
 * account created as "ada@acme.test" instead of looking like an unknown user.
 *
 * The email is a bound parameter inside the template, never pasted into the SQL.
 */
export async function findUserByEmail(
  db: Database,
  email: string,
): Promise<UserAccount | undefined> {
  const [account] = await db
    .select(accountColumns)
    .from(users)
    .where(sql`lower(${users.email}) = lower(${email})`)
    .limit(1);

  return account;
}

export async function findUserById(db: Database, id: number): Promise<UserIdentity | undefined> {
  const [identity] = await db.select(identityColumns).from(users).where(eq(users.id, id)).limit(1);

  return identity;
}

export interface NewRefreshToken {
  userId: number;
  /** Only ever the hash. The token itself exists solely in the client's cookie. */
  tokenHash: string;
  expiresAt: Date;
}

export async function createRefreshToken(db: Database, token: NewRefreshToken): Promise<void> {
  await db.insert(refreshTokens).values(token);
}

export type RevocationReason = (typeof refreshTokenRevocationEnum.enumValues)[number];

export interface StoredRefreshToken {
  id: number;
  userId: number;
  expiresAt: Date;
  revokedAt: Date | null;
  revokedReason: RevocationReason | null;
}

export async function findRefreshTokenByHash(
  db: Database,
  tokenHash: string,
): Promise<StoredRefreshToken | undefined> {
  const [stored] = await db
    .select({
      id: refreshTokens.id,
      userId: refreshTokens.userId,
      expiresAt: refreshTokens.expiresAt,
      revokedAt: refreshTokens.revokedAt,
      revokedReason: refreshTokens.revokedReason,
    })
    .from(refreshTokens)
    .where(eq(refreshTokens.tokenHash, tokenHash))
    .limit(1);

  return stored;
}

/**
 * Revokes a token only if it is still live, and reports whether this call was the
 * one that did it.
 *
 * The condition is what makes rotation safe. Two requests arriving with the same
 * refresh token both see it unrevoked if they read first and write second; here
 * the database decides, and exactly one of them gets `true`. The loser is treated
 * as a replay rather than being handed a second session.
 */
export async function revokeRefreshToken(
  db: Database,
  tokenHash: string,
  at: Date,
  reason: RevocationReason,
): Promise<boolean> {
  const revoked = await db
    .update(refreshTokens)
    .set({ revokedAt: at, revokedReason: reason })
    .where(and(eq(refreshTokens.tokenHash, tokenHash), isNull(refreshTokens.revokedAt)))
    .returning({ id: refreshTokens.id });

  return revoked.length > 0;
}

/**
 * Ends every session belonging to a user, and reports how many. Used when a
 * revoked token comes back: we cannot tell a stolen cookie from a replayed one,
 * so the safe reading is that the account is compromised.
 */
export async function revokeAllRefreshTokensForUser(
  db: Database,
  userId: number,
  at: Date,
  reason: RevocationReason,
): Promise<number> {
  const revoked = await db
    .update(refreshTokens)
    .set({ revokedAt: at, revokedReason: reason })
    .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)))
    .returning({ id: refreshTokens.id });

  return revoked.length;
}
