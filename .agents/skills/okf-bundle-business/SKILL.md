---
name: okf-bundle-business
description: Use this skill when the user wants to add or correct Business knowledge in an existing query-ready OKF database Bundle, including datasets, terms, enums, relationships, metrics, policies, or business-maintained executable SQL preserved as Saved Queries for later NL2SQL grounding. Inventory existing Concepts, propose reviewed changes, and update matching knowledge in place. Do not use for live database answers, physical schema synchronization, or publishing.
---

# Enrich OKF Business Knowledge

Add human-owned Business meaning to an existing query-ready database Bundle.
This Skill edits knowledge artifacts; it does not answer live data questions.

## Requirements

- Require a Bundle whose physical Table Concepts have SQL binding v2. If required
  physical facts are missing, report the exact missing tables, columns, or
  relationships; do not invent them or assume another Skill is installed.
- Use `okf` and, only when SQL verification is required, `dbexplain`. Check each
  command before first use; do not install software or read database config.
- Never guess a business definition, enum meaning, metric expression, join, row
  filter, user identity, or lifecycle status.

## Conditional References

- Read [discovery.md](references/discovery.md) to inventory existing Business and
  map requested meaning to comments and physical bindings.
- Read [authoring.md](references/authoring.md) only for the artifact types being
  created or changed.
- Read [saved-query-evidence.md](references/saved-query-evidence.md) when the user
  supplies established SQL to preserve as reusable NL2SQL evidence.
- Read [examples.md](references/examples.md) when a concrete proposal or Concept
  shape would help.

## Workflow

Progress:

- [ ] Inventory the current Bundle and matching Business
- [ ] Classify every change as update or create
- [ ] Present a reviewable proposal
- [ ] Wait for explicit approval
- [ ] Apply, rebuild indexes, and validate

### 1. Inventory

Validate the Bundle, inspect the relevant overlay indexes and full matching
Concepts, and follow their physical relations. Identify existing Concepts by
meaning and binding, not filename alone.

### 2. Propose

Show the user:

```markdown
Business proposal

| Action | Artifact | Existing target or new path | Evidence |
| --- | --- | --- | --- |

Business definitions requiring confirmation: <only unresolved decisions>
SQL example and verification: <only for a Saved Query or SQL-backed Metric>
```

Update a matching Concept in place. Create only missing meaning. A successful
validation or SQL execution is not approval to write.

### 3. Apply After Approval

- Edit existing human-owned overlay Markdown directly.
- Use `okf dbexplain overlay-draft --bundle-root <dir> --tables <scope>` only to
  create missing mechanically derived Dataset/Relationship drafts. It never
  updates existing files.
- For a Saved Query, execute the exact single-source read-only SQL successfully
  before recording `process:dbexplain` verification. Execution proves the SQL ran,
  not that the business definition is human-reviewed.
- Keep new or unreviewed claims `draft`; do not invent human verification.
- Never store credentials, host data, or result rows in the Bundle.

### 4. Validate

Run after every applied change:

```bash
okf dbexplain overlay-index --bundle-root <dir>
okf dbexplain validate --bundle-root <dir>
okf --root <dir> --strict-links validate
```

If validation fails, fix the proposed artifacts and repeat validation. Finish by
searching representative business terms and reporting updated/created paths.

## Gotchas

- `overlay-draft` skips existing artifacts; it is not an update mechanism.
- Never hand-edit overlay `index.md`; `overlay-index` rebuilds it.
- Generic OKF search ignores nested `semantic.*`; expose field names, synonyms,
  enum labels, and metric meaning in title/description/body.
- A table comment and column comments are primary physical evidence for drafting
  descriptions and fields, but ambiguous business meaning still needs user input.
- Inferred physical relationships are candidates, not approved Business joins.
- Business-maintained SQL is authoritative query evidence. Preserve its JOINs,
  filters, aggregates, and grain; do not redesign it or derive other Business
  Concepts unless the user explicitly asks.
- A parameterized Saved Query stores an executable example statement, not an
  unexecutable placeholder template. Its documented example values are never
  defaults for later NL2SQL questions.
- SQL examples are unnecessary for aliases, descriptions, terms, and explicit
  enum enrichment unless those edits also create a Saved Query or SQL expression.
