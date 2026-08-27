# Preserve Established SQL As Saved Query Evidence

Use this mode when the user supplies SQL that the business already relies on.
The outcome is a standard Saved Query that existing OKF MCP search and
`get_concept` can return as evidence for later SQL assembly. Do not introduce a
sidecar manifest, custom frontmatter, or an Attested Computation without a real
executor and attester.

## Minimum Input

For each query require:

- the business question or recurring use it answers;
- one complete, single-source, read-only statement that can execute as supplied;
- which literal values are intended to vary, if any.

Accept pasted SQL, a file, or a directory. The user describes the purpose in
conversation; they do not author Bundle Markdown. If a supplied statement has
placeholders, request one filled, executable example before proposing a Saved
Query.

Treat only user-identified values as parameters. A status predicate, tenant
restriction, soft-delete condition, or other literal may be fixed business logic.
Do not infer that it varies merely because it could.

## Inventory And Proposal

Match an existing Saved Query by business purpose, output grain, fixed population,
and SQL logic. Update it in place when those match; a filename or title match is
not enough.

Before writing, show:

```markdown
| Action | Saved Query | Purpose and grain | Parameters | Verification |
| --- | --- | --- | --- | --- |
```

Also show the exact executable SQL and any unresolved parameter type, timezone,
enumeration, or fixed-versus-variable decision. Do not execute or write until the
user approves that proposal.

## Standard Concept Shape

Use the existing Saved Query contract only:

- `type: Saved Query`, searchable title, description, and useful aliases;
- `semantic.profile: dbexplain-okf-v1`, `kind: query`, dialect, and every active
  physical table under `semantic.tables`;
- one `query_table` relation and one Markdown link for each table;
- exactly one closed fenced `sql` block containing the executable statement;
- current `process:dbexplain` verification for that exact statement.

Preserve established SQL logic. Do not rewrite it merely to normalize aliases,
quoting, JOIN order, predicates, or formatting. Changes required for safety or
validation belong in the proposal and require renewed approval.

Project the reusable evidence into the Markdown body:

```markdown
# <business query title>

<What this query answers and the fixed business population it implements.>

**Output grain:** <what one row represents>

## Parameters

None. Use the SQL unchanged for the documented business question.

## Output

| Column | Business meaning |
| --- | --- |

## Physical evidence

* [Table](<bundle-local-table-link>)

## SQL

<the single fenced sql block>
```

For a query with variable values, replace the `None` sentence with:

```markdown
| Name | Business meaning | SQL occurrence | Type and shape | Example input | SQL literal and rendering |
| --- | --- | --- | --- | --- | --- |
```

Every parameter row must make later SQL assembly deterministic:

- `SQL occurrence` identifies the predicate or expression and the exact example
  literal being replaced; list every occurrence when one value is reused.
- `Type and shape` gives a logical scalar type or `list<type>` and, when proven
  by a Table binding, the physical column type. Ask the user when an expression
  or missing binding leaves the type ambiguous.
- `Example input` is the user-facing value. `SQL literal and rendering` shows the
  exact executable literal plus quoting, escaping, precision, date/time format,
  timezone, or non-empty list expansion rules.
- Enumeration values and ranges require user confirmation or an explicit column
  comment. Do not infer them from observed rows.

State immediately below the table: `Examples document representation only; they
are not defaults. Missing current values require user clarification.`

Document explicit SELECT aliases and their user-confirmed meaning. Mark an
undocumented output as such instead of guessing. A few missing output descriptions
do not block preserving otherwise valid query evidence.

## Verify And Write

After approval, execute the exact normalized SQL through dbexplain on the single
bound label. If it succeeds, record the existing verification shape:

```yaml
verified:
  by: process:dbexplain
  at: "<UTC datetime>"
  method: dbexplain_execute
  statement_sha256: sha256:<LF-normalized SQL digest>
  instance_label: <single label>
```

The executable example and its literals remain in the Saved Query. Reject or ask
for a safe replacement when they contain credentials, tokens, hosts, DSNs, or
sensitive personal values. Never store result rows.

Rebuild overlay indexes and run adapter plus strict-link validation. Search the
business purpose and at least one alias to confirm MCP retrieval will find the
Saved Query.
