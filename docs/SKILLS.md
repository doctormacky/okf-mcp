# Built-in Agent Skills

[English](SKILLS.md) · [简体中文](SKILLS_ZH.md)

okf-mcp ships five independent Skills under `.agents/skills/`. Install any one or
any combination. No Skill assumes another is installed, and there is no runtime
handoff between Skills.

## Capability Catalog

| Skill | Independent responsibility | Example request |
| --- | --- | --- |
| [okf-dbexplain](../.agents/skills/okf-dbexplain/) | Generate or refresh a physical-facts Bundle from a database | “Preview and sync prod-main tables, columns, and foreign keys” |
| [okf-bundle-business](../.agents/skills/okf-bundle-business/) | Add or correct Business knowledge in a query-ready Bundle | “Add buyer aliases to Customers and document order-state codes” |
| [okf-nl2sql](../.agents/skills/okf-nl2sql/) | Turn business questions into single-source read-only SQL and real results | “What were net sales after refunds by store last month?” |
| [okf-knowledge-publisher](../.agents/skills/okf-knowledge-publisher/) | Preview, confirm, and publish a central OKF snapshot | “Dry-run this workspace and wait for approval before publishing” |
| [okf-v02-migration](../.agents/skills/okf-v02-migration/) | Check and migrate legacy OKF v0.1 content | “Preview this catalog's v0.2 migration” |

These capabilities can participate in a larger workflow, but composition is a
user or Agent Host decision, not an installation dependency. A Skill reports a
missing capability directly instead of assuming another Skill is available.

## `okf-dbexplain`

Use for first-time or refreshed physical facts: Table SQL bindings, column
comments, declared foreign keys, inferred candidates, and observations. It does
not edit Business knowledge or answer live business questions.

```text
$okf-dbexplain
Inspect prod-main and preview a sync to /data/okf/my-database
```

Key constraints:

- dbexplain v0.1.11 or newer is on `PATH`;
- never read database config or collect sample rows;
- preview with `sync --dry-run`, wait for approval, then apply the same digest;
- preserve existing Business overlay bytes;
- finish with `okf dbexplain validate` and report physical facts and gaps.

## `okf-bundle-business`

Use only when the user explicitly wants knowledge artifacts changed. It supports
Datasets, field aliases/synonyms, Terms, Enums, Relationships, Metrics, Policies,
and Saved Queries. Requests for counts, trends, rankings, or live detail results
are not Business-authoring requests.

```text
$okf-bundle-business
Inventory /data/okf/my-database, add buyer aliases to Customers, and project
the explicit order-state codes from the column comment. Propose before writing.
```

Core workflow: inventory → update/create proposal → explicit approval → apply →
`overlay-index` → validate.

Key constraints:

- update the existing Concept for the same physical binding or business meaning;
- table and column comments are primary physical evidence, but ambiguous meaning
  still requires user confirmation;
- aliases, descriptions, Terms, and explicit Enums do not require example SQL;
- Saved Queries and SQL-backed Metrics require exact SQL execution verification;
- never hand-edit overlay indexes or store result rows in the Bundle.

## `okf-nl2sql`

Use for business users who do not know the schema. It searches OKF Business and
comments first, falls back to bounded no-sample dbexplain discovery when needed,
then executes read-only SQL on one label.

```text
$okf-nl2sql
What were net sales after refunds by store last month, highest first?
```

Key constraints:

- search with one or two atomic terms because OKF lexical search is all-term AND;
- table comments identify subjects; column comments retrieve measures,
  dimensions, time fields, and explicit enumerations;
- `process:dbexplain` proves execution, not human review of business meaning;
- establish base grain and prevent reverse one-to-many or multi-fact fanout;
- keep every table on one label and execute one `SELECT` / `WITH ... SELECT`;
- return only verified business results and material limitations; keep SQL,
  physical identifiers, evidence, and execution metadata internal;
- render the result as Markdown, using a Markdown table for multi-row results.

## Independent Installation

Copy or link only the Skill directories needed by an Agent Host. For example:

```bash
ln -sfn "$PWD/.agents/skills/okf-nl2sql" "$AGENT_SKILL_ROOT/okf-nl2sql"
```

Create separate links when installing several Skills. `agents/openai.yaml` is
optional host metadata, not a portable Skill runtime dependency.

## Evaluation Assets

All three database Skills include:

- `evals/trigger-queries.json`: customizable invocation queries. `okf-nl2sql`
  ships one generic template for users to replace with their own business
  question; the authoring Skills keep balanced trigger/near-miss sets;
- `evals/output-scenarios.json`: observable behavior cases for comments, trust,
  fanout, inferred relationships, and in-place updates as applicable.
  `okf-dbexplain` focuses on fact exactness, plan drift, incomplete collection,
  unsupported kinds, and overlay preservation.

Customize generic templates for the target business, then run every trigger
query at least three times in each actual Agent Client and
record whether the Skill was loaded. The host decides how to run evaluations;
the Skills do not bind evaluation to one model or CLI.
