# Performance

Measured, not estimated. Everything below was run against PostgreSQL 15.16 on a local machine (Apple
silicon) with the full seeded dataset: **10,000 employees, 9,772 of them active, and 23,049 salary
records** — 14.4 MB of database in total.

Every query figure comes from `npm run bench`, which is in the repository. That matters more than the
numbers: an earlier version of this page was typed out of a `psql \timing` session, so when the seed
changed the row counts moved and nobody noticed. The script drives **the same query builders the API
calls**, not hand-written copies of them that can drift.

## Seeding

| Step                                | Time    |
| ----------------------------------- | ------- |
| Generating the company in memory    | ~150 ms |
| Inserting 33,000 rows and reseeding | ~1.5 s  |
| **Total `npm run seed`**            | ~2.3 s  |

Rows are inserted in batches of 500. Generation is not the cost — the inserts are — so there is nothing
to optimise on the JavaScript side.

## Queries

Median of seven runs, first discarded. `npm run bench` reprints this table.

| Query                                               | Time    |
| --------------------------------------------------- | ------- |
| Employee list, scoped to one Employee               | 0.9 ms  |
| Employee list, scoped to a Manager                  | 4.1 ms  |
| Employee list, searched by name                     | 5.8 ms  |
| Dashboard, filtered to one department               | 11.2 ms |
| Band coverage across every level and country        | 14.7 ms |
| Needs attention, everyone below their band          | 16.3 ms |
| Dashboard, as of a past date                        | 27.8 ms |
| Employee list, as of a past date                    | 29.1 ms |
| Employee list, sorted by converted salary           | 30.3 ms |
| Dashboard: nine figures in one query, whole company | 30.8 ms |
| Employee list, page 1 of 400 sorted by name         | 31.2 ms |
| Employee list, page 400 of 400                      | 31.3 ms |
| Pay gap within level and country                    | 37.8 ms |
| Bulk raise candidates, whole company                | 45.8 ms |
| Payroll trend, 12 months back and 6 forward         | 86.5 ms |

**The interesting number is the first one, not the last.** A page of 25 costs 31 ms whether it is page 1
or page 400, and 0.9 ms for an Employee who may see one record. The scope is a condition _inside_ the
query, so the work is proportional to what the person is allowed to see rather than to the size of the
company. Sorting by salary is not measurably worse than sorting by name; the cost is not the sort.

## Endpoints, measured end to end

Round trips from `curl` against the running API on the same machine — median of seven, so these include
HTTP, JSON and process time, not just the query.

| Request                                           | Time   |
| ------------------------------------------------- | ------ |
| `GET /api/lookups`, cached                        | 1 ms   |
| `GET /api/employees/:id` as of a past date        | 2 ms   |
| `GET /api/employees/:id` with full pay history    | 3 ms   |
| `GET /api/employees` as an Employee (1 person)    | 4 ms   |
| `GET /api/stats/overview`, one department         | 12 ms  |
| `GET /api/employees` as a Manager                 | 13 ms  |
| `GET /api/employees` filtered to one department   | 13 ms  |
| `GET /api/lookups`, cold                          | 14 ms  |
| `GET /api/bands`                                  | 15 ms  |
| `GET /api/employees/attention`                    | 20 ms  |
| `GET /api/stats/overview` as of a past date       | 29 ms  |
| `GET /api/employees` sorted by converted salary   | 31 ms  |
| `GET /api/employees` page 400 of 400              | 32 ms  |
| `GET /api/employees` as of a past date            | 32 ms  |
| `GET /api/stats/overview`, whole company          | 32 ms  |
| `GET /api/stats/pay-gap`                          | 39 ms  |
| `GET /api/stats/payroll-trend`                    | 93 ms  |
| `GET /api/employees/export`, 10,000 rows, 1.41 MB | 523 ms |

Walking all 400 pages returned 10,000 people, 10,000 of them distinct: nobody repeated, nobody missed.
That is a test, not a one-off — see the paging suite.

**HTTP costs about a millisecond.** Every endpoint above lands within 1–2 ms of the query underneath it,
which is the useful negative result: there is no serialisation problem to go looking for, and the
dashboard's 32 ms is 32 ms of Postgres.

**Why a page of 25 costs 31 ms over 10,000 rows.** Both the sort and the `COUNT(*) OVER ()` need
everybody's current salary before either can produce the first row, so the lateral lookup runs 10,000
times — twice per person against `compensation_employee_effective_idx`. The exchange-rate join is free,
memoised to six lookups for 10,000 rows. Paging cannot avoid this while the answer includes a total and a
sort on a computed column.

**The whole dashboard is one query, and that is why it costs 32 ms.** Nine separate figures — headcount,
payroll, mean, median, both quartiles, three group breakdowns and a ten-bucket histogram — come back in a
single row of JSON. Written as five queries it would be five scans and five copies of the filters to keep
in step; written as one, the `pay` CTE is materialised once and every aggregate reads it. The 32 ms is
almost entirely that one pass resolving 9,772 current salaries.

Every part of it reconciles, which is the check worth having: the department, country and level totals
each sum _exactly_ to the company total, and the histogram counts sum to the paid headcount. Filtering to
one department costs 12 ms, so the cost really is proportional to the rows scanned rather than fixed.

**A correction worth recording:** an earlier draft of the design notes claimed every statistic runs "in
under 20 ms". Measured, most of them are between 20 and 40 ms, and the trend is 87 ms. The conclusion is
unchanged — none of these is close to needing a cache — but the number was asserted before it was
measured.

## Login is deliberately the slowest thing per unit of work

| Request                                       | Time    |
| --------------------------------------------- | ------- |
| `POST /api/auth/login`, correct password      | ~17 ms  |
| `POST /api/auth/login`, wrong password        | 16.7 ms |
| `POST /api/auth/login`, email with no account | 16.6 ms |

Argon2id is meant to cost something; 17 ms is the point of it. The row that matters is the third one:
**an unknown email costs the same as a known one**, because the service verifies against a decoy hash
rather than returning early. Without that, the 20× difference between "no such user" and "wrong password"
would turn the login form into a way to enumerate who has an account.

That is easy to break by accident and cheap to check, so it is measured here rather than asserted. Note
that measuring it needs a restarted server: the rate limiter allows ten attempts per fifteen minutes, and
a 429 answers in under a millisecond, which silently reads as a much faster login.

## The four newest queries

**Needs attention costs the same for 25 rows as for 100 (20 ms and 19 ms), and less than the plain list.**
Both numbers are dominated by the same lateral lookup over 10,000 people, and the page size is noise
against it. It is _cheaper_ than the equivalent page of the employee list because the band predicate
throws most rows away before the sort: 692 people are below their band, so the ordering and the two
window aggregates run over 692 rows rather than 10,000.

**The pay gap is 38 ms for one pass and three groupings.** One statement: a materialised `comparable` CTE,
`percentile_cont` per (country, level, gender), a per-cell currency count, and the whole thing assembled
into one row of JSON. The cost is the current-salary lookup again, not the percentiles.

**A bulk-raise preview over the whole company is 46 ms** and returns 9,700-odd rows to Node, where the
arithmetic happens. That is deliberate: the rounding rule is a pure function the preview and the apply
share, and expressing it in SQL as well would be a second copy of the one thing that must not drift. At
this size the round trip costs more than the arithmetic and neither is close to mattering.

**The export is 523 ms for 10,000 rows and 1.41 MB**, read in chunks of a thousand so the process holds a
thousand rows rather than the company. That is ten queries of the same shape as a page of the list, and
the arithmetic checks out: 523 ms over ten chunks is about 52 ms each, which is a page of the list plus
the CSV formatting. Streaming is the point — the figure that matters is not the total but that memory does
not grow with headcount.

## The trend is the slowest thing here, and why

Every other figure is a question about one moment: the salary in force on a date, for the people who
match a filter. The trend asks the same question nineteen times over, and the naive shape of it — a
lateral "salary in force" lookup per employee per month — is 190,000 index lookups.

It is one pass instead. `lead()` over each person's own records gives every salary the window it applies
to, and a month matches the one window containing it. That is a single scan of 23,000 compensation rows
however many months are asked for, which is why the 61-month version (172 ms) is only twice the 19-month
one rather than three times.

87 ms is still the slowest endpoint in the product, and it is the one most worth caching if it becomes a
problem — it changes only when a pay record is written, unlike the overview, which changes with every
filter. It is not cached yet for the reason nothing else is: at this size, correctness the moment after a
raise is worth more than 87 ms.

## What the numbers say

**The database is not the constraint.** The dominant cost in every query above is the pass that resolves
each person's current salary from their history — around 10,000 rows out of 23,049, which Postgres
handles in tens of milliseconds using `compensation_records(employee_id, effective_from DESC)`.

**So the payload to the browser is the thing to control**, which is why the API pages results, aggregates
in SQL, and returns a handful of numbers for the dashboard rather than 10,000 rows for the client to
total up.

**Nothing here justifies a cache yet.** A 32 ms query behind a single HR team is not a bottleneck, and
caching it would risk a dashboard showing stale figures immediately after a raise. Only the small lookup
data — departments, levels, bands, rates, about 10 KB — is cached, in process, and it earns its keep
plainly: 14 ms cold, 1 ms warm, on data that changes a few times a year. See
[design-notes.md](design-notes.md#caching-lookup-data-only).

**Where this would change.** If resolving current pay ever dominates — a much larger company, or many
concurrent dashboard users — the next step is a materialised view of current pay, refreshed when a salary
record is inserted. That is a real trade-off (a second source of truth) and is not worth taking on at this
size. The 31 ms list query is the first place it would pay off, and the number to beat is recorded above
so the claim can be checked rather than argued.

**At 100,000 people**, since "not yet" is only an answer if the next step is known. The cost above is
proportional to the number of employees, because it is dominated by resolving current pay for every one of
them — so ten times the company is roughly ten times the query, and the dashboard lands near a third of a
second while the trend lands near a second. The answer at that size is the projection described above rather
than a cache: one `current_compensation` row per employee, written in the same transaction as the pay record,
which turns the lateral into an index scan and cannot go stale after a raise the way a cached figure can. The
append-only table stays the source of truth underneath it. Worth being explicit that this is a schema change,
not a tuning exercise, and that the trigger for it is a measurement rather than a hunch.

**A correction the numbers here do not show.** The histogram's boundary labels were computed with `bigint`
division, which truncates: with ten buckets a printed boundary could sit up to nine cents below the boundary
`width_bucket` had actually counted against, so a salary exactly on the line appeared in a bar whose stated
range excluded it. Now divided as `numeric` and rounded. No measurable cost — it is ten rows of arithmetic —
but it is the kind of error that survives every performance check because nothing about it is slow.

## Reproducing

```bash
npm run seed        # prints its own timing
npm run bench       # the query table above
npm run verify:pg   # driver-level checks against real Postgres
```

The endpoint and login tables were taken with `curl` against `npm run dev`, median of seven. None of these
figures is asserted in the test suite: a timing assertion on a shared machine fails for reasons that have
nothing to do with the code.
