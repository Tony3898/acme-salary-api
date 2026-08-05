import { logger, maskEmail, redact } from '../src/shared/logger';

describe('redact', () => {
  it.each([
    'password',
    'passwordHash',
    'refreshToken',
    'accessToken',
    'tokenHash',
    'jwtSecret',
    'authorization',
    'cookie',
  ])('given a field called %s, when logged, then its value is removed', (field) => {
    const line = redact({ [field]: 'the-actual-value' }) as Record<string, unknown>;

    expect(line[field]).toBe('[redacted]');
  });

  it('given a nested object, when logged, then sensitive fields inside it are removed too', () => {
    /* The realistic case is a whole request body or config object being spread into
       a log call, where the sensitive field is two levels down. */
    const line = JSON.stringify(
      redact({ request: { user: { id: 4, password: 'hunter2' } }, ok: true }),
    );

    expect(line).not.toContain('hunter2');
    expect(line).toContain('"id":4');
  });

  it('given ordinary fields, when logged, then they are kept', () => {
    expect(redact({ userId: 12, role: 'HR_ADMIN', count: 0, missing: null })).toEqual({
      userId: 12,
      role: 'HR_ADMIN',
      count: 0,
      missing: null,
    });
  });

  it('given an error, when logged, then its name and message are kept and nothing else', () => {
    const error = new Error('connection refused');

    expect(redact({ cause: error })).toEqual({
      cause: { name: 'Error', message: 'connection refused' },
    });
  });

  it('given an object that refers to itself, when logged, then it does not recurse forever', () => {
    /* A caught error can hold a `cause` chain that loops. Logging must not be able
       to take the process down. */
    const looping: Record<string, unknown> = { name: 'outer' };
    looping['self'] = looping;

    expect(() => JSON.stringify(redact(looping))).not.toThrow();
    expect(JSON.stringify(redact(looping))).toContain('[circular]');
  });

  it('given a structure deeper than the limit, when logged, then it is truncated rather than walked', () => {
    const deep = { a: { b: { c: { d: { e: 'too far' } } } } };

    expect(JSON.stringify(redact(deep))).not.toContain('too far');
  });

  it('given an array of values, when logged, then each is redacted in place', () => {
    expect(redact([{ password: 'a' }, { userId: 1 }])).toEqual([
      { password: '[redacted]' },
      { userId: 1 },
    ]);
  });
});

describe('maskEmail', () => {
  it('given an address, when masked, then the domain survives and the name does not', () => {
    // Enough to recognise an account in a support conversation, not a log of addresses.
    expect(maskEmail('ada.lovelace@acme.test')).toBe('a***@acme.test');
  });

  it.each(['', 'not-an-address', '@no-name.test'])(
    'given %s, when masked, then nothing is emitted',
    (value) => {
      expect(maskEmail(value)).toBe('[redacted]');
    },
  );
});

describe('logger', () => {
  it('given an event, when logged, then it is one line of JSON with a level and a time', () => {
    const written = jest.spyOn(console, 'log').mockImplementation(() => undefined);

    logger.info('auth.login.succeeded', { userId: 7 });

    const line = JSON.parse(String(written.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(line).toMatchObject({ level: 'info', event: 'auth.login.succeeded', userId: 7 });
    expect(typeof line['time']).toBe('string');
  });

  it('given a warning and an error, when logged, then each goes to its own stream', () => {
    const warned = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const errored = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    logger.warn('auth.login.rejected');
    logger.error('request.failed');

    expect(warned).toHaveBeenCalledTimes(1);
    expect(errored).toHaveBeenCalledTimes(1);
  });

  it('given a field the logger considers sensitive, when logged, then it never reaches the output', () => {
    const written = jest.spyOn(console, 'log').mockImplementation(() => undefined);

    logger.info('auth.login.succeeded', { password: 'hunter2', accessToken: 'aaa.bbb.ccc' });

    const line = String(written.mock.calls[0]?.[0]);
    expect(line).not.toContain('hunter2');
    expect(line).not.toContain('aaa.bbb.ccc');
  });
});
