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
  db/              client, schema, seed, migrations
  domain/          pure logic, no database: money, percentiles, access scope
  repositories/    all database access, one file per area
  services/        business rules
  routes/          HTTP and input validation
  middleware/      auth, roles, error handling
```

Two rules the linter enforces: nothing outside `repositories/` imports Drizzle, and `parseFloat` is
banned — money is handled as whole minor units.
