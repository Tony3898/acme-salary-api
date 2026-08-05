# Requirements — ACME Salary Management

Written before any code. Persona: **HR Manager at ACME**, 10,000 employees across several countries,
currently managing salaries in Excel.

## Goal

Replace the spreadsheet with a system that does two things Excel does badly at this size:

1. **Keeps salary data correct** — one record per person, and a full trail of every pay change: the
   amount, the date it took effect, who recorded it and why. A spreadsheet keeps none of that; the
   previous number is simply overwritten. Salary records are only ever added, never edited, so the trail
   cannot be quietly rewritten either.
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

## Left out of this version, and where each goes next

Nothing here is an oversight. Each was considered, left out to keep this version answerable, and has a
route back in — third column.

| Not in this version                  | Why not now                                                                                                   | How it comes back                                                                                                                      |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Approval workflows for raises        | Needs states, notifications and delegation. A project of its own, and every pay change is already attributed. | A `status` on the salary record plus an approver. The record is already append-only, so nothing has to be restructured.                |
| Payroll processing, payslips, tax    | Statutory rules per country. This system holds what people are paid, not the act of paying them.              | Integrate, don't build. The CSV export is the handover point to a payroll provider.                                                    |
| Bonuses, equity, benefits            | The questions here are about base salary. Three more money types triples the model without new answers.       | A `pay_component` type on the salary record, since it already carries an amount, a currency and a date.                                |
| Excel `.xlsx` import/export          | CSV covers moving data in and out, and every spreadsheet tool reads it.                                       | A parser at the edge of the import route. The validation and preview behind it stay unchanged.                                         |
| Historic exchange rates              | One dated snapshot. Past totals are shown at current rates, and the UI says so.                               | `fx_rates` gains an effective date and the read-time conversion picks the rate for `asOf`. Conversion is already one place.            |
| SSO and two-factor auth              | Depends on ACME's identity provider.                                                                          | Sits beside the password login as another way to obtain a token; the role and access model is untouched.                               |
| Currencies without 2 decimal places  | Yen has none, Kuwaiti Dinar has three. Supported set: USD, EUR, GBP, INR, CAD, AUD.                           | A minor-unit exponent per currency, applied in `domain/money.ts` — the only place that does the arithmetic.                            |
| Org chart view                       | Manager relationships are stored and used for access control, but not drawn.                                  | The recursive query behind access control already returns the tree; this is a UI addition only.                                        |
| A general audit log over every field | Pay changes are fully tracked. Changing a department, manager or level overwrites the column.                 | A trigger-written history table. Worth doing when someone needs "who moved this person to Sales", which nothing here asks.             |
| Interview scheduling, leave, budgets | A wider HR system, not salary management.                                                                     | Each is a self-contained slice reusing the access-scope function and the dated-record pattern. See [design-notes.md](design-notes.md). |

---

The reasoning behind each of these — and what each one costs — is in
[design-notes.md](design-notes.md). It is deliberately not repeated here: this page is what was
decided, that one is why.
