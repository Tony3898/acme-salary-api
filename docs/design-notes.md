# Design notes and trade-offs

Decisions worth explaining, and what each one costs.

## Money is stored as whole minor units

`$85,000.50` is `8500050` cents in a `BIGINT`, with `USD` in a separate column. Floating-point decimals
cannot represent `0.1` exactly, so summing 10,000 salaries drifts. Integers are exact.

**Cost:** every amount has to be formatted on the way out and parsed on the way in, and the code can
never use `parseFloat` on a money value.

**Limit accepted:** the arithmetic assumes two decimal places. Yen has none and Kuwaiti Dinar has three,
so those currencies are out of scope rather than half-supported.

**The parser refuses separators, and this is not pedantry.** An earlier version stripped commas before
parsing, on the reasoning that spreadsheet exports contain `85,000.50`. Half of Europe writes `85000,50`
for eighty-five thousand — stripping the comma reads that as eight and a half million, a hundredfold
overpayment that passes every later check and lands in an append-only table. Since this app supports EUR,
that input is expected rather than hypothetical. A stricter grouping rule does not fix it either: western
formatting groups as `8,500,000` and Indian as `85,00,000`, so no single rule is correct everywhere.

So `domain/money` knows nothing about locales and accepts only a plain decimal string. Normalising is the
CSV importer's job, because it is the only part of the system that knows which file the numbers came from
and can ask. Guessing centrally has no safe answer.

**Zero is refused at the same boundary,** rather than being left to the database check. Nobody is paid
nothing, and matching the rule in both places means a zero arrives as a rejected input with a clear
message instead of a failed insert.

## Salary history instead of a salary column

Rather than an editable `salary` field, `compensation_records` holds every salary a person has ever had,
each with an `effective_from` date. Current salary is the most recent record that has already started:

```sql
SELECT DISTINCT ON (employee_id) employee_id, amount_minor, currency
FROM compensation_records
WHERE effective_from <= :as_of
ORDER BY employee_id, effective_from DESC, id DESC
```

The `id DESC` matters: two records starting the same day would otherwise resolve unpredictably.

**Cost:** the current salary is a join rather than a column, so every list query carries this CTE.

**Gained:** raise history, "what did payroll look like last January?", and an audit trail — none of which
needed extra work.

**Alternative rejected:** a `current_salary_minor` column kept in sync with the history. Faster to read,
but two sources of truth that will eventually disagree, and the disagreement is silent.

## Currency converted when read, not when written

One `fx_rates` snapshot, applied in the query.

**Cost:** a join and a multiplication on every list and every total.

**Why not store a USD amount alongside each salary:** a corrected rate would mean rewriting thousands of
rows, and the stored value would be a snapshot of a rate nobody recorded the source of.

**Product consequence, which matters more than the maintenance one:** converting salaries to USD to
compare people across countries is misleading, because pay is set locally. So the app never does it for
fairness questions. Cost questions convert to USD; fairness questions compare a person to their local
band in their own currency. Two separate screens, deliberately.

**Limit accepted:** historic payroll totals are shown at _current_ rates, and the UI says so. Rate
history is out of scope.

## Offset pagination, not cursor

`page` and `pageSize`, with a `total` from `COUNT(*) OVER ()` in the same query.

**Why:** the table needs a page count and "jump to page 40", which cursors cannot give. At 10,000 rows
the deep-offset cost that makes cursors necessary does not apply.

**When to change:** if the table ever holds millions of rows, or if the UI drops the page count.

Four traps, each with a test:

- **Sort always ends with `id ASC`.** With 300 people on the same salary, the database may return them in
  a different order per request — page 2 then repeats rows from page 1 and skips others. Nothing looks
  broken, which is what makes it dangerous.
- **Sorting is on the converted amount.** ₹2,000,000 is a larger number than $150,000 and a smaller
  salary.
- **An empty result must default `total` to 0.** The window function returns no rows at all when nothing
  matches, so there is nothing to read the count from.
- **The access filter is applied before counting.** Otherwise a Manager's footer discloses company
  headcount.

## Statistics in SQL, not in JavaScript

`percentile_cont` for median and quartiles, `width_bucket` for the distribution histogram, `FILTER` to
compare groups in one pass, `WITH RECURSIVE` for a manager's full reporting line.

**Why:** these are the queries the ORM does not help with, so they are written as raw `sql` inside
Drizzle. That is the intended end state, not something to tidy later.

**Detail that matters:** an empty group returns "no data", not `0`. A median of `$0` produced by a filter
that matched nobody is worse than showing nothing.

## Drizzle ORM, with raw SQL where it does not fit

**Gained:** typed columns — rename one and the compiler finds every use — and no repetitive row-mapping
code.

**Cost:** a dependency, a build step for the schema, and one real hazard: it is easy to write one query
per row. Fetching 100 employees and then each one's department is 101 queries where a join would do one.
The benchmark script exists partly to catch that.

**Migrations:** `drizzle-kit push` while building, since the schema changes often and all data comes from
the seed script. One migration is generated at first deploy, and real migrations apply from then on —
once there is data that cannot be regenerated. Note that adding _records_ is not a migration: CSV import,
seeding and bulk raises change no schema.

**Injection:** safety comes from parameterisation, not from the ORM. Two places need care and have tests
— the user-chosen sort column, which is a fixed map from `sortBy=salary` to a real typed column with
anything else rejected (identifiers cannot be parameterised, so an ORM does not solve this either), and
any raw `sql` block, where values are passed as parameters and never concatenated.

## Access control lives at the data layer

`buildAccessScope(user)` returns a database filter. Every read path applies it.

**Why not route guards:** guards stop people _doing_ things. A Manager denied edit access could still
open the dashboard and read company-wide averages, because that is only reading. A filter at the data
layer covers every path, including ones added later.

**Consequence accepted:** Managers and Employees are refused the statistics pages outright rather than
being shown statistics narrowed to their team. An average over three people is not meaningful and
effectively discloses individual salaries. The navigation hides what a role cannot open, so this reads as
a smaller app rather than a wall of errors.

## Caching: lookup data only

Departments, job levels, countries, currencies, bands, rates, settings — about 10 KB, held in a TTL `Map`
in the process.

**Not cached: employee and salary data.** The combinations of filter, sort, page and date are effectively
endless, so little would ever be reused — and because access differs per user, the same URL returns
different data to different people. Caching those responses risks serving one person's view to another.

**No Redis.** For 10 KB behind a single server it is another service to run, secure and monitor. The
threshold is written in the code: add it when more than one server runs, because separate processes
cannot share an in-memory map.

**Statistics are not cached either.** Each runs in roughly 20–30 ms at this size (measured, see
[performance.md](performance.md)), and a cache would let the
dashboard show stale figures immediately after a raise. If the benchmark shows otherwise, cache then.

Two free layers remain: CloudFront caches the JS and CSS, and the browser caches lookup responses.

## Tests use a real Postgres in-process

PGlite runs Postgres compiled to WebAssembly inside the Jest process. Each test file builds a fresh
database from `schema.ts` plus about 20 sample employees.

**Why not SQLite:** the statistics rely on `percentile_cont`, `width_bucket`, `DISTINCT ON` and
`FILTER`. Testing against a database that lacks them tests something other than what ships.

**Why not Docker for tests:** startup cost per run, and it makes the test-first loop slow enough to stop
using.

**Cost:** an extra dependency, and its module format needs Jest configuration. Fallback if that proves
awkward is Postgres in Docker.

**Type checking is a separate step.** The fast test compiler (`@swc/jest`) strips types without checking
them, so `tsc --noEmit` runs as its own script rather than being implied by a green test run.

## No inline styles

Material UI appearance lives in one theme file or in `styled()` components; Tailwind is used only on
plain HTML elements for layout and spacing; never both on one element. Design values are defined once and
shared between the theme and the Tailwind config.

**Enforced, not documented:** an ESLint rule fails the build on a `sx` or `style` JSX attribute.

## Two repos

Independent deploys and separate histories. **Cost:** the frontend cannot import types from the backend.
Handled with a small hand-written file of response shapes on the frontend, with backend tests asserting
its responses match those shapes. No shared package and no code generation — both cost more than the
problem.
