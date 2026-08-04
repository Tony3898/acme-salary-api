# AI prompt log

Claude Code (Opus) was used throughout, as a design reviewer during planning and as a pair while writing
code. This is a record of the prompts that changed the design, and where I disagreed with the output.

Kept in rough chronological order. Appended to as the build progresses.

---

## Planning

**Opening prompt**

> Read this assignment file, and let's plan the solution. Preferred tech stack: TypeScript with Node and
> React; Vite for the build; Tailwind and Material UI for the UI. Let's plan everything first.

Deliberately asked for a plan and nothing else. The first design that came back was over-built — it
included a stored USD amount on every salary row, a `current_compensation_id` pointer maintained
alongside the history, a persistent volume with seed-on-boot, and a full React Testing Library suite. All
four were cut. The stored USD amount and the pointer column were the same mistake twice: a second copy of
a value that can be derived, which will eventually disagree with the first.

**Asking for the reasoning to be defended, not the conclusion**

> Plain SQL over an ORM — [quoted the reasoning back] — I didn't get this. An ORM will be migration and
> injection safe, right?

The answer usefully separated two things I had conflated. Injection safety comes from parameterisation,
not from the ORM: an ORM does not help with the one genuine hole, which is a user-chosen `ORDER BY`
column, because SQL identifiers cannot be parameterised at all. Migrations were the real gap, and the
original reasoning had not addressed them.

> We are making a new app — what migration do we have to do? It's just that we add an import feature,
> and this import will add employees and their data.

This caught a drift in the argument: "we need migrations" had quietly started being used to justify a CSV
import feature. Importing rows changes no schema. The plan now says plainly that migrations change the
database *shape*, so seeding, importing and bulk raises need none — `drizzle-kit push` while building, one
generated migration at first deploy, real migrations after that.

> Let's keep the ORM from now, I am not seeing why to not have it.

I had argued for plain SQL. Reversed: with typed columns and no hand-written row mapping, and raw `sql`
still available for the statistics, the ORM earns its place — especially given this is plausibly the first
module of a wider HR system.

**Pushing back on hosting**

> What if we go EC2 only with an Express app?

The original plan was serverless. This was the better call and I took it: scale-to-zero saves nothing
when a database is running anyway, and a long-lived process removes cold starts, VPC plumbing, and
batching work around an API Gateway timeout. Local and deployed then run the same `docker-compose.yml`.

**Constraints I imposed on the output**

> I don't want inline styling at all.

Which rules out Material UI's `sx` prop, not just `style`. Resolved with a theme file plus `styled()`
components, Tailwind confined to plain HTML, and an ESLint rule that fails the build if either attribute
appears — adding a rule rather than trusting a convention.

> We will have pagination at the backend for 10k+ users and everything with proper caching of metadata
> and config, but not user data directly — I don't want to explode Redis with large storage of data.

This became the caching section, and the conclusion went further than the prompt: with only ~10 KB of
lookup data behind one server, Redis is not needed at all. The threshold for adding it is written into
the code comment.

> Also, writing all queries in one file will make that file hard to read in future.

Fair. The plan said "all SQL in one folder", which had read as one file. Now one file per area under
`repositories/`, split at around 200 lines.

**Where the model's critique changed my mind**

The pagination review found a bug I would have shipped: sorting by salary without `id` as the final tiebreaker.
Rows tied on salary can come back in a different order per request, so page 2 repeats people from page 1
and silently skips others. It also caught that `COUNT(*) OVER ()` returns *no rows* for an empty result
set, so `total` has to be defaulted to 0 rather than read from `rows[0]`. Both are now tests.

The other useful catch was on access control: I had it as route guards. Guards only stop people *doing*
things — a Manager blocked from editing could still open the dashboard and read company-wide averages,
because that is only reading. It moved to a single filter applied by every read path.

---

## Build

Working style: I ask for one step of the plan at a time, tests first, and read the diff before committing.
Notes below are only where the AI output needed correcting or where the exchange changed the design.

*(appended as the build proceeds)*
