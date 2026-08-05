# Working with AI tools

Claude Code (Opus) was used throughout — as a design reviewer while planning, and as a pair while
writing code.

## How

- **Plan before code.** The first session produced a written plan and nothing else: data model,
  pagination contract, access rules, build order. That plan became
  [requirements.md](requirements.md) and [design-notes.md](design-notes.md).
- **Ask it to defend the reasoning, not restate the conclusion.** When an argument didn't hold up under
  a follow-up question, the decision changed.
- **One step at a time.** Tests first, then the code, then read the diff before committing. Nothing is
  committed unreviewed.
- **State the constraints up front** — no inline styles, cache configuration but never employee data,
  pagination on the server, JWT with role-based access — so the output is shaped by them rather than
  corrected afterwards.

## Where its output was wrong or needed cutting

- **A histogram axis that stopped short of the data.** Each bar was labelled with the value its band
  began at, centred underneath it. On a chart whose highest salary was $319,845 the last label read
  $289K, so the top of the range appeared nowhere and the axis looked like it was missing a bar. The
  labels now mark the band edges, with the closing bound at the end. Found by looking at the screen, not
  by a test — the numbers were all correct.
- **A forecast that would have been invented.** "Payroll forecasting" pulled towards fitting a trend line
  and projecting it. What the data actually supports is the sum of pay changes already signed off with a
  future date — a real commitment, and a figure that appears on no other screen. The endpoint reports
  that and nothing else, and the chart draws it differently so the two are never confused.
- **A chart given the whole width of a monitor.** A fixed-aspect SVG at `w-full` on a 1900-pixel screen
  is 600 pixels tall and says exactly what it said at 300. The dashboard is one grid now, two thirds and
  one third, so the extra width carries more information rather than a bigger picture of the same
  information.

- **The first design was over-built.** A USD amount stored on every salary row, a
  `current_compensation_id` pointer kept alongside the history, seed-on-boot with a persistent volume,
  and a full component test suite. All cut. The stored USD amount and the pointer were the same mistake
  twice: a second copy of a value that can be derived, which eventually disagrees with the first.
- **An argument drifted to justify a feature.** "We need migrations" started being used as a reason for
  CSV import. Importing rows changes no schema. Fixed in
  [design-notes.md](design-notes.md#drizzle-orm-with-raw-sql-where-it-does-not-fit).
- **Two things were conflated.** Injection safety comes from parameterisation, not from an ORM — and no
  ORM helps with the one real hole, a user-chosen `ORDER BY` column, because SQL identifiers cannot be
  parameterised at all.
- **Serverless was the wrong default.** Scale-to-zero saves nothing when a database is running anyway.
  One long-lived Express process removes cold starts, VPC plumbing and API-Gateway timeout batching, and
  the same `docker-compose.yml` runs locally and deployed.
- **Suggestions taken further than suggested.** Asked to cache configuration in Redis, the conclusion
  was that ~10 KB behind a single server needs no Redis at all. The condition for adding it is written
  into the code.

## Where its review changed my mind

- **A pagination bug I would have shipped:** sorting by salary without `id` as the final tiebreaker. Rows
  tied on the same salary can come back in a different order per request, so page 2 repeats people from
  page 1 and silently skips others.
- **`COUNT(*) OVER ()` returns no rows at all** for an empty result set, so `total` has to be defaulted
  rather than read from `rows[0]`.
- **Access control belonged at the data layer, not on routes.** Route guards stop people _changing_
  things; a Manager blocked from editing could still open a dashboard and read company-wide averages,
  because that is only reading.

All three are now tests.

## During the build

Notes are added here only where the output needed correcting or an exchange changed the design.

**Steps 9–10 — a 500 where a 400 belonged.** Found by firing bad input at the running endpoint rather
than by the suite, which had been written around amounts that were already valid. `parseAmountToMinor`
throws `TypeError` and `RangeError`, and the error handler correctly treats both as bugs — so posting
`170,000.00` or three decimal places produced "Something went wrong. Please try again." and a stack trace
in the log. Those are not bugs; they are somebody mistyping a salary, and the parser's own messages
("has more than two decimal places") are written to be read. The service now converts them into a 400
carrying that message. Twelve rejected-input cases are pinned as tests.

**Step 10 — writing the injection check found the bug in the injection check.** The first run reported
four failures. All four were mine: the payload `_` is a single underscore, which occurs naturally in
`full_name` and `amount_minor`, so a substring search for it finds the schema rather than a leak; and the
regex reading back the sort direction was anchored on `ORDER BY`, which matched the lateral join's own
`ORDER BY … DESC` earlier in the statement and would have reported the wrong direction while looking
entirely correct. Both are fixed, and the checker now looks for a quoted literal — the form an inlined
value would actually take — rather than a bare substring. It is worth recording because a verification
script that passes for the wrong reason is worse than none.

**Step 7 — a plan followed is not a plan obeyed.** The plan chose Material UI partly for its data grid and
its charts. Neither was used in the end. The grid's value is client-side state, sorting and virtualisation,
and this table has none of those — the server owns paging and the URL owns state, so the grid would have
been a large dependency to fight. The charts are two shapes, horizontal bars and a histogram, both of which
are a `<rect>` with a computed width; hand-rolling them kept the no-inline-styles rule intact and let each
chart be a real `<table>` underneath, which is better for a screen reader than any charting library
manages. Both are deviations from the plan and are recorded as such rather than quietly made.

**Step 4 — two problems the tests would not have found.** Both came from running the finished endpoints
against real Postgres and reading the server's own log, not from the suite.

The first was in the log line itself: signing out on one device and then letting a stale tab refresh was
being recorded as `reuseDetected`, which ends _every_ session for that account. Correct for a stolen
cookie, wrong for the far more common case of a background tab retrying after another tab signed out —
closing a laptop tab would have signed the person out of their phone. Revocations now record why they
happened, and only replaying a token that was _rotated_ is treated as theft.

The second was structural. `src/config.test.ts` and the other colocated tests sat inside
`tsconfig.build.json`'s `include`, so `npm run build` compiled test files into `dist` and failed on the
missing Jest types. Nobody had run `build` yet. Tests now all live under `tests/`, mirroring `src/`, and
the build excludes `*.test.ts` as well, so a test file that strays back into `src/` fails the build
instead of shipping.

**Adding an employee, and the transaction that was nearly missed.** The first version inserted the
record, then the first salary, as two statements. A failure between them leaves somebody hired with no
pay and nobody aware of it — the kind of half-write that is only ever found months later, when a payroll
total is short. Both are in one transaction, and there is a test that a rejected create leaves nothing
behind.

**Step 3 — verifying against real Postgres.** The suite runs on PGlite, so several claims about the `pg`
driver were untested for two steps. Running the real path found none of them wrong, but the exercise
corrected a number I had asserted rather than measured: the design notes said every statistic runs "in
under 20 ms", and three of six are 20–30 ms. Measured figures are now in
[performance.md](performance.md).

**Step 1 — test database.** PGlite returns a `bigint` column as a JS number, while `node-postgres`
returns a string; and `SUM()` over `bigint` widens to `numeric`, which arrives as a string in both. Left
alone, tests would have passed on one shape while production received another. Totals now cast back with
`::bigint`, matching parsers are registered for `pg`, and both behaviours are pinned in
`tests/pglite.test.ts`.
