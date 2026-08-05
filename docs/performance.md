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

## Endpoints, measured end to end

Round trips from `curl` against the running API on the same machine, so these include HTTP, JSON and
process time — not just the query.

| Request                                           | Time   |
| ------------------------------------------------- | ------ |
| `GET /api/lookups`, cached                        | 0.9 ms |
| `GET /api/employees` as an Employee (1 person)    | 2 ms   |
| `GET /api/employees` as a Manager (84 people)     | 5 ms   |
| `GET /api/employees` filtered to one department   | 11 ms  |
| `GET /api/lookups`, cold                          | 11 ms  |
| `GET /api/employees` as of a past date            | 41 ms  |
| `GET /api/employees` sorted by converted salary   | 51 ms  |
| `GET /api/employees` page 400 of 400              | 54 ms  |
| `POST /api/auth/login` (argon2id, or its decoy)   | 28 ms  |
| `GET /api/employees/:id` with full pay history    | 7 ms   |
| `GET /api/employees/:id` as of a past date        | 5 ms   |
| `GET /api/stats/overview`, one department         | 25 ms  |
| `GET /api/stats/overview` as of a past date       | 54 ms  |
| `GET /api/stats/overview`, everyone incl. leavers | 59 ms  |
| `GET /api/stats/overview`, whole company          | 64 ms  |

Walking all 400 pages returned 10,000 people, 10,000 of them distinct: nobody repeated, nobody missed.

**Why a page of 25 costs 50 ms over 10,000 rows.** `EXPLAIN ANALYZE` puts execution at 47 ms, and the
shape is unavoidable rather than accidental: both the sort and the `COUNT(*) OVER ()` need everybody's
current salary before either can produce the first row, so the lateral lookup runs 10,000 times — twice
per person against `compensation_employee_effective_idx`. The exchange-rate join is free, memoised to six
lookups for 10,000 rows. Paging cannot avoid this while the answer includes a total and a sort on a
computed column.

The cheap scoped queries above make the same point from the other side: a Manager's page costs 5 ms
because the scope is a condition inside the query, so the work is proportional to what they may see.

**The whole dashboard is one query, and that is why it costs 64 ms.** Nine separate figures — headcount,
payroll, mean, median, both quartiles, three group breakdowns and a ten-bucket histogram — come back in a
single row of JSON. Written as five queries it would be five scans and five copies of the filters to keep
in step; written as one, the `pay` CTE is materialised once and every aggregate reads it. The 64 ms is
almost entirely that one pass resolving 9,769 current salaries.

Every part of it reconciles, which is the check worth having: the department, country and level totals
each sum _exactly_ to the company total, and the histogram counts sum to the paid headcount. Filtering to
one department costs 25 ms, so the cost really is proportional to the rows scanned rather than fixed.

**A correction worth recording:** an earlier draft of the design notes claimed every statistic runs "in
under 20 ms". Measured, three of the six are between 20 and 30 ms. The conclusion is unchanged — none of
these is close to needing a cache — but the number was asserted before it was measured, and the measured
range is 2–30 ms.

## The four newest queries

**Needs attention costs the same for 25 rows as for 100 (22 ms and 20 ms), and less than the plain list.**
Both numbers are dominated by the same lateral lookup over 10,000 people, and the page size is noise
against it. It is _cheaper_ than the equivalent page of the employee list because the band predicate
throws most rows away before the sort: about 700 people are below their band, so the ordering and the two
window aggregates run over 700 rows rather than 10,000.

**The pay gap is 40 ms for one pass and three groupings.** One statement: a materialised `comparable` CTE,
`percentile_cont` per (country, level, gender), a per-cell currency count, and the whole thing assembled
into one row of JSON. The cost is the current-salary lookup again, not the percentiles.

**A bulk-raise preview over the whole company is 48 ms** and returns 9,700-odd rows to Node, where the
arithmetic happens. That is deliberate: the rounding rule is a pure function the preview and the apply
share, and expressing it in SQL as well would be a second copy of the one thing that must not drift. At
this size the round trip costs more than the arithmetic and neither is close to mattering.

**The export is 505 ms for 10,000 rows and 1.41 MB**, read in chunks of a thousand so the process holds a
thousand rows rather than the company. That is ten queries of the same shape as a page of the list, and
the arithmetic checks out: 505 ms over ten chunks is about 50 ms each, which is what a page of the list
costs. Streaming is the point — the figure that matters is not the total but that memory does not grow
with headcount.

## The trend is the slowest thing here, and why

Every other figure is a question about one moment: the salary in force on a date, for the people who
match a filter. The trend asks the same question nineteen times over, and the naive shape of it — a
lateral "salary in force" lookup per employee per month — is 190,000 index lookups.

It is one pass instead. `lead()` over each person's own records gives every salary the window it applies
to, and a month matches the one window containing it. That is a single scan of 23,000 compensation rows
however many months are asked for, which is why the 61-month version is only twice the 19-month one
rather than three times.

89 ms is still the slowest endpoint in the product, and it is the one most worth caching if it becomes a
problem — it changes only when a pay record is written, unlike the overview, which changes with every
filter. It is not cached yet for the reason nothing else is: at this size, correctness the moment after a
raise is worth more than 89 ms.

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

**Where this would change.** If resolving current pay ever dominates — a much larger company, or many
concurrent dashboard users — the next step is a materialised view of current pay, refreshed when a salary
record is inserted. That is a real trade-off (a second source of truth) and is not worth taking on at this
size. The 50 ms list query is the first place it would pay off, and the number to beat is recorded above
so the claim can be checked rather than argued.

**At 100,000 people**, since "not yet" is only an answer if the next step is known. The cost above is
proportional to the number of employees, because it is dominated by resolving current pay for every one of
them — so ten times the company is roughly ten times the query, and the dashboard lands near a second. The
answer at that size is the projection described above rather than a cache: one `current_compensation` row per
employee, written in the same transaction as the pay record, which turns the lateral into an index scan and
cannot go stale after a raise the way a cached figure can. The append-only table stays the source of truth
underneath it. Worth being explicit that this is a schema change, not a tuning exercise, and that the trigger
for it is a measurement rather than a hunch.

**A correction the numbers here do not show.** The histogram's boundary labels were computed with `bigint`
division, which truncates: with ten buckets a printed boundary could sit up to nine cents below the boundary
`width_bucket` had actually counted against, so a salary exactly on the line appeared in a bar whose stated
range excluded it. Now divided as `numeric` and rounded. No measurable cost — it is ten rows of arithmetic —
but it is the kind of error that survives every performance check because nothing about it is slow.

## Reproducing

```bash
npm run seed        # prints its own timing
npm run verify:pg   # driver-level checks against real Postgres
```

The query timings were taken with `psql \timing on`. They are not part of the test suite: a timing
assertion on a shared machine fails for reasons that have nothing to do with the code.
