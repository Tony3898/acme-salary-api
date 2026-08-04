# Performance

Measured, not estimated. Everything below was run against PostgreSQL 15.16 on a local machine with the
full seeded dataset: **10,000 employees and 23,271 salary records**.

## Seeding

| Step                                | Time    |
| ----------------------------------- | ------- |
| Generating the company in memory    | ~150 ms |
| Inserting 33,000 rows and reseeding | ~2.1 s  |
| **Total `npm run seed`**            | ~2.3 s  |

Rows are inserted in batches of 500. Generation is not the cost — the inserts are — so there is nothing
to optimise on the JavaScript side.

## Queries

Each figure is a single run including planning time, via `psql \timing`.

| Query                                                     | Time    |
| --------------------------------------------------------- | ------- |
| Manager's reporting line (`WITH RECURSIVE`)               | 2.2 ms  |
| Median and quartiles over current pay                     | 18.5 ms |
| Salary distribution histogram (`width_bucket`)            | 19.4 ms |
| Pay gap within level and country, small groups suppressed | 20.5 ms |
| Employee list, page of 25 sorted by converted salary      | 25.6 ms |
| Payroll cost in USD by department                         | 28.8 ms |

**A correction worth recording:** an earlier draft of the design notes claimed every statistic runs "in
under 20 ms". Measured, three of the six are between 20 and 30 ms. The conclusion is unchanged — none of
these is close to needing a cache — but the number was asserted before it was measured, and the measured
range is 2–30 ms.

## What the numbers say

**The database is not the constraint.** The dominant cost in every query above is the `DISTINCT ON` pass
that resolves each person's current salary from their history — around 10,000 rows out of 23,271, which
Postgres handles in a few milliseconds using
`compensation_records(employee_id, effective_from DESC)`.

**So the payload to the browser is the thing to control**, which is why the API pages results, aggregates
in SQL, and returns a handful of numbers for the dashboard rather than 10,000 rows for the client to
total up.

**Nothing here justifies a cache yet.** A 25 ms query behind a single HR team is not a bottleneck, and
caching it would risk a dashboard showing stale figures immediately after a raise. Only the small lookup
data — departments, levels, bands, rates, about 10 KB — is cached, in process. See
[design-notes.md](design-notes.md#caching-lookup-data-only).

**Where this would change.** If the `DISTINCT ON` pass ever dominates — a much larger company, or many
concurrent dashboard users — the next step is a materialised view of current pay, refreshed when a salary
record is inserted. That is a real trade-off (a second source of truth) and is not worth taking on at this
size.

## Reproducing

```bash
npm run seed        # prints its own timing
npm run verify:pg   # driver-level checks against real Postgres
```

The query timings were taken with `psql \timing on`. They are not part of the test suite: a timing
assertion on a shared machine fails for reasons that have nothing to do with the code.
