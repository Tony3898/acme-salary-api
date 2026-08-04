# Architecture

## Deployment

```mermaid
flowchart LR
    U[HR Manager<br/>browser] -->|HTTPS| CF[CloudFront]
    CF --> S3[(S3<br/>React bundle)]
    U -->|HTTPS<br/>JSON + cookie| API

    subgraph EC2 [EC2 · docker compose]
        API[Express API<br/>Node + TypeScript]
        PG[(PostgreSQL)]
        API --- PG
    end

    style EC2 fill:#393E46,stroke:#00ADB5,color:#EEEEEE
```

Two repos, deployed independently: `acme-salary-web` builds to static files on S3 behind CloudFront;
`acme-salary-api` runs as two containers on one EC2 instance. The API is stateless apart from the
database, so it can be replaced without migrating anything.

## Request path

```mermaid
flowchart TD
    R[routes/<br/>HTTP + input validation] --> S[services/<br/>business rules]
    S --> Rep[repositories/<br/>all database access]
    Rep --> DB[(PostgreSQL)]
    S --> D[domain/<br/>pure functions:<br/>money · percentiles · access scope]
    R -.-> MW[middleware/<br/>requireAuth · requireRole · errors]

    style D fill:#393E46,stroke:#00ADB5,color:#EEEEEE
```

Rules that hold everywhere:

- **Nothing outside `repositories/` imports Drizzle.** Swapping query implementations touches one folder.
- **`domain/` has no database.** Money, percentile and access-scope logic are plain functions, so the
  trickiest code is also the cheapest to test.
- **Routes contain no business logic** — they validate input, call a service, and shape the response.
- **`buildAccessScope(user)` returns a filter, and every read path applies it** — list, detail,
  statistics, bands, CSV export.

## Data model

```mermaid
erDiagram
    employees ||--o{ compensation_records : "salary over time"
    employees }o--|| departments : "belongs to"
    employees }o--|| job_levels : "at"
    employees }o--o| employees : "reports to"
    users }o--o| employees : "may be linked to"
    users ||--o{ refresh_tokens : "sessions"
    salary_bands }o--|| job_levels : "for"
    fx_rates ||..o{ compensation_records : "converts"

    employees {
        int id PK
        text full_name
        text email UK
        char country
        int department_id FK
        int job_level_id FK
        int manager_id FK
        date hire_date
        text status
        text gender
    }
    compensation_records {
        int id PK
        int employee_id FK
        bigint amount_minor
        char currency
        date effective_from
        text reason
        int created_by FK
    }
    salary_bands {
        int job_level_id FK
        char country
        bigint min_minor
        bigint mid_minor
        bigint max_minor
    }
```

`compensation_records` is append-only: a raise inserts a row, it does not update one. Current salary is
the most recent row whose `effective_from` has passed — one `DISTINCT ON` in SQL. `fx_rates` is a single
dated snapshot applied at read time, so a corrected rate never means rewriting salary rows.

## Where the load is

At 10,000 employees the database holds roughly 25,000 rows and a few megabytes; every statistic runs in
single-digit milliseconds. The constraint is the payload to the browser, which is why the API pages
results, aggregates in SQL, and returns numbers rather than rows for the dashboard.
