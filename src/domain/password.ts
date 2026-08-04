import { hash, verify } from '@node-rs/argon2';

/**
 * The one place that decides how passwords are stored. Both the seed and the
 * login path go through here, so the algorithm cannot be chosen twice and
 * disagree.
 *
 * argon2id: memory-hard, so a leaked table is expensive to attack offline, and
 * the id variant resists both side-channel and time-memory tradeoffs. The
 * library's default cost parameters are used deliberately — hand-tuned figures
 * age badly, and these are revised as hardware moves.
 */
const ARGON2ID = 2;

export async function hashPassword(plainText: string): Promise<string> {
  return hash(plainText, { algorithm: ARGON2ID });
}

/**
 * Returns false rather than throwing when the stored value is not a usable hash.
 *
 * A corrupted or truncated row should fail the login like any wrong password. If
 * it threw, the request would 500 — which both loses the login and tells an
 * attacker that this particular account behaves differently from the rest.
 */
export async function verifyPassword(storedHash: string, plainText: string): Promise<boolean> {
  try {
    return await verify(storedHash, plainText);
  } catch {
    return false;
  }
}
