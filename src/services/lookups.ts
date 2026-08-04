import { createCachedValue, type CachedValue } from '../cache';
import type { Database } from '../db/database';
import { loadLookupData, type LookupData } from '../repositories/lookups';

/**
 * Reference data, held in memory. See src/cache.ts for why this is the only
 * thing cached and where that stops being true.
 */

/**
 * Long enough that the dropdowns cost nothing to render, short enough that a
 * department renamed by hand in the database appears within the hour without
 * anybody restarting anything. Writes through the app invalidate immediately, so
 * this only governs changes made behind its back.
 */
const LOOKUP_TTL_MS = 60 * 60 * 1000;

export interface LookupServiceDeps {
  db: Database;
  /** Milliseconds, injected so expiry is testable. */
  now: () => number;
  ttlMs?: number;
}

export interface LookupService {
  get: () => Promise<LookupData>;
  /** Called after anything that changes reference data. */
  invalidate: () => void;
}

export function createLookupService(deps: LookupServiceDeps): LookupService {
  const cached: CachedValue<LookupData> = createCachedValue({
    load: () => loadLookupData(deps.db),
    ttlMs: deps.ttlMs ?? LOOKUP_TTL_MS,
    now: deps.now,
  });

  return { get: cached.get, invalidate: cached.invalidate };
}
