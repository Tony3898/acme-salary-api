# acme-salary-api

Backend for ACME's salary management system: employee and salary records for ~10,000 people across
several countries, plus the statistics an HR Manager currently rebuilds by hand in Excel.

React UI lives in a separate repo: **[acme-salary-web](../acme-salary-web)**

## Documents

Read these first — they explain what is built and why.

| Document                                | What it covers                                                       |
| --------------------------------------- | -------------------------------------------------------------------- |
| [requirements.md](docs/requirements.md) | Goal, scope, what is deliberately left out. Written before any code. |
| [architecture.md](docs/architecture.md) | Deployment, layers, data model diagrams.                             |
| [design-notes.md](docs/design-notes.md) | Trade-offs, and what each decision costs.                            |
| [ai-prompts.md](docs/ai-prompts.md)     | How AI tools were used, and where the output needed correcting.      |
| [performance.md](docs/performance.md)   | Measured query and seed timings, and what they imply.                |

## Running locally

Needs Node 22+ and PostgreSQL 15 or later.

```bash
cp .env.example .env
npm install
docker compose up -d          # PostgreSQL on :5432
npm run db:push               # create the schema
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

`JWT_SECRET` has no default and the process refuses to start without one — a fallback signing secret in
source would let anybody mint a valid token for a deployment whose operator forgot to set it. The copied
`.env.example` carries a placeholder that is fine locally; generate a real one per environment:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

## API

| Endpoint                               | Purpose                                                                              |
| -------------------------------------- | ------------------------------------------------------------------------------------ |
| `POST /api/auth/login`                 | Email and password in, access token in the body, refresh token in an httpOnly cookie |
| `POST /api/auth/refresh`               | Exchanges the cookie for a new pair; the old refresh token stops working             |
| `POST /api/auth/logout`                | Ends the session server-side and clears the cookie                                   |
| `GET  /api/auth/me`                    | The signed-in account, re-read from the database                                     |
| `GET  /api/employees`                  | One page of employees with their pay, scoped to what the caller may see              |
| `POST /api/employees`                  | Adds an employee, with an optional starting salary. **HR Admin only**                |
| `GET  /api/employees/:id`              | One person with their whole pay history and what each change was worth               |
| `POST /api/employees/:id/compensation` | Records a new salary. **HR Admin only**; appends, never edits                        |
| `GET  /api/stats/overview`             | Headcount, payroll, quartiles, three breakdowns and a histogram. **HR roles only**   |
| `GET  /api/stats/payroll-trend`        | Payroll month by month, plus the months already committed. **HR roles only**         |
| `GET  /api/lookups`                    | Departments, levels, countries, exchange rates, pay bands — cached                   |
| `GET  /health`                         | Unauthenticated, touches no database                                                 |

`POST /api/employees` takes the record and, optionally, `startingPay`. The salary is nested and optional
because a record is often created before an offer is signed off: left out, the person appears with no pay
recorded rather than with an invented figure. Both halves are written in one transaction, so a failure
cannot leave somebody hired with no salary. The address is stored lower-cased and has to be unique
case-insensitively — two people differing only in capitalisation is an ambiguity, and the address is how a
person is found. It is not the bulk path: that is the CSV import.

`GET /api/stats/payroll-trend` takes `historyMonths` (up to 36) and `horizonMonths` (up to 24, and `0`
for history alone), both clamped rather than refused. Months up to today are `ACTUAL`; months after it are
`COMMITTED` — **not a forecast**, but the same arithmetic over pay changes that have already been signed
off and carry a future date. A promotion agreed in August that starts in October is a cost the company has
taken on, and it is invisible on every other screen. Nothing here guesses at attrition or at next year's
review budget. Leavers are counted in no month, because the record says somebody has left but not when.

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
market data. A small gender pay gap is introduced deliberately, because randomly generated salaries show
none and the pay-gap screen would have nothing to display. Same seed, same data, every run.

## Checks

```bash
npm test                      # Jest, against an in-process Postgres (PGlite)
npm run test:coverage         # 80% minimum, enforced
npm run typecheck             # separate step — the test compiler skips types
npm run lint
npm run verify:pg             # driver behaviour the in-process Postgres cannot show
npm run verify:injection      # every raw statement, built with hostile input
```

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
  errors.ts        what a failure looks like to a client
  logger.ts        one line of JSON per event, sensitive fields redacted
  db/              client, schema, seed, migrations
  domain/          pure logic, no database: money, tokens, passwords, roles
  repositories/    all database access, one file per area
  services/        business rules
  routes/          HTTP and input validation
  middleware/      auth, roles, rate limiting, error handling
tests/             mirrors src/, so src/ holds only code that ships
```

Three rules the linter enforces: nothing outside `repositories/` imports Drizzle (`container.ts` may
build the connection but runs no queries), `parseFloat` is banned — money is handled as whole minor units
— and no `eslint-disable` comment is permitted.
