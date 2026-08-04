/**
 * A single value, kept in memory for a while.
 *
 * This is the one place a shared instance is allowed to hold state, and only
 * because what it holds is the same for everybody: departments, job levels,
 * countries, exchange rates, pay bands. Around 10 KB that changes a few times a
 * year.
 *
 * Employee and salary data is deliberately not cached. The combinations of
 * filter, sort, page and date are effectively endless so little would ever be
 * reused — and with access scopes the same URL returns different data per user,
 * so caching a response risks serving one person's view to another.
 *
 * In process memory, not Redis. That is right for this app — one process, one
 * server, 10 KB — and wrong for most production ones, so the boundary is worth
 * being explicit about.
 *
 * What breaks first is not size, it is the second process. Two servers behind a
 * load balancer each hold their own copy: a rename invalidates one of them and
 * the other serves the old value until its TTL runs out, so the change appears
 * and disappears depending on which server answers. Nothing errors, which is what
 * makes it hard to diagnose.
 *
 * That is the point to move to Redis, and this module is the seam for it: the
 * `load`/`invalidate` pair is all a shared store has to provide, so nothing that
 * calls `get()` changes. The cost of moving is a service to operate, a network
 * hop on every miss, and a new failure mode — an unreachable cache — that the
 * current design cannot have.
 */

export interface CachedValueDeps<T> {
  /** Called on a miss. Its result is what gets held. */
  load: () => Promise<T>;
  ttlMs: number;
  /** Milliseconds. Injected so expiry can be tested without waiting for it. */
  now: () => number;
}

export interface CachedValue<T> {
  get: () => Promise<T>;
  /** Drops what is held, so the next read reloads. Called after a write. */
  invalidate: () => void;
}

export function createCachedValue<T>(deps: CachedValueDeps<T>): CachedValue<T> {
  let held: { value: T; expiresAt: number } | undefined;
  let inFlight: Promise<T> | undefined;

  return {
    get: async () => {
      const now = deps.now();
      if (held !== undefined && held.expiresAt > now) {
        return held.value;
      }

      /* One load, however many callers are waiting. On a cold start every request
         in the first moments would otherwise run its own copy of the query — the
         cache making things worse at exactly the wrong time. */
      inFlight ??= deps
        .load()
        .then((value) => {
          held = { value, expiresAt: deps.now() + deps.ttlMs };
          return value;
        })
        .finally(() => {
          /* Cleared whether it worked or not, so a failed load is retried rather
             than remembered. A rejected promise held here would keep failing for
             the rest of the process's life. */
          inFlight = undefined;
        });

      return inFlight;
    },

    invalidate: () => {
      held = undefined;
    },
  };
}
