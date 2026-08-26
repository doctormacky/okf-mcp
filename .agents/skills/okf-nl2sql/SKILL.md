---
name: okf-nl2sql
description: >-
  Use this skill when the user wants an actual answer from a SQL database in
  business terms, including totals, counts, trends, rankings, comparisons, or
  bounded detail, even when they do not know the tables, columns, SQL dialect,
  or data-source label. Retrieve relevant OKF knowledge, assemble single-source
  read-only SQL, execute it through dbexplain, and return verified business
  results without exposing the SQL. Do not use for database writes, schema
  synchronization, knowledge authoring,
  NoSQL, or questions that do not require live data.
---

# Answer Business Questions With SQL

Use OKF knowledge first, then bounded database discovery only when the knowledge
is insufficient. The user supplies business intent, not physical schema names.

## Requirements

- Discover the available MCP tools that expose `list_bundles`,
  `search_concepts`, and `get_concept`; use the fully qualified names provided by
  the current host. Do not assume an MCP server namespace.
- Before the first CLI call, run `command -v dbexplain` and
  `dbexplain --version`; require v0.1.11 or newer. Report a missing capability
  without installing software.
- Never read or edit database configuration, request credentials, construct a
  command-line DSN, use `--sample`, or write to the database or Bundle.
- Keep SQL, query plans, physical identifiers, commands, and execution receipts
  internal. Never expose them in the final answer.

## Workflow

Progress:

- [ ] Frame the business intent
- [ ] Retrieve and ground every required concept
- [ ] Build and validate a query plan
- [ ] Execute one read-only query
- [ ] Verify and report the result

### 1. Frame Intent

Identify measure, entity, dimensions, time range, filters, and output grain.
Ask only about business ambiguity that changes the answer. Never ask the user to
choose a table, column, JOIN, dialect, or label.

### 2. Retrieve Evidence

Read [retrieval-and-grounding.md](references/retrieval-and-grounding.md) when
the first knowledge hit does not uniquely ground every required intent slot.
Read full Concepts before using their bindings; compact search summaries are
discovery results, not SQL evidence.

Prefer existing Bundle evidence. If required physical facts are absent or stale,
read [live-database-discovery.md](references/live-database-discovery.md). If no
executable or semantic relationship exists and an inferred candidate is needed,
read [inferred-join-validation.md](references/inferred-join-validation.md).

### 3. Plan And Validate

Create an internal query plan containing:

```text
business meaning | source Concept/comment | base grain | measure | dimensions
time/filter semantics | physical tables/columns | joins | policies | label
```

Do not execute until all required entries have evidence and these checks pass:

- all physical identifiers come from current bindings or live metadata;
- every table uses one `instance_label` and one dialect;
- the base fact grain is explicit and JOINs cannot multiply it;
- reverse one-to-many inputs and multiple fact tables are pre-aggregated before
  joining at the requested grain;
- applicable Policy Concepts have been checked;
- SQL is one `SELECT` or `WITH ... SELECT`, has explicit columns and bounded
  detail, and contains no `SELECT *`, write operation, or `EXPLAIN ANALYZE`.

### 4. Execute And Verify

Execute JSON output with the grounded label:

```bash
dbexplain execute --label <label> --limit <bounded-result-limit> --timeout 30 '<sql>'
```

Use SQL aggregates for every quantitative claim. Check `columns`, `rows`,
`row_count`, `truncated`, `execution_time`, and `stripped_columns`.

On a binding/schema error, refresh the affected evidence and make at most one
equivalent repair. Do not repair business ambiguity by guessing. Do not bypass
`ACCESS_DENIED`, widen an empty query, or increase timeout automatically.

### 5. Return The Answer

Return only the verified business result as rendered GitHub Flavored Markdown,
using the user's language. Do not wrap the answer in an outer code fence.

- Lead with the direct business answer in a short sentence.
- For a single value, keep the result in prose; do not create a one-cell table.
- For multiple rows or dimensions, use a Markdown table with business-facing
  column labels. Use a bulleted list only when the result is naturally a short
  non-tabular list.
- Put only material result or coverage limitations after the result in a
  Markdown blockquote. Omit the blockquote when there is no limitation.
- Do not return raw JSON, CSV, an ASCII table, or HTML.

Do not include the SQL statement or fragments, a SQL code fence, the dbexplain
command, the internal query plan, physical identifiers, Concept URIs, the
instance label, or execution metadata. Evidence and execution details support
the answer internally; they are not part of the user-facing result. If no
verified result was produced, state the blocker concisely without showing the
attempted SQL or guessing an answer.

## Gotchas

- OKF lexical search requires every query term. Search with one or two atomic
  business terms, not the complete natural-language question.
- Table comments are indexed in the Table description; column comments appear in
  the Table body and SQL binding. Comments are strong retrieval evidence, not
  automatic proof of an ambiguous business definition or JOIN.
- `process:dbexplain` proves that exact SQL executed; it does not prove that its
  business definition was human-reviewed.
- `join_binding.executable: true` means a same-label declared foreign key with a
  unique target key. It does not mean human review.
- A truncated detail result cannot support claims about all rows, uniqueness, or
  a complete ranking.
