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

That last sentence deserves less confidence than it reads with. "The UI says so" is a caption, and a caption
does not survive somebody screenshotting the chart into a board pack — at which point last January's payroll
is being read as what it cost last January, which is not what the figure means. The real fix is small and
known: dated rate snapshots, and convert at the rate of the month being shown. It is out of scope here as
documented, but the mitigation on record is a label, and a label is not a control.

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

**Migrations:** see the next section. Note that adding _records_ is not a migration: CSV import, seeding
and bulk raises change no schema.

## Migrations: generated files, and a check that they are not missing

While the schema was changing several times an hour and every row came from the seed script,
`drizzle-kit push` was the right tool: it diffs `schema.ts` against the database and applies the
difference, with no files to write. It stops being the right tool the moment a second person has a
database — and the way it stops is quiet. Push writes no migration, so their copy stays on the old shape,
the tests pass on both, and the difference surfaces only somewhere that cannot be rebuilt from a seed. A
review does not show it either: the diff has a changed column and no migration, which looks exactly like a
change that needed none.

So the schema is now migration-first. `src/db/migrations/` holds generated SQL, `npm run db:migrate`
applies it, and the README's setup steps use it rather than push.

The part that makes this hold is `npm run verify:migrations`, because a documented workflow is not a
mechanism. It copies the migrations folder, runs a generate into the copy, and fails if that produces
anything — which it only does when `schema.ts` and the committed migrations disagree. Then it prints the
SQL of the missing migration, so the fix is a paste. Two details it learned the hard way, both now
commented in the script: `drizzle-kit` resolves `--out` by prefixing `./`, so an absolute temporary path
silently fails, and it reports that failure by _printing an error and exiting 0_ — a check that only looked
for new files would have called that a pass. It needs no database at all, so it runs in CI before anything
is provisioned and cannot be satisfied by a server somebody has already pushed to.

`tests/db/migrations.test.ts` asks the other half of the question: applied to an empty database, do the
committed files actually produce `schema.ts`? Rather than listing tables and hoping the list is complete,
the migrated database is handed to the same schema diff that generates migrations — if it finds nothing to
change, the two agree down to constraints, defaults and enum members. Applying them twice must also change
nothing, which is what a re-run deploy does.

## CI runs against a real PostgreSQL, not only the in-process one

The suite runs on PGlite, which is Postgres compiled to WebAssembly: identical for everything the queries
do, and _not_ identical in how values come back. node-postgres returns `bigint` as a string and PGlite as
a number, and every salary here is a bigint. `verify:pg` exists for exactly that class of difference — and
until now it was a script somebody had to remember to run.

[.github/workflows/ci.yml](../.github/workflows/ci.yml) has two jobs. The first needs no database: lint,
typecheck, and the migration drift check — separated so a lint error does not wait on a container starting,
and so the drift check is _seen_ to need no server. The second brings up `postgres:17-alpine`, the same
major version `docker-compose.yml` runs locally, then runs the suite with coverage, applies the migrations,
seeds ten thousand employees, and finally runs `verify:pg` and `verify:injection` against it. The injection
check is meaningless against a mock: half of what it does is fire the payloads at a real server and confirm
the tables are still there.

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
execution so it can be inspected without a database. The maintainability objection is fair and worth
answering rather than deflecting: independent optimisation _is_ harder here, and a plan regression in one
CTE slows every figure on the screen. Measured, the whole thing is 64 ms across the company and 25 ms
filtered, so there is nothing to optimise independently yet. The honest trigger to split it is a figure that
needs a different population from the others — a distribution over leavers, say — because at that point the
single `pay` CTE stops being the thing they share, and the argument for one statement goes with it.

**Two ordering bugs it had, both invisible.** `json_agg` was ordered by total alone, so two departments with
the same payroll cost came back in whatever order the plan produced and the bars swapped places between two
identical refreshes; every ordering now ends in the label. And the histogram's boundary labels divided
`bigint` by the bucket count, which truncates — printing a boundary up to nine cents below the one
`width_bucket` had actually counted against, so a salary exactly on the line fell in a bar whose stated
range excluded it. The division is now `numeric` and rounded, and the test that catches it puts somebody one
cent under a boundary and asserts each bar's printed range holds the people counted in it.

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

**The duplicate check is the write, not a question asked before it.** This started as a `SELECT` followed
by an `INSERT`, which reads correctly and is wrong: between the two there is a window, and two requests
arriving together — a double-clicked button, a client retrying a request that had actually succeeded —
both read "no duplicate" and both write. In an append-only table that is a raise paid twice with no way to
take it back. So the rule lives on the table as a unique index over the whole tuple (person, date, amount,
currency), the insert goes ahead, and the constraint's refusal becomes the 400 the client sees. One query
instead of two, and the answer is true under concurrency rather than usually.

A _different_ amount on the same day is still allowed — that is a correction, which is why the index
covers the amount and not just the pair. The bulk path handles the same collision with
`onConflictDoNothing` rather than an error: one person recording one raise twice has made a mistake worth
telling them about, but a bulk apply of 400 where three were already written is the constraint doing its
job, and the report's counts already carry it. The count it reports is rows actually written, not rows
attempted.

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

## A leaver needs a date, not a flag

`employees.status` says _whether_ somebody is employed. It cannot say _when_ they
stopped being, and without that "what did payroll cost last March" has no answer:
a leaver looks as though they were never there, so every historic total is quietly
too small — wrong in the direction that looks like the company getting cheaper.

So there is a `left_on` date, and the schema pairs it with the status:

```sql
CHECK ((status = 'LEFT') = (left_on IS NOT NULL))
CHECK (left_on IS NULL OR left_on >= hire_date)
```

Both or neither, enforced by the database, so no code path can produce a leaver
with no date or an active employee carrying one. `PATCH /api/employees/:id/status`
writes the pair in one statement for the same reason — two updates would have to
pass through exactly the state the constraint forbids.

The payroll trend now asks the honest question, `left_on IS NULL OR left_on >=
month`, instead of counting only people currently on the books.

**Marking a manager as having left is refused while anybody still reports to
them.** Not tidiness: the Manager access scope resolves to an employee, so a
departed manager leaves everybody underneath scoped to somebody who cannot sign
in. The message names the count, because "reassign them first" is the next step.

## Pay bands: one comparison, and the three ways it cannot be made

`bandStanding()` in `src/domain/payBand.ts` is the whole rule, and its most
important property is what it refuses. A salary is only ever compared to a band in
**the same currency**. Converting to compare would produce a number, and the number
would be wrong — a Bangalore engineer beside a San Francisco one looks underpaid
and is not, because the two are paid against different local markets. There is
deliberately no exchange rate anywhere in that file.

So the outcome is a six-way enum rather than a boolean: `BELOW`, `WITHIN`, `ABOVE`,
and then `NO_BAND`, `NO_PAY`, `OTHER_CURRENCY`. The last three are things a screen
has to say out loud. "No band for this level in Canada" is a gap in the reference
data somebody should fill, and showing nothing is how it stays unfilled.

One flat shape carries every outcome, rather than a variant type per case. The
alternative spread the same six-way switch across every screen that draws a band.

**The needs-attention list has to express "below band" twice**, because thousands
of rows cannot be filtered and sorted in Node. `src/repositories/payBands.ts` holds
the SQL predicate directly beside a pointer to the pure function, and
`tests/http/attention.test.ts` walks every seeded employee through both and asserts
they pick the same people. Two expressions of one rule is the shape that quietly
diverges; the test is what makes the divergence impossible to miss.

The one converted figure on that screen is the **ordering**, and the cost total.
"Fix the expensive ones first" has to weigh a rupee gap against a sterling one, and
without a common unit the list would simply be sorted by which currency has the
larger numbers. Every figure a reader sees against a person stays local, and the
response says which is which.

## Bands are set in the product, not in the seed script

Everything in the section above reads `salary_bands`. For a while nothing wrote it, which meant "below
band" was a judgement made by whoever last ran the seed — and changing it meant database access. That is
not something an HR team can be asked for, so it was a hole in the feature rather than a deferred nicety.

`GET /api/bands` deliberately does not return the bands. It returns every level-and-country **pair** that
has people in it or has a band, whichever. A missing band is otherwise invisible: those people read "no
band set" one at a time on their own pages, and nobody ever adds up how many are being compared against
nothing. The response says how many pairs and how many people are uncovered, and the screen leads with
that number.

Each row carries the below/within/above counts for its own band, and **what those people are actually
paid in**. The second is there because a band in the wrong currency compares to nobody — every person in
it reads as `OTHER_CURRENCY` — so it looks set while being useless, which is worse than being absent. The
editor defaults the currency to what the people are paid in and warns when somebody changes it away.

`PUT /api/bands/:jobLevelId/:country` rather than a POST and a PATCH, because (job level, country) _is_ a
band's identity — the table is unique on it. The write is therefore idempotent, a client does not have to
know whether a band exists in order to pick a method, and two people setting the same band land on the
same row instead of racing to create it twice.

Every write answers with the whole recomputed list. The figure worth seeing after setting a band is how
many people are now below it, and that is only knowable by recomputing — so the screen redraws from one
response rather than swapping a row and keeping stale counts beside it.

There is deliberately no band history. A band is current policy, not a record of what anybody was paid;
the salary history is the audit trail, and changing a band changes nothing anybody earned.

## The pay gap has no headline number

Three rules, and each exists because the obvious version of this feature produces a
figure people quote.

**Compare like with like.** A single company-wide percentage mostly measures who
sits at which level in which country, not what anybody is paid for their job. So
every comparison is inside one country at one level — a cell — and there is
deliberately no total anywhere in the response. Somebody who wants one can add up
the cells and will have to decide how to weight them, which is the argument they
should be having.

**Never across currencies.** A cell is one country, so its medians are normally
directly comparable. Where they are not, the cell is dropped and counted rather
than converted: a gender gap computed through an exchange rate measures the
exchange rate.

**Suppress small groups.** `MIN_GROUP_FOR_MEDIAN` is 5, and it lives in
`src/domain/disclosure.ts` rather than in whichever query needed it first — it is a
disclosure policy, three features lean on it, and it has to be the same number in
all of them or the suppression can be undone by comparing two screens. Splitting
10,000 people three ways leaves real cells with three or four people in them, where
a "gap" is one person's salary.

Men are the comparator, matching statutory reporting, and the response says so
rather than leaving a reader to work out which way a negative number points. The
counts of suppressed and excluded cells are published too: a reader who sees eleven
cells out of forty needs to know the rest were withheld, or they conclude the
analysis found nothing.

`NULL` gender is not a fourth category. It is an absence, and treating it as a group
would invent a finding out of missing data — so those people are counted separately
and named as uncounted.

## CSV: one column list, in both directions

The export writes the columns the import reads. That makes a round trip a real
property rather than a hope — a file can be exported, edited in Excel and put back
— and it is the cheapest available test of both halves: a mismatch anywhere in
thirteen columns shows up as a validation problem rather than as a hire date landing
in the salary column. `tests/http/employeeCsv.test.ts` exports the whole company,
re-imports it, and asserts every row is refused for exactly one reason: the address
is already taken.

References are by **name and email**, never by id. A spreadsheet has "Engineering"
and an address in it; asking somebody to look up department 4 is asking them to make
mistakes. Header names are matched loosely — case, spaces and underscores ignored —
because the file usually comes out of somebody else's system and refusing it over a
capital letter teaches people to fight the tool.

**The parser is real.** Splitting on commas is wrong for the first row containing
"Smith, Jr.": that row gains a column, everything after it shifts, and the result is
plausible data rather than an error. So `src/domain/csv.ts` handles quoted fields,
embedded commas and newlines, doubled quotes, both line endings and Excel's
byte-order mark. On the way out it also prefixes a leading `=`, `+`, `-` or `@` with
an apostrophe, because Excel treats those as formulas and an exported name is
otherwise one spreadsheet away from being something the machine tries to run.

**A file with any problem is refused whole.** The tempting alternative — write the
9,842 good rows, report the 158 bad ones — leaves the company missing 158 people
with no record of which, and the corrected file cannot be uploaded again because
the good rows would now collide. All of it or none of it is the only version
somebody can recover from, which is why the insert is one transaction.

**Insertion order is worked out rather than patched up.** A CSV names managers by
email and has no reason to be sorted by seniority, so the obvious approach is to
insert everybody with a null manager and run an UPDATE pass. Instead
`src/domain/importOrder.ts` sorts the rows into layers, managers first, and each
layer's returned ids resolve the next layer's managers. One pass, no half-linked
hierarchy if a second statement fails — and working out the order means cycles have
to be found, which the UPDATE version would happily create. A file saying A reports
to B and B reports to A is reported rather than broken arbitrarily.

The importer does no locale guessing on amounts. `parseAmountToMinor` refuses
"85,000.50" rather than stripping the comma, because half of Europe writes 85000,50
for the same amount and stripping would read it as eight and a half million — a
hundredfold error that passes every later check.

**The problems come back as a file, not only as a list.** The preview screen lists them, and that list
stops being usable at about thirty: somebody with 158 bad rows in a spreadsheet of ten thousand cannot work
from a list in another window — they would have to find row 4,812, read what was wrong with it, fix a cell,
and repeat 157 times with no way to mark their place. So `?report=csv` returns the file they uploaded with
a `problems` column appended: the complaint sits next to the data it is about, and it sorts and filters
like any other column.

Three decisions inside that. It is the **same request** with a different representation, not a second
endpoint, so the file cannot disagree with the screen about what is wrong — and the report is built after
the two checks that need the database, taken addresses and unresolvable managers, which are exactly the
problems nobody can work out by reading their own file. **Every row is included**, not only the failures,
because a file of just the bad rows cannot be re-imported: it is missing the 9,842 that were fine, and
merging them back by hand is the error-prone step this replaces. And `problems` is deliberately **not** an
import column, so the corrected file goes straight back in with the column still on it.

## Distinct names are constructed, not hoped for

The seed picked a first name and a surname independently from pools of 75 and 50. That is 3,750
combinations for 10,000 people, so duplicates were not bad luck but arithmetic — 2,624 of them, with eleven
people called Ethan Nakamura. Worth writing down because the instinct is to add more names, and more names
does not fix it: drawing ten thousand times from a bag you keep refilling collides however large the bag.

Now each gender's combinations are enumerated, shuffled once with the seeded random, and issued. A name is
never used twice, running out throws rather than repeating, and the same seed still produces the same
company. The surname pool grew to 260 to give the enumeration headroom.

The tell that something was wrong had been visible for a while: `uniqueEmail` appends a number until the
address is free, so emails were unique by construction while names were left to chance. One identity field
was guaranteed and its twin was not.

## Typing an amount: strict parser, helpful form

The parser above is deliberately unforgiving, and that is the right call for a boundary. It made the form
wrong, though: paste `85,000.50` out of the spreadsheet this system exists to replace — which is where
every figure in it comes from — and the field turned red and said "no separators". Accurate, and no help.

Nothing is corrected silently, because the danger is unchanged: a program that quietly picks a reading of
`85,000.50` will one day pick the wrong one. Instead the unambiguous reading is **offered**. `suggestAmount`
returns `85000.50` for the form to show as "Did you mean 85000.50?", one click fills it in, and what
somebody sees before they save is exactly what gets sent.

What makes "unambiguous" defensible here is a property of this system rather than of typography: every
currency it holds has two decimal places, so a comma followed by exactly three digits cannot be a fraction,
and the only reading left is a thousands separator. That is why `1,234` is offered as `1234` even though it
is genuinely ambiguous in general. The converse is refused: `85000,50` is not a group of three, so no
suggestion is made and the strict error stands. Spaces — including the non-breaking ones Excel and
`Intl.NumberFormat` produce — and a leading currency symbol are dropped, since neither is a decimal
separator anywhere.

The field itself became one component rather than two copies, which is how the old refusal came to be
written twice in the first place.

## Bulk raises: preview and apply are one call

`POST /api/compensation/bulk?apply=true|false`. One function with a flag, not two
endpoints and not two code paths. That is the only structure in which "the preview
matched what was applied" is guaranteed rather than tested for: the figures on
screen and the rows in the table come from the same arithmetic over the same rows.

**The rounding rule is written down**, because it is visible in a total across ten
thousand people and an append-only table has no undo. Half a cent rounds **up, in
both directions**: a 2.5-cent raise becomes 3 and a 2.5-cent cut becomes 2, so a
rounding decision never leaves somebody worse off. `Math.round` does exactly that;
the test holds it against an independent expression of the same rule rather than
against a second call to `Math.round`.

**The base is the salary in force the day before the raise starts**, not on the day
itself. This was a bug first: reading the salary on the effective date meant a
record the operation had just written became its own starting point, so applying 4%
from 1 December twice took 4% of the already-raised figure. It is also the more
defensible reading — "4% from 1 December" is a statement about what people were on
in November, and it means the same thing however many times somebody presses the
button.

**Nobody is dropped quietly.** Somebody with no salary recorded, somebody hired
after the date, somebody who already has this exact record, and somebody who has a
_different_ change dated that day are four separate counts in the report. The last
two are deliberately not one number: "nothing to do" and "somebody else has already
decided something about this person on this date" call for different reactions, and
a promotion dated the same day is left alone rather than overridden.

**The exact cost is per currency, never one total.** Adding rupees to pounds is the
mistake this whole system is arranged to prevent. There is also a converted figure,
labelled as an estimate, for the one question that needs a common unit — and the
label is honest: it applies the percentage to each person's converted amount rather
than converting the raised local amount, which differs by at most a cent per person
against a total that already rests on a single exchange-rate snapshot. The figures
that get _written_ are the local ones, and those are exact.

## Choosing who a bulk change applies to

A percentage over a filter is the ordinary case; the exceptions are the reason anybody hesitates before
pressing the button. Somebody mid-disciplinary, somebody promoted last week. So the preview lists the
individual changes with a checkbox each, everybody ticked, and unticking somebody excludes them.

**Unticking does not subtract from the total on screen.** It sends the selection back and the server
re-costs it. Adding up server-computed figures in the browser would be a second place where the cost of a
bulk change is decided — and while summing integers is not the same risk as re-implementing the rounding,
it is the same _shape_ of risk, and the guarantee this feature rests on is that there is exactly one
arithmetic. The selection therefore travels on the preview as well as on the apply, which keeps "the
preview matched what was applied" true for a partial selection as well as for the whole one.

Three consequences worth stating. A re-cost returns only the selected people, so the _list_ is
deliberately not adopted from it — replacing it would make an unticked row vanish rather than stay
unticked, which is the opposite of what a checkbox means. Editing any filter discards the selection along
with the preview, because a selection made against a different set of people would apply yesterday's
exceptions to today's filters. And beyond a cap of 500 the individual changes are not listed at all: nobody
reviews nine thousand checkboxes, so the honest answer is "narrow the filters", and the alternative is a
payload the whole design avoids.

The selection can only ever narrow. The service intersects it with what the filters and the access scope
already allowed, so naming an id outside those changes nothing rather than reaching it — and there is a
test for exactly that.

## One filter, six outcomes, two screens

`GET /api/employees?bandFit=BELOW` is what makes the counts on the pay-bands screen clickable. It is the
same predicate that produced the count, from the same `bandFitCondition` — so the number and the page it
links to cannot be different sets of people, and a test asserts they are equal for every outcome.

The names are the same six as `BandFit` on a person's row, and the labels are shared between the chip and
the filter in one module. If the filter said "Under band" and the chip said "Below band", a reader would
have no way to know they meant the same thing.

**One bug this uncovered, worth recording.** The count query that runs on an empty page was
`SELECT count(*) FROM employees e` with no joins, on the reasoning that counting needs none. That held only
because every filter condition happened to touch `e` alone. The band filters are written against
`current_pay` and `b`, so the bare version compiled fine and failed at run time on any band filter matching
nothing — precisely the empty page that query exists to serve. It now shares the list's FROM, which makes
"what can be filtered on" one question rather than an implicit assumption in two places.

## Access control lives at the data layer

`buildAccessScope(user)` returns a database filter. Every read path applies it.

**Why not route guards:** guards stop people _doing_ things. A Manager denied edit access could still
open the dashboard and read company-wide averages, because that is only reading. A filter at the data
layer covers every path, including ones added later.

**Consequence accepted:** Managers and Employees are refused the statistics pages outright rather than
being shown statistics narrowed to their team. An average over three people is not meaningful and
effectively discloses individual salaries. The navigation hides what a role cannot open, so this reads as
a smaller app rather than a wall of errors.

## Access control is checked by machine, not by habit

The design above has one weakness, and it is not in the design: it is a habit. Every endpoint applies the
scope because whoever wrote it remembered to, and every one of them has a test — which is exactly the
evidence that says nothing about the _next_ endpoint. Nothing was removed when a route shipped without a
guard, so nothing failed, and a review of that diff would see a new endpoint that looked like all the
others.

Two tests close it, and both work by **discovery** rather than by a list somebody maintains.

`tests/http/routeInventory.test.ts` reads every route off every router module and requires each to appear
in a table classifying it: public, authenticated, HR, HR Admin, or the refresh cookie. A new endpoint —
a new method on an existing router, or a whole new router file — turns up in that list on its own and
fails the first assertion until somebody has said what it is for. The classifications are then exercised
rather than trusted: anonymous calls must be refused, a Manager must be refused an HR-only route, HR
Viewer must be refused every write, and HR Admin must be refused none of them. That last one matters more
than it looks: without it, the whole table could be satisfied by guarding everything against everybody.

Writing it found two places where the table I wrote disagreed with the code — and the code was right both
times. `POST /api/auth/logout` is deliberately public, because logging out with an expired token would
otherwise fail and leave somebody signed in to a session they asked to end. `GET /api/employees/export` is
deliberately reachable by any signed-in user, because it is the list they are already looking at with the
paging removed; restricting the file but not the screen would mean the two disagreed about who may see
what, and the version somebody trusts is whichever they used last. Both are now written down where the
next person will find them.

`tests/repositories/queryScope.test.ts` does the same for the queries, which is where the rule actually
lives. Every exported query builder must be classified:

- **Scoped** — takes an `AccessScope`, and must put it in the SQL. Asserted on the _generated statement_
  rather than the source, so a builder that accepts a scope and then ignores it fails; and the statement
  for an Employee must differ from the one for HR, which is the failure that would look completely correct
  in a review.
- **Aggregate** — takes no scope, because the endpoint is HR-only. It must therefore name nobody: no
  `full_name`, no `email`. A query with no scope that returns individuals is one route mistake away from
  disclosing the payroll, and the route mistake is the easy one to make.

Neither test knows anything about which files exist. That is the point: forgetting is what they are for.

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
calls it changes: `src/shared/cache.ts` exists as a seam for exactly that. Its cost, stated honestly, is a
service to operate, a network hop on every miss, and a new failure mode — the cache being unreachable —
which the current design cannot have.

Two things would still not be cached in Redis: employee and salary data, for the reasons above, and
anything a stale read would make wrong.

**Statistics are not cached either.** Each runs in roughly 20–30 ms at this size (measured, see
[performance.md](performance.md)), and a cache would let the
dashboard show stale figures immediately after a raise. If the benchmark shows otherwise, cache then.

**What happens at 100,000 people**, since "cache later" is not a plan. Almost all of that 20–30 ms is the
lateral lookup that finds each person's current salary, and it is proportional to the number of employees
— so ten times the company is roughly ten times the query, and the dashboard lands near a second. The
answer at that size is not a cache: it is a `current_compensation` projection, one row per employee,
maintained as part of the same transaction that writes a pay record. That turns the lateral into an index
scan, and it cannot go stale after a raise the way a cached figure can. It is a schema change rather than
an optimisation, which is why it is not here yet — but it is the shape of the next step, and the append-only
table remains the source of truth underneath it.

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

**An intermittent failure, and what it turned out to be.** For a while the full suite failed roughly one
run in four, in a different test each time: a twenty-second timeout, a response with an empty body, and
eventually a `404` from statically registered routes — `GET /api/stats/overview`, then
`PATCH /api/employees/:id/status` for an id that certainly existed. That last symptom is the one that named
it, because a 404 from a route that is definitely registered, for a row that is definitely there, means the
request reached **a different app** — and each test file has its own app over its own database.

Handed an Express app, supertest starts a throwaway server on an ephemeral port for _every request_ and
closes it afterwards: thousands across a run. The operating system reuses those ports, and since Node 19 the
global HTTP agent pools sockets by host and port — so a pooled socket can point at a server that has closed,
or at one that has since been given the same port by another test file in the same worker. A socket to a
dead server hangs; one closed mid-response yields no body; one delivered to another app answers 404 for a
route that app never had.

The fix is to stop creating servers: each harness now listens once on a port it holds for its lifetime, and
closes it before the database. Keep-alive is disabled alongside it, which is the pair rather than a second
fix — with reuse on, a response leaves its connection open and `server.close()` waits for it, turning
closing a harness into a hang.

Two things came out of chasing it that are worth keeping regardless. `bodyOf` now refuses an _empty_ JSON
object and names the status, content type and raw text: supertest represents "no body" as `{}`, so the
original failure read as a wrong figure rather than an absent response, which is most of why it took so long
to place. And argon2's cost parameters are injectable, so the suite hashes cheaply — the parameters live in
the hash string, so `verifyPassword` reads them back and the login path under test is unchanged, while
production passes nothing and gets the library's own.

Both of those were also **wrong theories** before the real cause turned up, and that is the part worth
recording. Argon2 was plausible and measurably not it: cheap hashing changed the suite's wall time by under
a second. Worker contention was plausible and the failure survived `--maxWorkers=2`. Each explanation
accounted for the timeout and the empty body comfortably enough to stop looking, and neither could account
for the 404 at all — which is exactly why the symptom that fits nothing is the one to chase.

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
