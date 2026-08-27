# Concrete Examples

These examples illustrate reusable decisions across different domains. They are
not templates for a particular production database.

## 1. Orders And Customers: Update Before Create

Request: add “buyer” as a synonym for customer, document order states, and expose
the declared order-to-customer relationship.

Inventory finds:

- `business/datasets/customers.md` already binds the customer table;
- `business/datasets/orders.md` already binds the orders table;
- no Business Relationship exists for the declared foreign key.

Proposal:

| Action | Artifact | Reason |
| --- | --- | --- |
| update | customers Dataset | add `buyer` alias to the same binding |
| update | orders Dataset | project state codes from `state[1:pending,2:paid,3:cancelled]` comment |
| create | order-customer Relationship | missing Business projection of declared FK |

No SQL example is required because the request does not create a Saved Query or
SQL expression.

## 2. Device Events And Sites: Clarify Time Meaning

Request: enrich device events so analysts can group events by site and day.

The event table contains `received_at` (“gateway receive time”) and `occurred_at`
(“device event time”). The site foreign key is declared and executable.

The proposal asks which time represents the requested business day. It does not
ask the user to select a physical column. After the user chooses device event
time, update the Dataset field role and create the missing Business Relationship.

## 3. Support Tickets: Update A Metric In Place

Request: define “resolution time” as closed time minus opened time and add
“handling group” as a synonym for assignment group.

Inventory finds an existing resolution-time Metric on the same base Dataset.
Update that Metric's definition/expression and the existing assignment-group
field synonyms. Do not create a second Metric. Because the approved change
modifies an SQL-backed expression, execute a bounded verification query before
recording machine verification.

## 4. Fixed Operational Report: Preserve The SQL

Request: preserve the finance team's approved month-end reconciliation SQL. It
has no variable values and returns one row per account.

Inventory finds no query with the same purpose, grain, and fixed population.
Propose one new Saved Query. Keep the supplied JOINs, filters, aggregation, and
SQL formatting; document `Parameters: none`, the account output grain, and the
explicit result aliases. After approval, execute and store that exact statement.
Do not derive a reconciliation Metric or Relationship unless requested.

## 5. Parameterized Report: Executable Evidence, Not A Template Runtime

Request: preserve a commonly used order report where the supplied executable SQL
contains one store ID, a start/end date, and a list of order states. The user says
all four values vary while the paid-order and soft-delete predicates are fixed.

The Saved Query keeps the filled, executable SQL. Its Markdown parameter table
maps the four variable literals to their business meanings, proven types, list
shape, date format, timezone, and SQL rendering. It explicitly leaves the two
fixed predicates out of the parameter table and says examples are not defaults.

If the start/end columns have different time roles or the store ID type cannot be
proven, ask before proposing. Later NL2SQL can retrieve this evidence through MCP
and assemble current SQL without rediscovering the established JOIN and filters.

## Proposal Example

```markdown
Business proposal

| Action | Artifact | Existing target or new path | Evidence |
| --- | --- | --- | --- |
| update | Semantic Dataset | business/datasets/device-events.md | same physical table |
| create | Semantic Relationship | business/relationships/events-to-sites.md | declared executable FK |

Business definitions requiring confirmation: “day” means device event time.
SQL example and verification: not required for these artifact changes.
```
