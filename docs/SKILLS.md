# Built-in Agent Skills

[English](SKILLS.md) · [简体中文](SKILLS_ZH.md)

okf-mcp ships four Skills under `.agents/skills/`. For database NL2SQL you typically use **three** in order:

```text
okf-dbexplain  →  okf-bundle-business  →  (optional) okf-knowledge-publisher
```

Register the skill directory in your agent host (Cursor: Settings → Rules / Skills, or project `.agents/skills/`).

---

## okf-dbexplain — Sync physical facts

**Path:** [.agents/skills/okf-dbexplain/](../.agents/skills/okf-dbexplain/)

### When to use

| Use | Do not use |
| --- | --- |
| First-time Bundle from a live database | Business semantics, NL2SQL answers |
| Refresh tables / FKs / observations after schema change | `overlay-draft`, writing `business/` |
| `okf dbexplain inspect`, `check`, `sync` | Guessing joins, enums, or SQL |

### Prerequisites

- [dbexplain](https://github.com/IamWWT/dbexplain) v0.1.11 or newer installed and on `PATH`
- User-maintained `.env.dbexplain` (Skill does **not** read or edit it)
- Target `--bundle-root` directory (absolute path)

### How to invoke

```text
$okf-dbexplain
Please inspect prod-main and sync to /data/okf/my-database
```

### What the Skill does

1. `okf dbexplain inspect --include <label>`
2. `okf dbexplain check --include <label>`
3. `okf dbexplain sync ... --dry-run` → report plan → wait for approval
4. `okf dbexplain sync ... --expect-plan <digest>` apply
5. `okf dbexplain validate --bundle-root <bundle>`
6. Facts Report + reminder to restart MCP + hand off to `$okf-bundle-business`

### Outputs (physical layer only)

- `tables/` — column facts from dbexplain
- `relationships/declared/` — declared FKs
- `observations/current.md` — topology / diagnostics summary
- Empty reserved overlay indexes (`business/*/index.md`, `queries/index.md`); templates stay in the Skills

Re-sync updates physical files; existing `business/` and `queries/` bytes are preserved.

---

## okf-bundle-business — Author business overlays

**Path:** [.agents/skills/okf-bundle-business/](../.agents/skills/okf-bundle-business/)

### When to use

| Use | Do not use |
| --- | --- |
| Add/update datasets, joins, enums, saved queries | Physical schema sync (`okf-dbexplain`) |
| NL2SQL / natural-language query semantics on an existing Bundle | Guessing without user confirmation |
| After `$okf-dbexplain` sync is done | Running SQL against production |

### Prerequisites

- Bundle already synced by `$okf-dbexplain`
- Clear business question from the user (who, metric, time range, filters)

### How to invoke

```text
$okf-bundle-business
Bundle: /data/okf/my-database
label: prod-main
Task: total token usage for user XXXX in May 2026
Propose the logic and example SQL first; write only after I approve.
```

### Confirmation loop (every time)

```text
R1  Probe Bundle + dbexplain + inventory existing business/queries
R2  Logic proposal + example SQL → wait for explicit approval
R3  Update existing files OR overlay-draft new ones → overlay-index
R4  Coverage report (adapter validate + search)
```

### Key commands (agent runs these)

```bash
# Probe (read-only)
okf dbexplain inspect --include <label>
okf --root <bundle> search "token"

# Create missing physical-backed overlays (scoped only)
okf dbexplain overlay-draft --bundle-root <bundle> --tables <table> ...

# After any business/queries write — mandatory
okf dbexplain overlay-index --bundle-root <bundle>
okf dbexplain validate --bundle-root <bundle>
```

### Hard rules

- **Update in place** when the same table / query / join already exists
- `overlay-draft` **never overwrites** existing dataset or relationship files
- **No write before approval**
- Maintain matching `semantic`, top-level `relations`, and Markdown links/body text
- Agent-generated Saved Queries require successful `dbexplain execute` verification
- **Do not hand-edit** `business/*/index.md` or `queries/index.md` — use `overlay-index`

---

## okf-knowledge-publisher — Publish central knowledge

**Path:** [.agents/skills/okf-knowledge-publisher/](../.agents/skills/okf-knowledge-publisher/)

### When to use

| Use | Do not use |
| --- | --- |
| Publish/update team-wide OKF catalog on a **hosted** server | Local database Bundle sync |
| Download → edit → dry-run → submit via `okf knowledge` | Direct HTTP to rollout API |
| Verify published content via remote MCP | Replacing `$okf-bundle-business` for DB semantics |

### Prerequisites

- `okf hosted` server running with `OKF_READ_TOKEN` / `OKF_ROLLOUT_TOKEN`
- Network access to the knowledge server URL
- Confirmed bundle ID on the server

### How to invoke

```text
$okf-knowledge-publisher
Download current knowledge from https://knowledge.example, add the new runbook, dry-run, then submit after I approve.
```

### Workflow

```text
download → enrich locally → okf knowledge submit --dry-run → user confirms → submit → MCP verify
```

Example:

```bash
okf knowledge download --url https://knowledge.internal.example --out ./okf-work
# edit files under ./okf-work
okf knowledge submit --workspace ./okf-work --dry-run
# after approval:
okf knowledge submit --workspace ./okf-work
```

Reading published knowledge is always through **remote MCP** (`list_bundles`, `search`, `get_concept`), not through this Skill.

---

## okf-v02-migration — Legacy catalog migration

**Path:** [.agents/skills/okf-v02-migration/](../.agents/skills/okf-v02-migration/)

Use **only** when migrating an existing OKF **v0.1** catalog to v0.2 layout. Not part of the database NL2SQL path.

---

## End-to-end example (database → agent)

```text
# 1. Physical
$okf-dbexplain sync prod-main to /data/okf/smartadmin

# 2. Business (multi-round)
$okf-bundle-business
Bundle: /data/okf/smartadmin
Task: token usage by department in May 2026
… approve proposal …

# 3. Local MCP for other agents
okf --root /data/okf/smartadmin mcp
# → configure Cursor / Claude Desktop stdio MCP

# 4. (Optional) Publish runbooks to central server
$okf-knowledge-publisher publish updated ops docs
```

---

## Register Skills in Cursor

Point the project or user skills path at the repo (or copy `.agents/skills/` into your project). After registration, invoke with `$okf-dbexplain`, `$okf-bundle-business`, etc.

See also: [OKF_CLI_SOURCE_INSTALL_UPDATE_ZH.md](OKF_CLI_SOURCE_INSTALL_UPDATE_ZH.md)
