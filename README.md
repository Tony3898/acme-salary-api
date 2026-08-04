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

## Running locally

Needs Node 22+ and Docker.

```bash
cp .env.example .env
npm install
docker compose up -d          # PostgreSQL on :5432
npm run db:push               # create the schema
npm run seed                  # 10,000 employees + demo accounts
npm run dev                   # API on :3000
```

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
