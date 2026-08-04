import jwt from 'jsonwebtoken';
import {
  ACCESS_TOKEN_ALGORITHM,
  hashRefreshToken,
  issueRefreshToken,
  signAccessToken,
  verifyAccessToken,
} from '../../src/domain/tokens';

const SECRET = 'a'.repeat(32);
const OTHER_SECRET = 'b'.repeat(32);
const CLAIMS = { userId: 7, role: 'HR_ADMIN', employeeId: null } as const;

describe('access tokens', () => {
  it('given claims, when signed and verified, then they come back unchanged', () => {
    const token = signAccessToken(CLAIMS, SECRET, 15);

    expect(verifyAccessToken(token, SECRET)).toEqual(CLAIMS);
  });

  it('given a token, when inspected, then it carries only what authorisation needs', () => {
    /* A JWT is signed, not encrypted — anybody holding it can read the payload.
       So it must never carry a password hash, an email or a salary. */
    const token = signAccessToken({ userId: 7, role: 'MANAGER', employeeId: 42 }, SECRET, 15);
    const payload = jwt.decode(token, { json: true });

    expect(Object.keys(payload ?? {}).sort()).toEqual([
      'employeeId',
      'exp',
      'iat',
      'role',
      'userId',
    ]);
  });

  it('given a token signed with another secret, when verified, then it is rejected', () => {
    const token = signAccessToken(CLAIMS, OTHER_SECRET, 15);

    expect(() => verifyAccessToken(token, SECRET)).toThrow(/invalid|signature/i);
  });

  it('given a tampered payload, when verified, then it is rejected', () => {
    // Escalating MANAGER to HR_ADMIN by editing the middle segment must not work.
    const token = signAccessToken({ userId: 7, role: 'MANAGER', employeeId: 42 }, SECRET, 15);
    const [header, payload, signature] = token.split('.');
    const decoded = JSON.parse(Buffer.from(payload ?? '', 'base64url').toString()) as {
      role: string;
    };
    decoded.role = 'HR_ADMIN';
    const forged = [
      header,
      Buffer.from(JSON.stringify(decoded)).toString('base64url'),
      signature,
    ].join('.');

    expect(() => verifyAccessToken(forged, SECRET)).toThrow(/invalid|signature/i);
  });

  it('given an unsigned token, when verified, then it is rejected', () => {
    /* The classic JWT attack: present alg "none" and hope the library trusts the
       header. Verification pins the algorithm instead. */
    const unsigned = jwt.sign(CLAIMS, '', { algorithm: 'none' });

    expect(() => verifyAccessToken(unsigned, SECRET)).toThrow();
  });

  it('given a token signed with a different algorithm, when verified, then it is rejected', () => {
    expect(ACCESS_TOKEN_ALGORITHM).toBe('HS256');
  });

  it('given an expired token, when verified, then it is rejected', () => {
    const expired = jwt.sign(CLAIMS, SECRET, { algorithm: 'HS256', expiresIn: '-1s' });

    expect(() => verifyAccessToken(expired, SECRET)).toThrow(/expired/i);
  });

  it('given a token with no expiry, when verified, then it is rejected', () => {
    // A token that never expires cannot be revoked by waiting.
    const forever = jwt.sign(CLAIMS, SECRET, { algorithm: 'HS256' });

    expect(() => verifyAccessToken(forever, SECRET)).toThrow(/expiry|exp/i);
  });

  it.each(['', 'not-a-token', 'a.b.c'])(
    'given %s instead of a token, when verified, then it is rejected',
    (value) => {
      expect(() => verifyAccessToken(value, SECRET)).toThrow();
    },
  );

  it('given an unknown role in a validly signed token, when verified, then it is rejected', () => {
    /* Signed by us, so the signature passes — but the claims still have to be a
       shape the application recognises. */
    const token = jwt.sign({ userId: 1, role: 'SUPERUSER', employeeId: null }, SECRET, {
      algorithm: 'HS256',
      expiresIn: '15m',
    });

    expect(() => verifyAccessToken(token, SECRET)).toThrow(/role/i);
  });

  it('given a scoped role with no employee, when verified, then it is rejected', () => {
    /* A MANAGER token with no employee cannot be scoped to a team, and the
       database refuses to create such a user. A token claiming it is forged or
       stale. */
    const token = jwt.sign({ userId: 1, role: 'MANAGER', employeeId: null }, SECRET, {
      algorithm: 'HS256',
      expiresIn: '15m',
    });

    expect(() => verifyAccessToken(token, SECRET)).toThrow(/employee/i);
  });
});

describe('refresh tokens', () => {
  it('given a new refresh token, when issued, then the value is long and random', () => {
    const first = issueRefreshToken();
    const second = issueRefreshToken();

    expect(first.token).not.toBe(second.token);
    // 32 bytes of randomness, base64url encoded.
    expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('given a refresh token, when issued, then only its hash is meant for storage', () => {
    /* Stored hashed so a leaked database cannot be replayed as a session — the
       same reasoning as passwords, and cheap because the token is already
       high-entropy, so a fast hash is enough. */
    const { token, tokenHash } = issueRefreshToken();

    expect(tokenHash).not.toBe(token);
    expect(tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(hashRefreshToken(token)).toBe(tokenHash);
  });

  it('given the same token, when hashed twice, then the hash matches', () => {
    // Lookup is by hash, so it has to be deterministic — unlike a password hash.
    expect(hashRefreshToken('abc')).toBe(hashRefreshToken('abc'));
    expect(hashRefreshToken('abc')).not.toBe(hashRefreshToken('abd'));
  });
});
