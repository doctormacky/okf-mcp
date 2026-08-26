---
name: okf-dbexplain
description: >-
  Generates or refreshes the facts-only physical layer of an OKF v0.2 database
  Bundle from dbexplain (inspect, check, sync, validate): tables, declared
  foreign keys, observations, and empty overlay scaffolds. Use when the user
  asks to sync a database into an OKF Bundle, run okf dbexplain sync, inspect
  or check SQL sources, refresh schema facts, or build a physical-only catalog.
  Do not use for business overlays, 语义层, NL2SQL, overlay-draft, answering data
  questions, or executing SQL; after sync, use okf-bundle-business.
---

# Sync OKF Database Facts

Turn dbexplain metadata into a **facts-only** OKF Bundle: tables, declared and
inferred relationships, observations, and reserved overlay indexes.
okf-mcp can index this bundle for schema retrieval immediately.

**Business semantics** (`business/datasets/`, `queries/`, …) are maintained by
`$okf-bundle-business` after the user defines scope. This skill does not run
`overlay-draft` or write overlay Concepts unless the user explicitly requests
physical-only troubleshooting.

## Standard Procedure

Read [references/sync.md](references/sync.md).

### Phase 0 — Preconditions

- Confirm `dbexplain` and `okf` on PATH; require dbexplain `v0.1.11` or newer.
- Resolve `--bundle-root` (absolute). Ask only if ambiguous.
- Preserve user source selector; never open database config files.

### Phase 1 — Inspect and check

```bash
okf dbexplain inspect --include <label>
okf dbexplain check --include <label>
```

### Phase 2 — Sync (review-bound)

```bash
okf dbexplain sync \
  --include <label> \
  --bundle-root <absolute-bundle-dir> \
  --generated-at <UTC-with-seconds> \
  --dry-run
```

Report counts, validation, changes, `planDigest`. **Wait for approval**, then:

```bash
okf dbexplain sync \
  --include <label> \
  --bundle-root <absolute-bundle-dir> \
  --generated-at <same-UTC> \
  --expect-plan <sha256:digest>
```

### Phase 3 — Validate physical layer

```bash
okf dbexplain validate --bundle-root <absolute-bundle-dir>
```

Deliver a **Facts Report**:

- Instances, tables, declared/inferred relationship counts
- `observations/current.md` highlights (core tables, clusters, diagnostics)
- Nested physical catalog indexes and any untouched legacy scaffolds removed
- Reminder: restart okf-mcp after sync to re-index
- **Next step:** use `$okf-bundle-business` when ready to add business overlays

## Hard Boundaries

- Never read or modify database configuration.
- Never install or upgrade dbexplain.
- Never collect with `--sample`; never put credentials or sample rows in the Bundle.
- **Never run `overlay-draft` or create `business/` Concepts** — that is
  `okf-bundle-business`.
- Never invent SQL, joins, or enum meanings.
- Sync preserves existing overlay bytes; only overlay indexes regenerate.
- A future dbexplain version is accepted when the required CLI/JSON contract still works;
  report `unsupported_dbexplain_contract` at the supplied GitHub Issues URL.

## Required Output

- Applied sync with `sql_binding.version: 2` on tables
- `join_binding` on declared relationships
- `validForProject: true` on validate
- Facts Report + pointer to `okf-bundle-business`

## References

- [references/sync.md](references/sync.md) — commands
- [references/semantic-overlay.md](references/semantic-overlay.md) — contract (for reading only)
- [references/overlay-authoring.md](references/overlay-authoring.md) — deferred to okf-bundle-business
