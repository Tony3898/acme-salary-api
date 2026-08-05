import { randomBytes } from 'node:crypto';
import type { Database } from '../db/database';
import { hashPassword, verifyPassword } from '../domain/password';
import type { Role } from '../domain/roles';
import { hashRefreshToken, issueRefreshToken, signAccessToken } from '../domain/tokens';
import { invalidCredentials, unauthenticated } from '../shared/errors';
import { logger, maskEmail } from '../shared/logger';
import {
  createRefreshToken,
  findRefreshTokenByHash,
  findUserByEmail,
  findUserById,
  revokeAllRefreshTokensForUser,
  revokeRefreshToken,
  type UserAccount,
  type UserIdentity,
} from '../repositories/users';

/**
 * Signing in, staying signed in, and signing out.
 *
 * Built once at startup by container.ts and shared by every request, so the
 * secret, the token lifetimes and the connection pool are read once rather than
 * per call. Nothing here is stateful — the instance exists to hold its
 * dependencies, not a session.
 */

const SECONDS_PER_MINUTE = 60;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
const DECOY_SECRET_BYTES = 32;

/** The same vague answer wherever a session turns out not to be usable. */
const NO_SESSION = 'Your session has ended. Please sign in again.';

export interface AuthServiceDeps {
  db: Database;
  jwtSecret: string;
  accessTokenTtlMinutes: number;
  refreshTokenTtlDays: number;
  /**
   * Injected so a test can place a token's expiry in the past without waiting,
   * and so "now" is one decision rather than a `new Date()` in each function.
   */
  now: () => Date;
}

export interface SessionUser {
  id: number;
  email: string;
  role: Role;
  employeeId: number | null;
}

export interface Session {
  accessToken: string;
  /** Seconds until the access token expires; the client refreshes before then. */
  expiresInSeconds: number;
  /** Goes into an httpOnly cookie and is never stored server-side in this form. */
  refreshToken: string;
  refreshTokenExpiresAt: Date;
  user: SessionUser;
}

export interface Credentials {
  email: string;
  password: string;
}

export interface AuthService {
  login(credentials: Credentials): Promise<Session>;
  refresh(refreshToken: string | undefined): Promise<Session>;
  logout(refreshToken: string | undefined): Promise<void>;
  currentUser(userId: number): Promise<UserIdentity>;
}

export function createAuthService(deps: AuthServiceDeps): AuthService {
  /**
   * An argon2 hash of a value nobody knows, verified against when the email is
   * unknown.
   *
   * Without it, a missing account answers in a fraction of a millisecond while a
   * real one spends ~20ms hashing — a difference an attacker can measure, which
   * turns the login form into a test for whether an address has an account.
   * Comparing against a decoy makes both paths do the same work.
   *
   * Started here rather than on the first miss, so this shared instance holds no
   * mutable state and the first failed login costs no more than the thousandth.
   * Awaited only when it is needed, so startup does not block on it.
   */
  const decoyHash = hashPassword(randomBytes(DECOY_SECRET_BYTES).toString('hex'));

  async function startSession(account: SessionUser): Promise<Session> {
    const now = deps.now();
    const { token, tokenHash } = issueRefreshToken();
    const refreshTokenExpiresAt = new Date(
      now.getTime() + deps.refreshTokenTtlDays * MILLISECONDS_PER_DAY,
    );

    await createRefreshToken(deps.db, {
      userId: account.id,
      tokenHash,
      expiresAt: refreshTokenExpiresAt,
    });

    return {
      accessToken: signAccessToken(
        { userId: account.id, role: account.role, employeeId: account.employeeId },
        deps.jwtSecret,
        deps.accessTokenTtlMinutes,
      ),
      expiresInSeconds: deps.accessTokenTtlMinutes * SECONDS_PER_MINUTE,
      refreshToken: token,
      refreshTokenExpiresAt,
      user: identityOf(account),
    };
  }

  return {
    /**
     * Both failure branches — unknown email, wrong password — raise the identical
     * error and take comparable time. Either one leaking would let the login form
     * be used to enumerate who works here.
     */
    async login(credentials: Credentials): Promise<Session> {
      const account: UserAccount | undefined = await findUserByEmail(deps.db, credentials.email);
      const passwordHash = account?.passwordHash ?? (await decoyHash);
      const passwordMatches = await verifyPassword(passwordHash, credentials.password);

      if (!account || !passwordMatches) {
        // Masked: enough to help with a support question, not a log full of addresses.
        logger.warn('auth.login.rejected', { email: maskEmail(credentials.email) });
        throw invalidCredentials();
      }

      logger.info('auth.login.succeeded', { userId: account.id, role: account.role });
      return startSession(account);
    },

    /**
     * Exchanges a refresh token for a new pair, invalidating the one presented.
     * Rotation is what makes logout final and a stolen cookie short-lived.
     */
    async refresh(refreshToken: string | undefined): Promise<Session> {
      if (!refreshToken) {
        throw unauthenticated(NO_SESSION);
      }

      const now = deps.now();
      const tokenHash = hashRefreshToken(refreshToken);
      const stored = await findRefreshTokenByHash(deps.db, tokenHash);

      if (!stored) {
        throw unauthenticated(NO_SESSION);
      }

      if (stored.revokedAt !== null) {
        /* A token that was rotated should be in nobody's hands: the client that
           rotated it was handed a replacement and threw this one away. Seeing it
           again means two parties hold it, and there is no way to tell which is
           the owner — so every session for the account ends. */
        if (stored.revokedReason === 'ROTATED') {
          const sessionsEnded = await revokeAllRefreshTokensForUser(
            deps.db,
            stored.userId,
            now,
            'REUSE_DETECTED',
          );
          logger.warn('auth.refresh.reuseDetected', { userId: stored.userId, sessionsEnded });
        } else {
          /* Logged out, or already caught by the check above. Replaying one of
             those is ordinary — a background tab retrying after another tab signed
             out — and must not sign the person out of their other devices. */
          logger.info('auth.refresh.endedSession', { userId: stored.userId });
        }

        throw unauthenticated(NO_SESSION);
      }

      if (stored.expiresAt.getTime() <= now.getTime()) {
        throw unauthenticated(NO_SESSION);
      }

      /* The database decides who rotates it. Two requests holding the same token
         both saw it live above; only the one whose UPDATE matched continues, so a
         race cannot mint two sessions from one token. */
      if (!(await revokeRefreshToken(deps.db, tokenHash, now, 'ROTATED'))) {
        throw unauthenticated(NO_SESSION);
      }

      const account = await findUserById(deps.db, stored.userId);
      if (!account) {
        // The login was deleted while the session was open.
        throw unauthenticated(NO_SESSION);
      }

      return startSession(account);
    },

    /**
     * Idempotent, and silent about what it found. Logging out twice, or with a
     * cookie we have never seen, still leaves the caller with no session — which
     * is the only outcome they asked for.
     */
    async logout(refreshToken: string | undefined): Promise<void> {
      if (!refreshToken) {
        return;
      }

      const ended = await revokeRefreshToken(
        deps.db,
        hashRefreshToken(refreshToken),
        deps.now(),
        'LOGGED_OUT',
      );
      if (ended) {
        logger.info('auth.logout', {});
      }
    },

    /** The account behind a valid access token, or 401 if it no longer exists. */
    async currentUser(userId: number): Promise<UserIdentity> {
      const account = await findUserById(deps.db, userId);
      if (!account) {
        throw unauthenticated(NO_SESSION);
      }
      return account;
    },
  };
}

function identityOf(account: SessionUser): SessionUser {
  /* Rebuilt field by field rather than spread, so a column added to `users`
     later cannot travel into a response by accident. */
  return {
    id: account.id,
    email: account.email,
    role: account.role,
    employeeId: account.employeeId,
  };
}
