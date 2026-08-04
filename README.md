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

| Endpoint                 | Purpose                                                             |
| ------------------------ | ------------------------------------------------------------------- |
| `POST /api/auth/login`    | Email and password in, access token in the body, refresh token in an httpOnly cookie |
| `POST /api/auth/refresh`  | Exchanges the cookie for a new pair; the old refresh token stops working |
| `POST /api/auth/logout`   | Ends the session server-side and clears the cookie                   |
| `GET  /api/auth/me`       | The signed-in account, re-read from the database                     |
| `GET  /api/employees`     | One page of employees with their pay, scoped to what the caller may see |
| `GET  /api/lookups`       | Departments, levels, countries, exchange rates, pay bands — cached   |
| `GET  /health`            | Unauthenticated, touches no database                                 |

`GET /api/employees` takes `page`, `pageSize` (25/50/100), `sortBy`
(name/salary/hireDate/country/department/level/status), `sortDir`, `q`, `country`, `departmentId`,
`jobLevelId`, `status` and `asOf`. Sorting by salary sorts on the amount converted to USD, because
₹2,000,000 is a bigger number than $150,000 and a smaller salary. `asOf` reports pay as it stood on that
date. Anything not on those lists is refused rather than ignored.

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
```

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
