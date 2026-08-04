# Requirements — ACME Salary Management

Written before any code. Persona: **HR Manager at ACME**, 10,000 employees across several countries,
currently managing salaries in Excel.

## Goal

Replace the spreadsheet with a system that does two things Excel does badly at this size:

1. **Keeps salary data correct** — one record per person, a full history of every change, and a note of
   who changed what. A spreadsheet has no history and no audit trail; the previous number is simply
   overwritten.
2. **Answers questions about how the company pays people** — medians by department, cost per country,
   who is paid below their band, how payroll has moved over time. In Excel each of these is a fresh
   pivot table someone has to rebuild and get right.

Success looks like: an HR Manager opens the app, filters to a country, sorts by salary, opens a person,
records a raise, and sees the dashboard change — without exporting anything to a spreadsheet.

## Scope

**Employee and salary records**
- Employee directory: search, filter by country / department / level / status, sort, paginated.
- Employee detail with full salary history.
- Record a raise or adjustment, effective from a chosen date, with a reason and an author.
- View the whole company **as it stood on any past date**.

**Answering questions**
- Dashboard: headcount, total payroll cost, median salary, salary distribution, cost by department and
  country.
- Salary bands per level per country, with a compa-ratio per person.
- A "needs attention" list: everyone paid below their band, ordered by the cost to fix.
- Gender pay-gap analysis, compared within the same level and country, with small groups suppressed.

**Working with the data in bulk**
- CSV import with a dry-run preview — the migration path off the existing spreadsheets.
- CSV export of the current filtered view.
- Bulk raise cycle: preview the total cost and who would exceed their band, then apply.

**Access**
- Email and password login. Four roles: HR Admin (everything), HR Viewer (read all), Manager (own team
  only), Employee (own record only).
- Every read is restricted to what the signed-in user is allowed to see, including exports and
  statistics.

## Deliberately left out

| Not building | Reason |
|---|---|
| Approval workflows for raises | Needs states, notifications and a delegation model. Real requirement, but a project of its own. The audit trail already records who made each change. |
| Payroll processing, payslips, tax | A different product with statutory rules per country. This system holds what people are paid, not the act of paying them. |
| Bonuses, equity, benefits | The questions asked here are about base salary. Adding three more money types triples the model without changing what the HR Manager can answer. |
| Excel `.xlsx` import/export | CSV covers moving data in and out, and every spreadsheet tool reads it. A parser for a proprietary format is cost with no new capability. |
| Historic exchange rates | One dated snapshot of rates. Past totals are therefore shown at current rates, and the UI says so. Rate history mainly matters for financial reporting, which is out of scope. |
| SSO and two-factor auth | Deployment-level concerns that depend on ACME's identity provider. |
| Currencies without 2 decimal places | Yen has none, Kuwaiti Dinar has three. Supporting them means a per-currency exponent through every calculation. Supported set: USD, EUR, GBP, INR, CAD, AUD. |
| Org chart visualisation | Manager relationships are stored and used for access control, but not drawn. |

## Reasoning behind the main choices

**Salary history instead of a salary column.** Every salary is a dated record; the current one is the
most recent that has started. A single editable number loses the past on every raise, and the past is
what most of the questions above are about. This one decision also gives the audit trail and the
"as of any date" view for free.

**Money as whole cents, never decimals.** Decimal arithmetic in software is imprecise — adding 10,000
salaries drifts. Amounts are integers of the currency's minor unit, with a currency code alongside.

**Two separate ways to look at pay.** "What does this cost us?" converts to USD. "Is this person paid
fairly?" compares them to their **local** band in their own currency, never across countries — a
Bangalore engineer next to a San Francisco one looks underpaid in USD but is not, because pay is set
locally. Conflating the two produces confident wrong answers, so they are kept apart in the UI.

**Statistics computed in the database.** Medians, percentiles and distributions run over the whole
10,000 rows; sending that to the browser to aggregate is slow and gives every client a chance to
disagree. Postgres computes them and returns a handful of numbers.

**Access control at the data layer.** One function answers "which employees can this user see?" and
every read path applies it. Checks on routes alone stop people *changing* things, but a Manager could
still open a dashboard and read company-wide averages — that is only reading.
