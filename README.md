# acme-salary-api

[![CI](https://github.com/Tony3898/acme-salary-api/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Tony3898/acme-salary-api/actions/workflows/ci.yml)

Backend for ACME's salary management system: employee and salary records for ~10,000 people across
several countries, plus the statistics an HR Manager currently rebuilds by hand in Excel.

React UI lives in a separate repo: **[acme-salary-web](https://github.com/Tony3898/acme-salary-web)**

---

## If you have ten minutes

1. **Open [acme.tejasrana.in](https://acme.tejasrana.in)** and sign in as `hr.admin@acme.test` /
   `AcmeDemo!2026`. The login page offers one click per account.
2. **Or watch it instead: [acme.tejasrana.in/case-study#walkthrough](https://acme.tejasrana.in/case-study#walkthrough)** —
   four minutes, captioned, no sound needed, plays in the page. It is a recording of the deployed app,
   and the script that produced it is in the other repo. That page is static and public, so it works
   even in the hours the API server is stopped.
3. **Sign in again as `manager@acme.test`.** Same password, same screens, their team only, and
   `/dashboard` refused. That is the one thing worth seeing twice.
4. **Read [ai-prompts.md](docs/ai-prompts.md)** if you read one document. It is where AI helped, where
   it was wrong, and what I did about it.
5. **Skim [design-notes.md](docs/design-notes.md)** for the two sections that carry the most weight:
   _SQL injection: parameterised, and proved rather than asserted_, and _Access control lives at the
   data layer_.
6. **Then the code**: `src/domain/` is money, percentiles and access scope as plain functions, and
   [tests/http/routeInventory.test.ts](tests/http/routeInventory.test.ts) is the test that discovers
   its own subjects so a new endpoint cannot ship unclassified.

If you have a further two: [scaling.md](docs/scaling.md) is what breaks first as this grows, in
order, with the change for each — including the two that fail silently rather than loudly.

Everything below is depth for whoever wants it, not the price of entry.

---

## Live

|                  |                                                                                  |
| ---------------- | -------------------------------------------------------------------------------- |
| Application      | **https://acme.tejasrana.in**                                                    |
| Walkthrough      | https://acme.tejasrana.in/case-study#walkthrough — 4 minutes, plays in the page  |
| API              | https://acme.tejasrana.in/api — same origin, routed to this server by CloudFront |
| Health           | https://acme.tejasrana.in/health                                                 |
| How it was built | https://acme.tejasrana.in/case-study — the decisions below, in one page          |

Sign in with any of the [demo accounts](#demo-accounts). The server stops at 22:00 IST and starts
again at 09:30 IST on weekdays, so outside those hours the site loads and the API does not. Nothing
deletes itself on a timer; if the stack is ever torn down, the `infra` workflow rebuilds it in about
four minutes against the same URL. See [docs/deployment.md](docs/deployment.md).

The instance answers only CloudFront: its security group admits the CloudFront origin-facing prefix
list on 443 and nothing else, so a request straight to the origin hostname times out.

## Measured

Numbers rather than adjectives. Query figures come from `npm run bench`, which drives the same query
builders the API calls, and reprints [performance.md](docs/performance.md) — so they cannot drift from
the code the way a hand-typed table does.

|                                |                                                                                                 |
| ------------------------------ | ----------------------------------------------------------------------------------------------- |
| Dataset                        | 10,000 employees, 23,049 salary records, 6 countries, 14.4 MB                                   |
| Slowest measured query         | 87 ms — payroll trend, 12 months back and 6 forward                                             |
| Whole-company dashboard        | 31 ms — nine figures in one statement                                                           |
| Employee list, page 400 of 400 | 31 ms — the same as page 1; offset is not the cost here                                         |
| Employee list, as an Employee  | 0.9 ms — the scope is a condition inside the query, so work is proportional to what you may see |
| Seed from empty                | 2.3 s for 33,000 rows                                                                           |
| First load                     | 188 KB gzipped, then 2–21 KB per screen; every page is a separate chunk                         |
| Tests                          | 752 API, 305 web, 80% coverage enforced, all four checks in CI on every push                    |
| Hosting                        | ~$5/month, one `t4g.micro` stopped outside office hours                                         |

**What is not here: production traffic.** This has one HR team's worth of users and a synthetic dataset,
so there are no request rates, no p99 under load and no cost-per-user to report. Everything above is
measured against the full 10,000-employee seed on known hardware, and [scaling.md](docs/scaling.md) says
what gives way first when that stops being the shape of the problem.

## Documents

Read these first — they explain what is built and why.

| Document                                | What it covers                                                       |
| --------------------------------------- | -------------------------------------------------------------------- |
| [requirements.md](docs/requirements.md) | Goal, scope, what is deliberately left out. Written before any code. |
| [architecture.md](docs/architecture.md) | Deployment, layers, data model diagrams.                             |
| [design-notes.md](docs/design-notes.md) | Trade-offs, and what each decision costs.                            |
| [ai-prompts.md](docs/ai-prompts.md)     | How AI tools were used, and where the output needed correcting.      |
| [performance.md](docs/performance.md)   | Measured query and seed timings, and what they imply.                |
| [deployment.md](docs/deployment.md)     | The AWS stacks, what protects what, and what it costs.               |
| [scaling.md](docs/scaling.md)           | What breaks first as this grows, in order, and the change for each.  |

## Running locally

Needs Node 22+ and PostgreSQL 15 or later.

```bash
cp .env.example .env
npm install
docker compose up -d          # PostgreSQL on :5432
npm run db:migrate            # apply the committed migrations
npm run seed                  # 10,000 employees + demo accounts
npm run dev                   # API on :3000
```

Already have Postgres running locally? Skip the `docker compose` line and create the role and database
that `.env.example` expects:

```bash
psql -d postgres -c "CREATE ROLE acme LOGIN PASSWORD 'acme_local_dev'"
createdb -O acme acme_salary
```

`npm run verify:pg` then checks the things the test suite cannot: the tests run against PGlite, which
returns some column types differently from the `pg` driver used in production.

### Changing the schema

Edit `src/db/schema.ts`, then generate a migration and apply it:

```bash
npm run db:generate -- --name what_changed   # writes src/db/migrations/NNNN_what_changed.sql
npm run db:migrate                           # applies it
npm run verify:migrations                    # the migrations describe schema.ts, and nothing is missing
```

**Not `db:push`.** Push applies a schema change straight to a database without writing a migration, which
is quick while building and wrong the moment anybody else has a database: their copy stays on the old
shape, the tests pass on both, and the difference only surfaces where it cannot be fixed by re-seeding.
The script is still there for a throwaway database, and `verify:migrations` — which runs in CI and needs
no database at all — fails if it has been used on something that matters. It prints the migration that is
missing, so the fix is a paste rather than an investigation.

`JWT_SECRET` has no default and the process refuses to start without one — a fallback signing secret in
source would let anybody mint a valid token for a deployment whose operator forgot to set it. The copied
`.env.example` carries a placeholder that is fine locally; generate a real one per environment:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

## API

| Endpoint                                 | Purpose                                                                              |
| ---------------------------------------- | ------------------------------------------------------------------------------------ |
| `POST /api/auth/login`                   | Email and password in, access token in the body, refresh token in an httpOnly cookie |
| `POST /api/auth/refresh`                 | Exchanges the cookie for a new pair; the old refresh token stops working             |
| `POST /api/auth/logout`                  | Ends the session server-side and clears the cookie                                   |
| `GET  /api/auth/me`                      | The signed-in account, re-read from the database                                     |
| `GET  /api/employees`                    | One page of employees with their pay, scoped to what the caller may see              |
| `POST /api/employees`                    | Adds an employee, with an optional starting salary. **HR Admin only**                |
| `GET  /api/employees/:id`                | One person with their whole pay history and what each change was worth               |
| `POST /api/employees/:id/compensation`   | Records a new salary. **HR Admin only**; appends, never edits                        |
| `PATCH /api/employees/:id/status`        | Marks somebody as having left, or brings them back. **HR Admin only**                |
| `GET  /api/employees/attention`          | Everybody paid below their band, dearest to fix first — scoped to the caller         |
| `GET  /api/employees/export`             | The current view as CSV, streamed, same filters and scope as the list                |
| `POST /api/employees/import`             | A CSV of employees, previewed or applied. **HR Admin only**                          |
| `POST /api/employees/import?report=csv`  | The same file back with a `problems` column added. **HR Admin only**                 |
| `POST /api/compensation/bulk`            | One percentage over many people, previewed or applied. **HR Admin only**             |
| `GET  /api/stats/pay-gap`                | Median pay by gender within each level and country. **HR roles only**                |
| `GET  /api/bands`                        | Every band and every level/country pair that has people but none. **HR roles only**  |
| `PUT  /api/bands/:jobLevelId/:country`   | Sets the band for that level and country. **HR Admin only**                          |
| `DELETE /api/bands/:jobLevelId/:country` | Removes it, leaving those people compared against nothing. **HR Admin only**         |
| `GET  /api/stats/overview`               | Headcount, payroll, quartiles, three breakdowns and a histogram. **HR roles only**   |
| `GET  /api/stats/payroll-trend`          | Payroll month by month, plus the months already committed. **HR roles only**         |
| `GET  /api/lookups`                      | Departments, levels, countries, exchange rates, pay bands — cached                   |
| `GET  /health`                           | Unauthenticated, touches no database                                                 |

`POST /api/employees` takes the record and, optionally, `startingPay`. The salary is nested and optional
because a record is often created before an offer is signed off: left out, the person appears with no pay
recorded rather than with an invented figure. Both halves are written in one transaction, so a failure
cannot leave somebody hired with no salary. The address is stored lower-cased and has to be unique
case-insensitively — two people differing only in capitalisation is an ambiguity, and the address is how a
person is found. It is not the bulk path: that is the CSV import.

`PATCH /api/employees/:id/status` takes `status` and, when marking somebody as having left, `leftOn`.
The date is **required** for a leaver and refused for a return: without it "who was on the payroll last
March" has no answer, and every historic total is quietly too small. The database enforces the pair, so
neither half can exist without the other. A manager with people still reporting to them cannot be marked
as having left — the message names the count, because a departed manager leaves their team scoped to
somebody who cannot sign in.

`GET /api/employees/attention` lists everybody paid below the minimum of the band for their level in
their country, ordered by what it would cost to fix. Not HR-only: the access scope already answers who
may see it, so a Manager gets their own team and an Employee gets themselves — and the cost total is
computed inside the same scoped query, so it can never cover people the caller cannot see. Every figure
against a person is in that person's own currency; the ordering and the total are converted, because
weighing a rupee gap against a sterling one needs a common unit, and the response says which is which.
Leavers are excluded: there is nothing to do about their pay.

`GET /api/employees/export` applies the list's filters and ignores its paging, streaming a chunk of rows
at a time so the process never holds the whole company. The columns are exactly the ones the importer
reads, so an exported file can be edited and put back.

`POST /api/employees/import` takes a `text/csv` body and `?apply=true|false`, defaulting to a preview.
Departments, levels and managers are named rather than numbered, header names are matched ignoring case
and punctuation, and every row is checked before anything is written — a file with any problem is refused
**whole**, because writing the good rows leaves the company missing people nobody can name. A manager
listed below their own report still links correctly; a file where two people manage each other is
reported rather than half-imported.

Add `?report=csv` and the answer is the uploaded file with a `problems` column appended instead of the
JSON report. Same request, same validation, so the file cannot disagree with the screen — and it writes
nothing whatever `apply` says. It exists because a list of problems stops being usable at about thirty:
somebody with 158 bad rows in a spreadsheet of ten thousand works in the spreadsheet, not on a web page.
Every row is included rather than only the failures, so the corrected file goes straight back through the
import; `problems` is not an import column, so it is ignored on the way back in.

`POST /api/compensation/bulk` takes `percent` (a string, for the same reason `amount` is), `effectiveFrom`,
an optional `reason` and the same filters, plus `?apply=`. Preview and apply are the same call, so the
figures reported are the figures written. Each person's raise is a percentage of the salary in force **the
day before** the effective date, which is what makes running it twice a no-op rather than a compounding
one. The exact cost comes back per currency and is never summed across them; a converted total is included
and labelled as an estimate. Everybody the filters matched but the change skipped is counted with a
reason.

`GET /api/bands` is the only place bands are written, and it exists because without it "below band" is a
judgement made by whoever last ran the seed script — changing it would mean database access, which an HR
team cannot be asked for. The response is **not** simply the bands that exist: it is every level-and-country
pair that has people in it _or_ has a band, each with how many sit below, within and above. A missing band
is otherwise invisible, showing up one person at a time on their own pages with nobody adding up how many
are compared against nothing. Each row also carries what those people are actually paid in, because a band
in the wrong currency compares to nobody and looks set while being useless.

`PUT` on the natural key rather than POST-and-PATCH, because (job level, country) _is_ a band's identity —
the table is unique on it. That makes the write idempotent and means a client need not know whether a band
exists to choose a method. Amounts are strings, like everywhere else, and the three have to read minimum,
midpoint, maximum in order. Every write answers with the whole recomputed list, because the figure worth
seeing after setting a band is how many people are now below it. Bands ride along in the cached lookup
data, so a write invalidates that cache.

`POST /api/compensation/bulk` also accepts `employeeIds`, which narrows the change to named people out
of the ones the filters matched — it can never widen, because the list is intersected with what the
filters and the access scope already allowed. It is sent on the **preview** as well as the apply, so a
partial selection is costed by the same arithmetic over the same rows rather than by subtracting the
deselected from a total somewhere else. The report lists the individual changes up to a cap and says when
it truncated them; beyond that a selection is not offered, because nobody reviews nine thousand
checkboxes and the payload is the thing this design avoids.

`GET /api/employees` also accepts `bandFit`, one of `BELOW`, `WITHIN`, `ABOVE`, `NO_BAND`, `NO_PAY` or
`OTHER_CURRENCY` — the same six outcomes shown against a person on their own row, expressed by the same
SQL. That is what makes the counts on the pay-bands screen clickable: "22 below" links to this filter, and
a test asserts the count and the filtered total are equal for every outcome.

`GET /api/stats/pay-gap` compares median pay by gender **within one country at one level**, in that
country's currency. There is deliberately no company-wide figure: one number for the company mostly
measures who sits at which level, and it is the number that would get quoted. Groups under five have their
median withheld, cells whose people are paid in more than one currency are dropped, and both counts are
published so a reader knows what is missing. Men are the comparator, as in statutory reporting, and the
response says so. The seeded data has a deliberate gap in it — random salaries show none — and
`SYNTHETIC_DATA` is what makes the UI say so.

`GET /api/stats/payroll-trend` takes `historyMonths` (up to 36) and `horizonMonths` (up to 24, and `0`
for history alone), both clamped rather than refused. Months up to today are `ACTUAL`; months after it are
`COMMITTED` — **not a forecast**, but the same arithmetic over pay changes that have already been signed
off and carry a future date. A promotion agreed in August that starts in October is a cost the company has
taken on, and it is invisible on every other screen. Nothing here guesses at attrition or at next year's
review budget. Leavers count in the months they were actually employed, which is what `employees.left_on`
is for.

`GET /api/employees` takes `page`, `pageSize` (25/50/100), `sortBy`
(name/salary/hireDate/country/department/level/status), `sortDir`, `q`, `country`, `departmentId`,
`jobLevelId`, `status` and `asOf`. Sorting by salary sorts on the amount converted to USD, because
₹2,000,000 is a bigger number than $150,000 and a smaller salary. `asOf` reports pay as it stood on that
date. Anything not on those lists is refused rather than ignored.

`GET /api/employees/:id` answers **404 for a record outside the caller's access scope**, identically to
one that does not exist. A 403 would confirm the record is there, which is enough to walk the ids and map
the company from an account that can see 84 people.

`POST /api/employees/:id/compensation` takes `amount`, `currency`, `effectiveFrom` and an optional
`reason`. **`amount` is a string**, not a JSON number: JSON numbers are doubles, so `85000.1` arrives as
`85000.099999999999` and a client could not express an exact amount even when it had one. A future
`effectiveFrom` schedules the change; a past one corrects the record; an identical record on the same day
is refused as a probable double submission, because the table is append-only and has no undo.

`GET /api/stats/overview` takes `asOf`, `status` (ACTIVE/LEFT/ALL, default ACTIVE), `country`,
`departmentId` and `jobLevelId`. Managers and Employees get a 403 rather than figures narrowed to their
team: a median over three people is those three salaries with one step of arithmetic in front. Empty
groups report `null`, never `0`, and a group of fewer than five has its median withheld.

Failures share one shape — `{ "error": { "code", "message" } }`, with `details` added for validation —
so the client parses one thing. A failed login answers identically whether the email is unknown or the
password is wrong.

## Demo accounts

Created by the seed. Password is `AcmeDemo!2026` for all four, overridable with
`SEED_DEMO_PASSWORD`. **Demo only** — these are published here on purpose.

| Email                 | Role      | Sees                                     |
| --------------------- | --------- | ---------------------------------------- |
| `hr.admin@acme.test`  | HR Admin  | Everyone, and can record changes         |
| `hr.viewer@acme.test` | HR Viewer | Everyone, read only                      |
| `manager@acme.test`   | Manager   | Their own reporting line, read only      |
| `employee@acme.test`  | Employee  | Their own record and salary history only |

The manager and employee accounts are linked so the employee sits inside the manager's team, which makes
the difference between the two visible.

**The data is synthetic.** Names are generated combinations and pay figures are plausible rather than real
market data. Every person has a distinct name, which is arranged rather than hoped for: a first name and a
surname drawn independently from pools whose product is smaller than the headcount collide constantly — the
first version produced 2,624 duplicate names and eleven people called Ethan Nakamura. Combinations are now
issued from a shuffled enumeration, so a name is never used twice and the same seed still produces the same
company. A small gender pay gap is introduced deliberately, because randomly generated salaries show
none and the pay-gap screen would have nothing to display. Same seed, same data, every run.

## Checks

```bash
npm test                      # Jest, against an in-process Postgres (PGlite)
npm run test:coverage         # 80% minimum, enforced
npm run typecheck             # separate step — the test compiler skips types
npm run lint
npm run verify:migrations     # the committed migrations describe schema.ts — needs no database
npm run verify:pg             # driver behaviour the in-process Postgres cannot show
npm run verify:injection      # every raw statement, built with hostile input
npm run bench                 # times the real query builders; reprints the performance table
```

`bench` is not a check and is not in CI — a timing assertion on a shared machine fails for reasons that
have nothing to do with the code. It exists so the figures in
[docs/performance.md](docs/performance.md) can be reproduced rather than believed.

The rest run in CI on every push and pull request, and the second job runs the suite, the migrations
and the seed against a **real PostgreSQL** service container before `verify:pg` and `verify:injection` —
see [.github/workflows/ci.yml](.github/workflows/ci.yml). The suite itself uses PGlite, which is a real
Postgres compiled to WebAssembly and identical for everything the queries do; it is _not_ identical in how
values come back, since node-postgres returns `bigint` as a string and PGlite as a number, and every
salary here is a bigint. That difference is only ever caught against the real server.

Two tests exist to catch the endpoint or the query somebody adds later:

- **[tests/http/routeInventory.test.ts](tests/http/routeInventory.test.ts)** discovers every registered
  route by reading the routers, and fails until each appears in a table saying who may reach it. It then
  proves each classification — an anonymous call is refused, a Manager is refused an HR-only route, HR
  Viewer is refused every write, and HR Admin is refused none of them. Sixteen careful per-endpoint tests
  do not stop a seventeenth endpoint shipping with no guard at all.
- **[tests/repositories/queryScope.test.ts](tests/repositories/queryScope.test.ts)** discovers every
  exported query builder and requires each to be classified as scoped or aggregate. A scoped one must put
  the access scope in the SQL it generates — checked on the generated statement, so taking a scope and
  forgetting to use it fails. An aggregate one takes no scope, and must therefore name nobody: no
  `full_name`, no `email`.

`verify:injection` exists because this codebase writes raw SQL on purpose, and that choice has to be paid
for with evidence rather than confidence. It builds each statement with ten hostile payloads across all
three access scopes, asks the dialect for the SQL text and the bound parameters _separately_, and asserts
that no payload — and no dangerous fragment of one — reached the text. It then fires them at a real
database and confirms the row counts are unchanged. See
[design-notes.md](docs/design-notes.md#sql-injection-parameterised-and-proved-rather-than-asserted).

## Layout

```
src/
  config.ts        every environment variable, validated once at startup
  container.ts     one pool and one instance of each service, built at startup
  app.ts           the HTTP layer, assembled around a container
  server.ts        the process: config, container, listen, graceful shutdown
  shared/          used by every layer, owned by none: errors, logger, cache
  db/              client, schema, seed, migrations
  domain/          pure logic, no database: money, tokens, passwords, roles
  repositories/    all database access, one file per area
  services/        business rules
  routes/          HTTP and input validation
  middleware/      auth, roles, rate limiting, error handling
tests/             mirrors src/, so src/ holds only code that ships
```

`shared/` rather than `utils/`, deliberately. These three are cross-cutting — the error contract, the log
format, the in-memory cache — and "utils" is a name that means _miscellaneous_, so it becomes the folder
anything lands in and stops being possible to reason about. The four files left at the root are the
composition root: what the process is, not what it uses.

Three rules the linter enforces: nothing outside `repositories/` imports Drizzle (`container.ts` may
build the connection but runs no queries), `parseFloat` is banned — money is handled as whole minor units
— and no `eslint-disable` comment is permitted.

## Three patterns that are not about salaries

The brief was salary management, but three decisions here are shape rather than subject, and are the
part I would carry into a different system unchanged.

**Access as a filter, not a check.** `buildAccessScope(user)` returns a database predicate, and every
read path applies it. The alternative — a guard on each route — stops people _doing_ things and does
nothing about reading, so a Manager blocked from editing can still open a dashboard and read
company-wide figures. The same shape answers "which tickets may this agent see", "whose leave requests
land in this queue", "which accounts does this partner's export include" — anywhere the answer is a set
rather than a yes. Its real cost is that it must be impossible to forget, which is why
[routeInventory.test.ts](tests/http/routeInventory.test.ts) discovers routes rather than listing them.

**Dated records instead of editable values.** A salary is not a number on a person, it is a row with a
start date; the current one is the most recent that has begun. That gives history, "as it stood on any
past date", and an audit trail from one decision rather than three features. Leave balances, prices,
budgets, feature entitlements and rates all have the same shape and are all routinely modelled as a
mutable column, which loses the past on every write. The cost is a lateral join on every read and one
more thing to explain to whoever expects `employee.salary`.

**Tests that discover their own subjects.** Three checks here take their inputs from the codebase rather
than from a list somebody maintains: routes are read off the routers, query builders are checked by
reading the SQL they generate, and page components are found by globbing the directory. A hand-listed
test covers what its author remembered; a discovered one fails when something new appears and nobody has
classified it. That applies to any invariant that must hold across a growing set — every endpoint is
authenticated, every event has a schema, every migration is reversible — and it is the difference
between a suite that documents the past and one that constrains the future.

None of this is novel. It is the reason the answer to "how would you apply this elsewhere" is a shape
and not a rewrite.
