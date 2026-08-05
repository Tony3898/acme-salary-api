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

## SQL injection: parameterised, and proved rather than asserted

Choosing to write raw SQL means the safety argument has to be made explicitly, so here it is in full.

**Every value from a request is a bound parameter.** Drizzle's `sql` template puts each `${}`
interpolation into the parameter list and emits a `$1` placeholder in its place. A value in the parameter
list is never parsed as SQL, whatever it contains — `'; DROP TABLE employees; --` is just a name nobody
has.

**Three places in the whole codebase paste a literal into the statement**, and none of them can be
influenced from outside:

| Site                                         | What it inlines | Why it cannot be a parameter                                                        |
| -------------------------------------------- | --------------- | ----------------------------------------------------------------------------------- |
| `repositories/employees.ts` sort direction   | `ASC` or `DESC` | A keyword, not a value. Derived from `sortDir === 'asc'`, so only two strings exist |
| `repositories/statistics.ts` bucket count    | `10`            | Its type would be ambiguous inside `generate_series` and the bucket arithmetic      |
| `repositories/statistics.ts` group threshold | `5`             | Same; both are module constants with no path from a request                         |

**The sort column is the one genuinely dangerous case,** because an identifier cannot be parameterised in
any database driver — an ORM does not solve this either. It is handled by never letting request text near
it: `sortBy` is validated against a Zod enum at the route, then used as a key into a fixed
`Record<EmployeeSortField, SQL>` map. An unrecognised value is a 400 before it reaches the repository, and
even if it did, an object lookup on an unknown key yields `undefined` rather than a fragment of SQL.

**`LIKE` wildcards are escaped separately.** They are not an injection — the value is bound — but `%` in a
search box would otherwise match everything and `_` would match any character. `escapeLikeWildcards`
backslash-escapes `\`, `%` and `_` so a search for "50%" finds the text "50%".

**Proved, not argued.** `npm run verify:injection` builds every raw statement with ten hostile payloads
across all three access scopes, then asks the dialect for the SQL text and the bound parameters
_separately_ and asserts that no payload — and no dangerous fragment of one — appears in the text. It
finishes by firing the payloads at a real database and confirming the row counts are unchanged. **45/45
checks pass.** Reading the code and reasoning about it is a different and weaker check, because it is the
interpolation nobody noticed that gets you.

The same ground is covered from the outside by the test suite: a `sortBy` containing SQL is rejected with
a 400, and a search for `'; DROP TABLE employees; --` returns an ordinary empty result.

## One statement for the whole dashboard

Nine figures — headcount, payroll, mean, median, both quartiles, three group breakdowns and a ten-bucket
histogram — come back in one row of JSON, assembled with `json_agg` over a single materialised `pay` CTE.

**Why:** five queries would be five scans over the same 10,000 rows and five copies of the filters to keep
in step. One of them eventually disagrees with the others, and a dashboard whose parts do not add up is
worse than no dashboard. As it stands the department, country and level totals each sum exactly to the
company total, and that is checked rather than hoped for.

**Cost:** it is a long statement, and a long statement is harder to read than five short ones. Mitigated by
building it in named CTEs that each do one thing, and by `buildStatisticsQuery` being separable from
execution so it can be inspected without a database.

**Empty groups return null, not zero.** A median over nobody is not `$0`; `$0` is a plausible-looking
figure that is entirely made up, and it is exactly the kind of number that gets quoted. Groups below five
people have their median withheld for the same reason — the middle of four salaries is those salaries with
one step of arithmetic in front.

## Pay changes are appended, never edited

Recording a raise inserts a row. Nothing updates or deletes, which is what makes the table an audit trail
as well as a history.

**Consequences worth stating.** A wrong figure cannot be tidied away — only corrected by another record,
with both visible for good. So validation happens before the write rather than after: the amount is parsed
into whole minor units and refused if it is not an exact two-decimal figure, a start date before the hire
date is rejected, and an identical record on the same day is refused as a probable double submission. The
UI shows the change and its percentage before the button is pressed for the same reason.

**Amounts travel as strings.** JSON numbers are doubles, so `85000.1` arrives as `85000.099999999999` and
a client cannot express an exact amount even when it has one. The digits are sent as text and parsed with
integer arithmetic; `parseFloat` is banned by lint in both repositories.

**A future date is allowed and does not take effect early.** Signing off a January raise in August is
ordinary. It appears in the history marked as scheduled, because hiding it until it starts is how the same
raise gets awarded twice.

## Adding an employee: two tables, one decision

Creating a person and recording their first salary are separate tables and one act. They are written in a
transaction, because a failure between them leaves somebody hired with no pay and nobody aware of it —
and the fix is a salary backdated by however long it took to notice.

The starting salary is optional and nested rather than flattened. A record is often created before an
offer is signed off, and an invented figure is worse than a gap: the list shows "not recorded", which is
true, where `$0` would be a salary and would drag down every average taken from what is on screen.

Three references are checked before the insert rather than left to the foreign keys. A constraint
violation is a 500 with a message written for whoever is on call; a check up front is a 400 that names the
field, which is what somebody looking at a stale dropdown needs. The check is one statement with three
`EXISTS` subqueries, because they are three questions about three tables and there is no reason to pay
three round trips.

The email is lower-cased once, in the service, because the unique index is on `lower(email)`. Storing what
was typed and searching for something else is how a duplicate gets in.

## Payroll over time is not a forecast

The dashboard draws payroll for a year back and six months forward. The forward half is drawn differently
— dashed, in a second colour, past a marked boundary — because it is a different kind of number, and the
distinction has to survive somebody glancing at it.

It is not a projection. Every month after today is the same arithmetic applied to pay changes that have
**already been signed off** and carry a future date. A promotion agreed in August that starts in October
is a cost the company has taken on; it appears on no other screen, and the figure for it is the one thing
on the dashboard nothing else in the product will tell you. Guessing at attrition or at next year's review
budget would be a forecast, and this deliberately does not make one.

**One pass, not one per month.** The obvious shape is a lateral "salary in force" lookup per employee per
month, which at nineteen months and ten thousand people is 190,000 index lookups. Instead `lead()` over
each person's own records gives every salary the window it applies to, and a month matches the one window
that contains it — a single scan of the salary history whatever range is asked for. The same-day tie-break
falls out of ordering the window by `(effective_from, id)`, so "the latest record" means what it means
everywhere else.

**What it cannot show, and says so.** A leaver appears in no month at all. The record says somebody has
left but not when, so they cannot be placed back into the months they worked — and counting them in every
month would be worse than counting them in none. A leave date is the schema change that would fix it.

## Access control lives at the data layer

`buildAccessScope(user)` returns a database filter. Every read path applies it.

**Why not route guards:** guards stop people _doing_ things. A Manager denied edit access could still
open the dashboard and read company-wide averages, because that is only reading. A filter at the data
layer covers every path, including ones added later.

**Consequence accepted:** Managers and Employees are refused the statistics pages outright rather than
being shown statistics narrowed to their team. An average over three people is not meaningful and
effectively discloses individual salaries. The navigation hides what a role cannot open, so this reads as
a smaller app rather than a wall of errors.

## Sessions: a short access token plus a rotating refresh token

A 15-minute access token is held in browser memory and sent as `Authorization: Bearer`. A 7-day refresh
token lives in an httpOnly cookie scoped to `/api/auth`, is stored only as a SHA-256 hash, and is
replaced on every use.

**Why not put the access token in a cookie too:** the API and the UI are on different domains in
production, so the cookie has to be `SameSite=None`. Another site can then cause a refresh — but not
benefit from one, because the new access token comes back in the response body and the browser will not
let a cross-origin script read that. Keeping the access token out of a cookie is what makes the
cross-site cookie safe, and is also why `localStorage` is not used: an injected script can read it.

**Why the refresh token is hashed with SHA-256 and the password with argon2id.** A password is low
entropy and compared by verification, so it needs a deliberately slow hash. A refresh token is 256 bits
of randomness and is looked up by hash on every refresh, so the hash has to be deterministic and there is
nothing to brute-force.

**Rotation records why a token was revoked.** Replaying a token that was already rotated means two
parties hold it, so every session for that account ends. Replaying one that was _logged out_ is ordinary
— a background tab retrying after another tab signed out — and must not sign the person out elsewhere.
Without the distinction, closing a laptop tab signs you out of your phone.

**Equal timing on a failed login.** An unknown email is verified against a decoy hash, so the response
takes the same ~28 ms as a wrong password. Without it, a missing account answers in under a millisecond
and the login form becomes a test for whether an address has an account.

## Caching: lookup data only

Departments, job levels, countries, currencies, bands, rates, settings — about 10 KB, held in a TTL `Map`
in the process.

**Not cached: employee and salary data.** The combinations of filter, sort, page and date are effectively
endless, so little would ever be reused — and because access differs per user, the same URL returns
different data to different people. Caching those responses risks serving one person's view to another.

**In-memory here; Redis in a real deployment.** This runs as one process on one server, so the cache
lives in that process — 10 KB in a `Map`, no extra service to run, secure, monitor or fail. That is the
right answer for this app and the wrong answer for most production ones, so the boundary is worth stating
plainly rather than discovering later.

What breaks first is not size, it is the second process. Two servers behind a load balancer each hold
their own copy: a department renamed through the app invalidates one of them, and the other keeps serving
the old name until its TTL runs out — so the same user sees the change appear and disappear depending on
which server answers. Nothing errors, which is what makes it unpleasant to diagnose.

So the trigger to move is horizontal scaling, or anything else that needs state shared between
processes — session revocation lists, rate limit counters that must hold across servers, a job queue.
When it comes, Redis replaces the `load`/`invalidate` pair behind `createCachedValue` and nothing that
calls it changes: `src/cache.ts` exists as a seam for exactly that. Its cost, stated honestly, is a
service to operate, a network hop on every miss, and a new failure mode — the cache being unreachable —
which the current design cannot have.

Two things would still not be cached in Redis: employee and salary data, for the reasons above, and
anything a stale read would make wrong.

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

## One container, built at startup

`src/container.ts` opens the connection pool and constructs each service once, and `src/server.ts` is the
only place that calls it. Everything else receives what it needs.

**Why not `export const auth = ...`:** a module-level instance is created by whichever file imports it
first, which in a test run means connecting to the real database as a side effect of an import. It also
makes dependencies invisible — a function reaching for a global connection cannot be given a different
one, so it cannot be tested without the real database behind it.

**The rule that keeps a shared instance safe:** services hold dependencies, never request state. No
current user, no request id, no open transaction on a service — requests overlap at every `await`, and
one would answer with another's identity. Per-request values travel on the request; a transaction is
passed to the repository call that needs it.

## Two repos

Independent deploys and separate histories. **Cost:** the frontend cannot import types from the backend.
Handled with a small hand-written file of response shapes on the frontend, with backend tests asserting
its responses match those shapes. No shared package and no code generation — both cost more than the
problem.
