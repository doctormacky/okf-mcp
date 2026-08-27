# Author Business Concepts

Read only the sections for artifact types in the approved proposal.

## Contents

- Shared projection rules
- Semantic Dataset and fields
- Semantic Relationship
- Business Term and Enumeration
- Metric and Policy
- Validation checklist

## Shared Projection Rules

For `semantic.profile: dbexplain-okf-v1`, maintain the same meaning in:

1. structured `semantic.*` for precise binding;
2. top-level `relations` for graph navigation;
3. Markdown body for generic search and human review.

Generic OKF search does not index arbitrary nested `semantic.*`. Put business
names, aliases, field synonyms, enum labels, metric meaning, and relevant links
in normal metadata/body. Preserve unknown frontmatter and existing human content.

## Semantic Dataset And Fields

- The description states the grain first, then supported business questions and
  material limitations.
- `semantic.physical_table` resolves to one active query-ready Table Concept.
- Each field `column` exists in that Table binding.
- Include only useful business fields; retain identity, time, state, major join,
  and explicitly requested fields.
- Set `dimension.is_time` only when the business time role is established.
- Use comment-defined enum codes exactly; ask for labels when comments are absent
  or ambiguous.

Example body projection:

```markdown
# Orders

One row represents one submitted order.

* [Physical table](/tables/prod/sales/orders.md)

| Business field | Physical column | Meaning |
| --- | --- | --- |
| order time | created_at | Time when the order was submitted |
| state | state | pending / paid / cancelled codes from the column comment |
```

## Semantic Relationship

Use exactly one source:

- an executable declared `physical_relationship`; or
- `semantic.join` whose endpoints, columns, meaning, and cardinality the user
  explicitly confirmed.

Do not promote `relationships/inferred/` into Business automatically. Link the
from/to Datasets and physical evidence in both `relations` and the body.

## Business Term And Enumeration

- A Term binds one business phrase and its aliases to explicit table/column
  targets. Do not turn a broad word into several unrelated bindings.
- An Enumeration preserves source codes. Labels require an explicit column
  comment or user confirmation.
- Shared code sets may live under `references/enums/`; project them into Dataset
  field documentation so they remain searchable.

## Metric And Policy

- A Metric states measure definition, base grain, expression, required
  relationships, filters, time semantics, unit, and null behavior when relevant.
- Expressions reference only the base table or proven required relationships and
  provide the matching dialect or `ansi_sql` form.
- A Policy states a concrete query restriction and links the affected physical
  scope. Do not infer soft-delete values, secrecy, or exclusions from convention
  alone.
- Execute an SQL-backed expression when verification is part of the approved
  proposal; execution is not human review of its business meaning.

## Validation Checklist

- [ ] Same meaning updates an existing Concept rather than creating a duplicate
- [ ] Grain and business definition are explicit
- [ ] Every table, column, relationship, and expression resolves
- [ ] Comments and user-confirmed meanings are not conflated
- [ ] Structured semantics, relations, and body project the same targets
- [ ] New/unreviewed claims remain `draft`
- [ ] Saved Query verification matches the exact SQL and label
- [ ] `overlay-index`, adapter validation, strict-link validation, and representative searches pass
