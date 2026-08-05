import { createContainer } from '../src/container';
import { createTestDatabaseHandle } from './helpers/testDb';

const CONFIG = {
  databaseUrl: 'postgresql://nowhere-in-particular',
  jwtSecret: 'test-secret-that-is-long-enough-32',
  accessTokenTtlMinutes: 15,
  refreshTokenTtlDays: 7,
  syntheticData: true,
};

/**
 * The composition root. Small, but it is the thing that guarantees one connection
 * pool and one instance of each service — and the reason a test can run the real
 * application over an in-process database.
 */
describe('createContainer', () => {
  it('given a database handle, when a container is built, then no connection of its own is opened', async () => {
    /* The databaseUrl above points nowhere. If the container ignored the handle and
       opened a pool, this test would be talking to a host that does not exist. */
    const database = await createTestDatabaseHandle();

    const container = createContainer(CONFIG, { database });

    expect(container.db).toBe(database.db);
    await container.close();
  });

  it('given a container, when it is closed, then the database it was given is released', async () => {
    const database = await createTestDatabaseHandle();
    const close = jest.fn(database.close);

    const container = createContainer(CONFIG, { database: { db: database.db, close } });
    await container.close();

    expect(close).toHaveBeenCalledTimes(1);
  });

  it('given two containers, when each is built, then they hold separate services', async () => {
    /* Separate instances per call, rather than one module-level singleton. It is
       what stops two test files sharing state, and what makes the single instance in
       server.ts a deliberate decision rather than an accident of import order. */
    const first = await createTestDatabaseHandle();
    const second = await createTestDatabaseHandle();

    const one = createContainer(CONFIG, { database: first });
    const other = createContainer(CONFIG, { database: second });

    expect(one.auth).not.toBe(other.auth);
    expect(one.db).not.toBe(other.db);

    await Promise.all([one.close(), other.close()]);
  });

  it('given an injected clock, when the container is built, then the services use it', async () => {
    /* Proves the clock reaches the service. A refresh token issued under a clock
       fixed in 2026 must expire relative to that, not to the real date. */
    const database = await createTestDatabaseHandle();
    const fixed = new Date('2026-08-04T09:00:00.000Z');
    const now = jest.fn(() => fixed);

    const container = createContainer(CONFIG, { database, now });
    await container.auth.logout('a-token-that-does-not-exist');

    expect(now).toHaveBeenCalled();
    await container.close();
  });
});
