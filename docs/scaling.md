# What breaks first

This system is deliberately one box: one `t4g.micro` running the API and PostgreSQL under Docker
Compose, with the React app on CloudFront. That is the right size for 10,000 employees and one HR team,
and the wrong size for most things. This page is the part that usually goes unwritten — **in what order
it stops working, what the symptom looks like, and what the change actually is.**

Ordered by what gives way first, not by severity.

| #   | What breaks                           | Roughly when                      | The symptom                                                                                         | The change                                                                                                        |
| --- | ------------------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 1   | No redundancy                         | The first instance replacement    | Minutes of hard downtime, at a time AWS chooses                                                     | Two instances in an ASG behind an ALB. This one change forces 2, 3 and 4 below, which is why it is first          |
| 2   | The in-memory lookup cache            | The second process                | A renamed department appears and disappears depending on which server answers. Nothing errors       | Redis behind `createCachedValue` in `src/shared/cache.ts`, which exists as that seam. No caller changes           |
| 3   | Per-process rate limiting             | The second process                | The login limiter allows N per server, so two servers double it. A security control, quietly halved | Shared counter store. Refresh-token rotation is already in Postgres, so only the limiter moves                    |
| 4   | Postgres shares the box               | Sustained concurrent reporting    | The dashboard and the API contend for one CPU; `cdk destroy` on compute takes the database with it  | RDS, then a read replica for the statistics endpoints, which are read-only and the heaviest                       |
| 5   | The dashboard scales with headcount   | ~50–100k employees                | 30 ms becomes several hundred; the "as of a past date" variants go first                            | A `current_compensation` projection, one row per person, written in the same transaction as the pay record        |
| 6   | Import and bulk raise are synchronous | ~50k rows                         | A request that outlives the load balancer's idle timeout, holding a transaction while it does       | Accept, return a job id, poll. This is where a queue earns its place — and where idempotency keys become required |
| 7   | Logs are the only telemetry           | The first "it was slow yesterday" | No answer. CloudWatch has the lines but no request id joining them, and no percentiles              | Structured logs with a propagated request id, then RED metrics per route. Traces once there is a second service   |
| 8   | Deploy is stop-the-world              | Any traffic you care about        | `docker compose up` on one instance is a gap of a few seconds                                       | Rolling replacement gated on `/health`, which already exists and does not touch the database                      |

## Two of these are about correctness, not capacity

Rows 2, 3 and 6 are the ones worth reading twice, because they do not announce themselves.

**The cache and the limiter fail silently.** Adding a second server does not produce an error anywhere.
The cache serves a stale department name until a TTL expires and the user assumes they misclicked; the
rate limiter keeps working and simply permits twice what it says it permits. Both are the kind of
regression that ships, passes every test, and is found by a customer.

**Idempotency is a distributed-systems problem this app already has a corner of.** A retried bulk raise
must not pay twice. Today the write is one transaction from one process, and identical pay records are
`onConflictDoNothing` — a duplicate submit is absorbed rather than doubled. The moment that work moves
behind a queue, at-least-once delivery makes the retry routine rather than exceptional, and the
conflict rule stops being a safety net and becomes the mechanism. That is the design that has to exist
before the queue does, not after.

## What the current failure modes actually are

Not hypothetical — this is what happens today.

- **The API is down** (it is stopped nightly at 22:00 IST). The site still serves: it is static, on
  CloudFront, independent of the instance. Requests fail with a message rather than a blank page, and
  the recorded walkthrough is on the CDN so it plays regardless.
- **The database is unreachable.** The container restarts under Compose; the API's readiness comes from
  `/health`, which deliberately does not touch the database, so a health check cannot become a load test.
  The honest gap: there is no circuit breaker, and the app will keep trying.
- **The instance is destroyed.** The Elastic IP, the DNS record, the S3 bucket and the container image
  survive in a separate stack. The `infra` workflow rebuilds compute in about four minutes against the
  same URL. What does not survive is the database — correct here, because the data is generated, and
  the first thing that changes when it is not.

## Why none of it is built

Because 10,000 employees and one HR team is not a distributed systems problem, and building for load
that does not exist is the more common and more expensive mistake. Every measured query is under 90 ms
([performance.md](performance.md)), the whole dataset is 14.4 MB, and the bill is about $5 a month.

The claim being made here is not that this app is ready for scale. It is that the order above is known,
each step has a named seam, and none of them requires unpicking a decision already made — the cache is
behind one factory, the access scope is one function inside the query, and pay records are append-only,
which is what makes the projection in row 5 an addition rather than a migration of meaning.
