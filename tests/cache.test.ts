import { createCachedValue } from '../src/shared/cache';

const TTL_MS = 60_000;

describe('createCachedValue', () => {
  /** A clock the test moves, so expiry is exercised without waiting for it. */
  function clockAt(start = 0) {
    let current = start;
    return { now: () => current, advance: (ms: number) => (current += ms) };
  }

  it('given a first read, when it happens, then the value is loaded', async () => {
    const load = jest.fn().mockResolvedValue({ departments: 3 });
    const cache = createCachedValue({ load, ttlMs: TTL_MS, now: clockAt().now });

    await expect(cache.get()).resolves.toEqual({ departments: 3 });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('given a second read inside the window, when it happens, then the database is not asked again', async () => {
    const clock = clockAt();
    const load = jest.fn().mockResolvedValue('value');
    const cache = createCachedValue({ load, ttlMs: TTL_MS, now: clock.now });

    await cache.get();
    clock.advance(TTL_MS - 1);
    await cache.get();

    expect(load).toHaveBeenCalledTimes(1);
  });

  it('given the window has passed, when read again, then it is reloaded', async () => {
    const clock = clockAt();
    const load = jest.fn().mockResolvedValueOnce('first').mockResolvedValueOnce('second');
    const cache = createCachedValue({ load, ttlMs: TTL_MS, now: clock.now });

    await expect(cache.get()).resolves.toBe('first');
    clock.advance(TTL_MS);
    await expect(cache.get()).resolves.toBe('second');
  });

  it('given the data has changed, when the cache is invalidated, then the next read sees the change', async () => {
    /* What makes a write visible immediately rather than within the hour. Anything
       that edits reference data has to call this. */
    const load = jest.fn().mockResolvedValueOnce('before').mockResolvedValueOnce('after');
    const cache = createCachedValue({ load, ttlMs: TTL_MS, now: clockAt().now });

    await cache.get();
    cache.invalidate();

    await expect(cache.get()).resolves.toBe('after');
  });

  it('given many readers at once on a cold cache, when they all read, then the database is asked once', async () => {
    /* Every request arriving in the first moments of a deployment would otherwise
       run its own copy of the query — the cache making the worst moment worse. */
    let release: (value: string) => void = () => undefined;
    const load = jest.fn(
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    );
    const cache = createCachedValue({ load, ttlMs: TTL_MS, now: clockAt().now });

    const readers = Promise.all([cache.get(), cache.get(), cache.get()]);
    release('value');

    await expect(readers).resolves.toEqual(['value', 'value', 'value']);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('given the load fails, when it is read again, then it is retried rather than failing forever', async () => {
    /* A rejected promise left in the cache would keep being handed out, so one
       failed query at startup would break the endpoint for the life of the
       process. */
    const load = jest
      .fn()
      .mockRejectedValueOnce(new Error('connection refused'))
      .mockResolvedValueOnce('recovered');
    const cache = createCachedValue({ load, ttlMs: TTL_MS, now: clockAt().now });

    await expect(cache.get()).rejects.toThrow('connection refused');
    await expect(cache.get()).resolves.toBe('recovered');
  });

  it('given the load fails, when it fails, then nothing is left behind to serve', async () => {
    const load = jest.fn().mockRejectedValue(new Error('still down'));
    const cache = createCachedValue({ load, ttlMs: TTL_MS, now: clockAt().now });

    await expect(cache.get()).rejects.toThrow();
    await expect(cache.get()).rejects.toThrow();
    expect(load).toHaveBeenCalledTimes(2);
  });
});
