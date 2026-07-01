---
name: Drizzle sql`` template columns render UNQUALIFIED
description: Why correlated count subqueries in drizzle sql templates silently return 0, and the join-based fix.
---

A bare `${table.column}` interpolated into a drizzle `sql`...`` template renders
as just `"column_name"` — **unqualified** — not `"table"."column"`. (The query
builder's own refs like `orderBy(asc(t.name))` DO qualify, so it's easy to assume
templates do too. They don't.)

**The trap:** a correlated count subquery like
`sql\`(select count(*)::int from ${usersTable} where ${usersTable.companyId} = ${companiesTable.id} and ...)\``
renders as `... from "users" where "company_id" = "id" ...`. Inside `from "users"`,
the unqualified `"id"` resolves to `users.id`, NOT the outer `companies.id`. So the
correlation compares `users.company_id = users.id` — never true — and the count is
**always 0**, with no error. A hand-written raw-SQL check that qualifies the columns
(`u.company_id = c.id`) passes and masks the bug.

**Why:** discovered when Super-User "Company Limits" usage showed 0/1 managers and
0 devices for every company despite real rows existing. `.toSQL()` on the query
revealed the unqualified `"id"`.

**How to apply:**
- Never rely on correlated subqueries built from bare column interpolation in a
  drizzle `sql` template for cross-table correlation.
- Prefer LEFT JOIN + `groupBy(parent.id)` with
  `(count(distinct ${child.id}) filter (where ...))::int`. count(distinct) makes
  multiple left-joins to different children (users AND devices) safe against
  cartesian fan-out.
- When a count "always returns 0" but raw qualified SQL returns the right number,
  print `query.toSQL()` first — the generated SQL is the source of truth, not the
  template you wrote.
