import { hashPassword, verifyPassword } from './password';

describe('passwords', () => {
  it('given a password, when hashed, then the result is an argon2id hash and not the password', async () => {
    const stored = await hashPassword('correct horse battery staple');

    expect(stored).toContain('$argon2id$');
    expect(stored).not.toContain('correct horse');
  });

  it('given the same password, when hashed twice, then the hashes differ', async () => {
    /* Salted, so two people with the same password do not share a hash — which
       would otherwise be visible to anybody reading the table. */
    const [first, second] = await Promise.all([hashPassword('same'), hashPassword('same')]);

    expect(first).not.toBe(second);
  });

  it('given the right password, when verified, then it succeeds', async () => {
    const stored = await hashPassword('right-password');

    await expect(verifyPassword(stored, 'right-password')).resolves.toBe(true);
  });

  it.each([
    ['a different password', 'wrong-password'],
    ['an empty password', ''],
    ['the password with different case', 'RIGHT-PASSWORD'],
    ['the password with trailing space', 'right-password '],
  ])('given %s, when verified, then it fails', async (_label, attempt) => {
    const stored = await hashPassword('right-password');

    await expect(verifyPassword(stored, attempt)).resolves.toBe(false);
  });

  it.each(['', 'not-a-hash', '$argon2id$broken'])(
    'given a stored value of %s, when verified, then it returns false rather than throwing',
    async (stored) => {
      /* A corrupted row must fail the login, not crash the request with a 500 —
       which would also tell an attacker that this account is different. */
      await expect(verifyPassword(stored, 'anything')).resolves.toBe(false);
    },
  );
});
