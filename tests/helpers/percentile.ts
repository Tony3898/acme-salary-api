/**
 * A reference implementation of `percentile_cont`, written to check the SQL.
 *
 * Deliberately in the test helpers rather than in `src`: nothing in the
 * application computes a percentile in JavaScript, and adding a copy there so
 * the tests have something to call would create the second implementation this
 * is meant to catch. It exists to disagree with Postgres if either of us is
 * wrong.
 *
 * The definition, from the SQL standard: sort the values, take the position
 * `p * (n - 1)`, and interpolate linearly between the two values it falls
 * between. It is not "the middle value" — for an even count it is the mean of
 * the two middle ones, which is what makes it worth checking rather than
 * assuming.
 */
export function percentileCont(values: readonly number[], fraction: number): number | null {
  if (values.length === 0) {
    // An empty group has no median. Zero would be a salary; null is the truth.
    return null;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const position = fraction * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);

  const low = sorted[lower];
  const high = sorted[upper];
  if (low === undefined || high === undefined) {
    throw new Error('Percentile position fell outside the sorted values.');
  }

  if (lower === upper) {
    return low;
  }
  return low + (high - low) * (position - lower);
}

/** The same rounding Postgres applies when the result is cast to bigint. */
export function percentileCents(values: readonly number[], fraction: number): number | null {
  const exact = percentileCont(values, fraction);
  return exact === null ? null : Math.round(exact);
}
