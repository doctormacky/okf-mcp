---
id: okf://okf-mcp/workflows/dbexplain-bundle-sync
type: OKF Generation Workflow
title: dbexplain Database Bundle Synchronization
description: Generates and continuously synchronizes a dedicated OKF v0.2 Bundle from configured SQL database metadata.
tags: [okf, dbexplain, database, generator, workflow]
relations:
  - type: related_to
    target: okf://okf-mcp/overview/okf-mcp
  - type: consumes
    target: okf://okf-mcp/specs/concept-format
  - type: configured_by
    target: repo://src/dbexplain.js
  - type: configured_by
    target: repo://src/cli.js
  - type: checked_by
    target: repo://test/dbexplain.test.js
---

# dbexplain Database Bundle Synchronization

The `okf dbexplain` command invokes dbexplain v0.1.11 or newer for read-only SQL metadata collection. Future versions are accepted while the required CLI/JSON capability contract remains compatible. It converts structured output into regular OKF Markdown, validates the complete candidate, and replaces one dedicated database Bundle through same-filesystem staging with ordinary-failure rollback. dbexplain configuration remains opaque to okf-mcp and is normally selected through dbexplain's existing `.env.dbexplain` discovery.

Every selected DSN needs a stable unique label. Readable Concept paths are derived from exact database object names (`tables/<label>/<namespace>/<table>.md`, `relationships/declared/<from>__<to>.md`). A hash suffix is added only when two identities would otherwise collide. Declared relationship identity uses ordered source and target endpoints rather than constraint names, so constraint renames update evidence without changing Concept paths. Naming-inferred references remain unverified draft candidates and never become approved business joins.

Query-ready generation accepts MySQL, PostgreSQL, GaussDB, SQLite, and Oracle and fails before writes for other selected kinds. Table Concepts carry binding v2, dialect-quoted sources and columns, physical schema, mechanical logical types and time roles, and Markdown links to first-class relationship Concepts. Relationship Concepts carry structured join templates, execution scope, and cardinality derived from physical unique keys. High-frequency Observation concepts stay separate from stable Table structure.

Physical catalogs use nested reserved indexes by instance and database. Human overlay directories contain reserved indexes only; authoring templates live in Skills and do not pollute runtime search. Concepts using `semantic.profile: dbexplain-okf-v1` project the same targets into ordinary top-level `relations` and Markdown links, so the domain-neutral okf-mcp graph and search work without profile-specific code. Missing database objects are deprecated rather than deleted, unchanged structural concepts retain their generation time, and raw captures, DSNs, hosts, credentials, configuration, and sample rows are excluded.

Synchronization is review-bound. Dry-run returns a structural plan digest without touching the target. Apply recollects the database and requires that digest. Observation-only drift may refresh, while structural, relationship, selection, version, generation-time, or target changes invalidate the plan and write nothing.

`observations/current.md` now surfaces dbexplain core tables, table clusters, topology subgraphs, isolated tables, and categorized diagnostics from `--context` output. `okf dbexplain overlay-draft` drafts missing `business/datasets/` and declared-FK `business/relationships/` for core tables (or `--all-tables` / `--limit`), copying enum codes only from explicit column-comment lists. Agent-generated Saved Queries require successful `dbexplain execute` verification plus user approval; unverified joins remain human-owned.

The bundled `okf-dbexplain` Skill coordinates runtime checks, source inspection,
connectivity checks, dry-run review, and digest-bound apply for the physical
layer. The `okf-bundle-business` Skill adds scoped business overlays afterward.
Any MCP-capable agent can then use the ordinary search, Concept, and graph tools
to retrieve SQL context; query execution remains outside okf-mcp.
