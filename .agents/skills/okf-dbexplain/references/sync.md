# Synchronize The Database Bundle (Facts Only)

Use for build or refresh of the **physical layer**. Human-owned Business overlays
are outside this workflow.

## Inspect

```bash
command -v dbexplain && dbexplain --version
command -v okf && okf --version
okf dbexplain inspect --include <label>
okf dbexplain check --include <label>
```

Minimum dbexplain version: `v0.1.11`. Newer versions are accepted when the
required `list/check/collect` JSON contract remains compatible.

Supported SQL kinds: `mysql`, `postgres`, `gaussdb`, `sqlite`, `oracle`.

## Preview And Apply

```bash
okf dbexplain sync \
  --include <label> \
  --bundle-root <absolute-bundle-dir> \
  --generated-at <UTC-with-seconds> \
  --dry-run
```

Wait for approval, then:

```bash
okf dbexplain sync \
  --include <label> \
  --bundle-root <absolute-bundle-dir> \
  --generated-at <same-UTC> \
  --expect-plan <sha256:digest>
```

## What sync produces

| Path | Purpose |
| --- | --- |
| `tables/` | Executable SQL bindings, columns, comments |
| `relationships/declared/` | Foreign keys |
| `relationships/inferred/` | Unverified candidates |
| `observations/current.md` | Core tables, clusters, topology, diagnostics |
| `business/`, `queries/`, … | Reserved empty indexes — authoring templates stay in Skills |

## Verify

```bash
okf dbexplain validate --bundle-root <absolute-bundle-dir>
```

Restart okf-mcp after sync to re-index.

## overlay-draft / overlay-index

**Not part of this skill.** Overlay authoring is an independent capability.

- `okf dbexplain overlay-draft` creates **missing** datasets/relationships only
  (never overwrites existing overlay Concepts) and refreshes overlay `index.md`.
- `okf dbexplain overlay-index --bundle-root <dir>` rebuilds overlay `index.md`
  catalogs after queries or titles change. First sync already creates empty
  index pages; do not hand-edit them.
