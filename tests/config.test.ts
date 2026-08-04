import { parseConfig } from '../src/config';

/** Long enough to satisfy the minimum. Not a real secret. */
const A_VALID_SECRET = 'x'.repeat(32);

describe('parseConfig', () => {
  it('given a complete environment, when parsed, then values become their real types', () => {
    const config = parseConfig({
      NODE_ENV: 'production',
      PORT: '8080',
      DATABASE_URL: 'postgresql://db:5432/acme',
      JWT_SECRET: A_VALID_SECRET,
      CORS_ORIGIN: 'https://acme.example, https://admin.acme.example',
    });

    expect(config.PORT).toBe(8080);
    expect(config.isProduction).toBe(true);
    // Origins become a trimmed list, because CORS with credentials needs exact matches.
    expect(config.CORS_ORIGIN).toEqual(['https://acme.example', 'https://admin.acme.example']);
  });

  it('given a missing DATABASE_URL, when parsed, then it fails naming the variable', () => {
    /* Failing at startup is the point: an unset variable must not surface as
       undefined inside a request months later. */
    expect(() => parseConfig({})).toThrow(/DATABASE_URL/);
  });

  it('given an invalid value, when parsed, then the error names the variable but never its value', () => {
    /* This message reaches a log, and these variables carry credentials — the
       database URL embeds a password. `cnry` is a canary: too short to be valid,
       and distinctive enough that its absence from the message is meaningful. */
    const parse = () =>
      parseConfig({
        DATABASE_URL: 'postgresql://localhost:5432/acme',
        JWT_SECRET: A_VALID_SECRET,
        SEED_DEMO_PASSWORD: 'cnry',
        PORT: 'not-a-port',
      });

    expect(parse).toThrow(/PORT/);
    expect(parse).toThrow(/SEED_DEMO_PASSWORD/);
    expect(parse).not.toThrow(/cnry/);
  });

  it('given only the required values, when parsed, then defaults apply', () => {
    const config = parseConfig({ DATABASE_URL: 'postgresql://localhost:5432/acme', JWT_SECRET: A_VALID_SECRET });

    expect(config.NODE_ENV).toBe('development');
    expect(config.PORT).toBe(3000);
    expect(config.isProduction).toBe(false);
  });

  it('given no JWT secret, when parsed, then it is rejected rather than defaulted', () => {
    /* A default signing secret would let anybody mint a valid token for a
       deployment whose operator forgot to set one. */
    expect(() => parseConfig({ DATABASE_URL: 'postgresql://localhost:5432/acme' })).toThrow(
      /JWT_SECRET/,
    );
  });

  it('given a short JWT secret, when parsed, then it is rejected', () => {
    expect(() =>
      parseConfig({ DATABASE_URL: 'postgresql://localhost:5432/acme', JWT_SECRET: 'too-short' }),
    ).toThrow(/JWT_SECRET/);
  });

  it('given a short demo password, when parsed, then it is rejected', () => {
    expect(() =>
      parseConfig({
        DATABASE_URL: 'postgresql://localhost:5432/acme',
        JWT_SECRET: A_VALID_SECRET,
        SEED_DEMO_PASSWORD: 'x',
      }),
    ).toThrow(/SEED_DEMO_PASSWORD/);
  });

  it('given a returned config, when a value is reassigned, then it does not change', () => {
    // Frozen so no module can quietly repoint the database mid-process.
    const config = parseConfig({ DATABASE_URL: 'postgresql://localhost:5432/acme', JWT_SECRET: A_VALID_SECRET });

    expect(() => {
      (config as { PORT: number }).PORT = 9999;
    }).toThrow();
  });
});
