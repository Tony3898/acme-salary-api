import { PGlite } from '@electric-sql/pglite';

/**
 * Tests run against PGlite — real Postgres compiled to WebAssembly, in-process.
 * The statistics in this app lean on Postgres-specific features, so this file
 * proves the test database actually supports them before anything is built on
 * top. If it ever fails, the fallback is Postgres in Docker for tests too.
 */
describe('test database', () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      CREATE TABLE comp (
        id             serial PRIMARY KEY,
        employee_id    integer NOT NULL,
        amount_minor   bigint  NOT NULL,
        effective_from date    NOT NULL
      );
      INSERT INTO comp (employee_id, amount_minor, effective_from) VALUES
        (1, 7500000, '2022-01-01'),
        (1, 8200000, '2023-04-01'),
        (1, 9000000, '2030-01-01'),
        (2, 6000000, '2022-01-01'),
        (3, 12000000, '2022-01-01');
    `);
  });

  afterAll(async () => {
    await db.close();
  });

  it('given a set of salaries, when asked for the median, then percentile_cont returns it', async () => {
    const result = await db.query<{ median: number }>(
      `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY amount_minor) AS median FROM comp`,
    );

    expect(result.rows[0]?.median).toBe(8_200_000);
  });

  it('given salaries across ranges, when bucketed, then width_bucket groups them', async () => {
    const result = await db.query<{ bucket: number; people: number }>(
      `SELECT width_bucket(amount_minor, 0, 15000000, 3) AS bucket, count(*) AS people
         FROM comp GROUP BY bucket ORDER BY bucket`,
    );

    // Buckets are 5,000,000 wide: 6.0M/7.5M/8.2M/9.0M land in the second, 12.0M in the third.
    expect(result.rows).toEqual([
      { bucket: 2, people: 4 },
      { bucket: 3, people: 1 },
    ]);
  });

  it('given salary history, when asked as of a date, then DISTINCT ON returns the latest started record', async () => {
    const result = await db.query<{ employee_id: number; amount_minor: number }>(
      `SELECT DISTINCT ON (employee_id) employee_id, amount_minor
         FROM comp
        WHERE effective_from <= $1
        ORDER BY employee_id, effective_from DESC, id DESC`,
      ['2026-08-04'],
    );

    // Employee 1's future record (2030) is correctly ignored.
    expect(result.rows).toEqual([
      { employee_id: 1, amount_minor: 8_200_000 },
      { employee_id: 2, amount_minor: 6_000_000 },
      { employee_id: 3, amount_minor: 12_000_000 },
    ]);
  });

  it('given a bigint column, when read, then it arrives as a JS number and not a string', async () => {
    const result = await db.query<{ amount_minor: number }>(
      `SELECT amount_minor FROM comp ORDER BY id LIMIT 1`,
    );

    /* node-postgres returns bigint and numeric as strings by default, PGlite as
       numbers — so without this, tests would pass on one shape and production
       would receive another. src/db/client.ts registers number parsers for both
       types so the two agree.

       Ceiling: JS numbers are exact to 2^53, which is ~$90 trillion in cents.
       Well beyond a payroll total, and asserted here so it stays deliberate. */
    expect(typeof result.rows[0]?.amount_minor).toBe('number');
    expect(Number.isSafeInteger(result.rows[0]?.amount_minor)).toBe(true);
  });

  it('given a filtered query with no matches, when counted with a window function, then no rows come back at all', async () => {
    const result = await db.query<{ total: number }>(
      `SELECT id, count(*) OVER () AS total FROM comp WHERE amount_minor > 99999999`,
    );

    // The reason `total` has to be defaulted to 0 rather than read from rows[0].
    expect(result.rows).toHaveLength(0);
  });

  it('given bigint amounts, when summed and cast back, then the total is an exact number', async () => {
    /* sum() over bigint widens to numeric, which arrives as a string. Every
       total in this app therefore casts back: sum(...)::bigint. Asserted both
       ways so the reason survives. */
    const result = await db.query<{ raw: string; cast: number }>(
      `SELECT sum(amount_minor) AS raw, sum(amount_minor)::bigint AS cast FROM comp`,
    );

    expect(result.rows[0]?.raw).toBe('42700000');
    expect(result.rows[0]?.cast).toBe(42_700_000);
  });
});
