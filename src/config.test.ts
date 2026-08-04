import { parseConfig } from './config';

describe('parseConfig', () => {
  it('given a complete environment, when parsed, then values become their real types', () => {
    const config = parseConfig({
      NODE_ENV: 'production',
      PORT: '8080',
      DATABASE_URL: 'postgresql://user:secret@db:5432/acme',
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
        SEED_DEMO_PASSWORD: 'cnry',
        PORT: 'not-a-port',
      });

    expect(parse).toThrow(/PORT/);
    expect(parse).toThrow(/SEED_DEMO_PASSWORD/);
    expect(parse).not.toThrow(/cnry/);
  });

  it('given only the required values, when parsed, then defaults apply', () => {
    const config = parseConfig({ DATABASE_URL: 'postgresql://localhost:5432/acme' });

    expect(config.NODE_ENV).toBe('development');
    expect(config.PORT).toBe(3000);
    expect(config.isProduction).toBe(false);
  });

  it('given a short demo password, when parsed, then it is rejected', () => {
    expect(() =>
      parseConfig({ DATABASE_URL: 'postgresql://localhost:5432/acme', SEED_DEMO_PASSWORD: 'x' }),
    ).toThrow(/SEED_DEMO_PASSWORD/);
  });

  it('given a returned config, when a value is reassigned, then it does not change', () => {
    // Frozen so no module can quietly repoint the database mid-process.
    const config = parseConfig({ DATABASE_URL: 'postgresql://localhost:5432/acme' });

    expect(() => {
      (config as { PORT: number }).PORT = 9999;
    }).toThrow();
  });
});
