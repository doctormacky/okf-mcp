# okf-mcp

[English](README.md) · [简体中文](README_zh.md)

Local runtime for [Open Knowledge Format v0.2](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md): validate bundles, search concepts, expose knowledge over **MCP**, and build **database Bundles** from [dbexplain](https://github.com/IamWWT/dbexplain) for agent NL2SQL.

> Fork of [mfdaves/okf-mcp](https://github.com/mfdaves/okf-mcp) (MIT). Enterprise rollout extensions: hosted Streamable HTTP MCP, immutable knowledge generations, `okf dbexplain`, and bundled Agent Skills.

---

## What you get

| Piece | Role |
| --- | --- |
| **`okf` CLI** | Validate, search, sync database Bundles, publish knowledge |
| **MCP server** | Agents retrieve OKF concepts (schemas, business semantics, saved SQL) |
| **Built-in Skills** | Guided workflows for sync, business overlays, and publishing |

No database server, vector DB, or embeddings required for the runtime itself.

---

## Prerequisites

| Dependency | Required for | Install |
| --- | --- | --- |
| **Node.js ≥ 22** | `okf` / MCP | [nodejs.org](https://nodejs.org/) |
| **[dbexplain ≥ v0.1.11](https://github.com/IamWWT/dbexplain)** | `okf dbexplain sync`, business Skill probes | Newer compatible releases are accepted; put `dbexplain` on `PATH` |
| **`.env.dbexplain`** (or DSN) | dbexplain connectivity | User-maintained; Skills never read or edit it |
| **Git** | Source install | Optional for tarball deploy |

Check:

```bash
node --version          # v22+
command -v dbexplain && dbexplain --version
```

---

## Quick start (database knowledge and querying)

The CLI and Skills are independent capabilities. Install the ones needed for a task:

```text
okf CLI / MCP       → validate, index, and serve knowledge
okf-dbexplain       → generate or refresh physical facts
okf-bundle-business → add or correct Business knowledge
okf-nl2sql          → query real data and return traceable results
```

### 1. Install okf-mcp

```bash
git clone https://github.com/doctormacky/okf-mcp.git
cd okf-mcp
npm ci
npm link                    # optional: register `okf` on PATH
okf --version
```

Extended install, update, and rollback guide (Chinese): [docs/OKF_CLI_SOURCE_INSTALL_UPDATE_ZH.md](docs/OKF_CLI_SOURCE_INSTALL_UPDATE_ZH.md).

### 2. Sync physical layer (Skill or CLI)

Prepare dbexplain ([releases](https://github.com/IamWWT/dbexplain)), then:

```text
$okf-dbexplain
Inspect prod-main and sync to /data/okf/my-database
```

Or manually:

```bash
okf dbexplain check --include prod-main
okf dbexplain sync \
  --include prod-main \
  --bundle-root /data/okf/my-database \
  --generated-at 2026-08-26T09:00:00Z \
  --dry-run
# review plan → apply with --expect-plan <digest>
okf dbexplain validate --bundle-root /data/okf/my-database
```

### 3. Add business semantics

```text
$okf-bundle-business
Bundle: /data/okf/my-database
Task: add buyer aliases to Customers and project explicit order-state codes
from the column comment. Inventory and propose before writing.
```

After writes:

```bash
okf dbexplain overlay-index --bundle-root /data/okf/my-database
okf dbexplain validate --bundle-root /data/okf/my-database
```

Skill details: [docs/SKILLS.md](docs/SKILLS.md).

### 4. Connect an MCP client

See [MCP modes](#mcp-modes) below. Restart or reload after Bundle changes.

---

## Built-in Agent Skills

Skills live under `.agents/skills/`. Register them in your agent host (Cursor, Codex, etc.).

| Skill | When to use | You say (example) |
| --- | --- | --- |
| **[okf-dbexplain](.agents/skills/okf-dbexplain/)** | First-time or refresh **physical** Bundle from dbexplain | `$okf-dbexplain sync prod-main to /data/okf/my-db` |
| **[okf-bundle-business](.agents/skills/okf-bundle-business/)** | Add or correct Business knowledge in a query-ready Bundle | `$okf-bundle-business add buyer aliases to Customers` |
| **[okf-nl2sql](.agents/skills/okf-nl2sql/)** | Execute read-only SQL from MCP knowledge and return real data | `$okf-nl2sql show net sales after refunds by store last month` |
| **[okf-knowledge-publisher](.agents/skills/okf-knowledge-publisher/)** | Publish/update **central** OKF knowledge via `okf knowledge` + hosted MCP | `$okf-knowledge-publisher publish workspace to server` |

Also shipped: **[okf-v02-migration](.agents/skills/okf-v02-migration/)** — only when migrating legacy v0.1 catalogs to v0.2.

Each Skill may be installed alone or in any combination and does not assume the
others exist. Composition is a user or Agent Host decision.

Full reference: [docs/SKILLS.md](docs/SKILLS.md) · [docs/SKILLS_ZH.md](docs/SKILLS_ZH.md)

---

## MCP modes

stdio and Streamable HTTP expose **the same tools** when started with the **same flags**. For database NL2SQL, the default read-only profile is enough.

Full tool catalog: [docs/MCP_TOOLS.md](docs/MCP_TOOLS.md) · [docs/MCP_TOOLS_ZH.md](docs/MCP_TOOLS_ZH.md)

| Mode | Command | Best for |
| --- | --- | --- |
| **stdio MCP** | `okf --root <bundle> mcp` | Cursor, Claude Desktop, local IDE agents |
| **Streamable HTTP (dev)** | `okf --root <bundle> mcp --http` | Local HTTP client testing (loopback) |
| **Streamable HTTP (hosted)** | `okf hosted --root <bundle>` | Team server; bearer auth + immutable generations |

### Tools (read-only — all three modes above)

| Category | Tools |
| --- | --- |
| **Discovery** | `list_bundles`, `list_concepts`, `search_concepts`, `get_concept`, `list_types`, `list_tags`, `list_relation_types`, `list_edge_kinds`, `list_remote_bundles` |
| **Graph** | `get_graph`, `get_neighbors`, `get_subgraph`, `find_paths`, `graph_summary`, `export_graph`, `get_provenance` |
| **Validation** | `validate_bundle`, `validate_project`, `check_v02_migration` |
| **Assets / computation** | `read_bundle_asset`, `read_git_source`, `inspect_attested_computation`, `prepare_attested_computation`, `check_computation_receipt` |

**Resources:** `okf-documents` template — read any indexed Markdown concept by `okf://` URI.

**NL2SQL workflow:** `$okf-nl2sql` calls `search_concepts` → `get_concept` →
`get_neighbors`, then assembles SQL from business knowledge, physical bindings,
and Saved Queries. It falls back to bounded dbexplain discovery only when needed.

Optional write/authoring tools (`okf_propose_*`, `okf_apply_changes`, `load_remote_bundle`) are available on **local stdio/HTTP only** with extra flags; **hosted omits them**. Knowledge publishing uses `okf knowledge` CLI, not MCP writes.

### stdio (local agent)

```json
{
  "mcpServers": {
    "okf": {
      "command": "node",
      "args": [
        "/absolute/path/to/okf-mcp/bin/okf-mcp.js",
        "--root",
        "/absolute/path/to/your/bundle",
        "mcp"
      ]
    }
  }
}
```

Or after `npm link`:

```json
{
  "mcpServers": {
    "okf": {
      "command": "okf",
      "args": ["--root", "/absolute/path/to/your/bundle", "mcp"]
    }
  }
}
```

Default with no subcommand also starts stdio MCP when a bundle root is configured.

### hosted (Streamable HTTP + rollout)

Authenticated enterprise profile: MCP at **`/mcp`**, rollout API at **`/v1/rollout/*`**.

```bash
export OKF_READ_TOKEN="<read-token>"
export OKF_ROLLOUT_TOKEN="<rollout-token>"
okf hosted --root /path/to/catalog --host 127.0.0.1 --port 8765
# → http://127.0.0.1:8765/mcp
```

Use **`okf-knowledge-publisher`** Skill to download → dry-run → submit snapshots. Other agents consume published knowledge through this MCP URL with `Authorization: Bearer $OKF_READ_TOKEN`.

Standalone unauthenticated HTTP (dev only):

```bash
okf --root /path/to/bundle mcp --http --host 127.0.0.1 --port 8765
```

Prefer **`hosted`** for anything beyond localhost.

---

## Common CLI checks

```bash
okf --root /path/to/bundle validate
okf --root /path/to/bundle search "order state"
okf --root /path/to/bundle concept business/datasets/my-dataset
okf dbexplain inspect --include prod-main
okf dbexplain validate --bundle-root /path/to/database-bundle
```

---

## Documentation

| Doc | Content |
| --- | --- |
| [docs/MCP_TOOLS.md](docs/MCP_TOOLS.md) / [docs/MCP_TOOLS_ZH.md](docs/MCP_TOOLS_ZH.md) | MCP tools — stdio vs HTTP parity, full catalog |
| [docs/SKILLS.md](docs/SKILLS.md) / [docs/SKILLS_ZH.md](docs/SKILLS_ZH.md) | Built-in Skills — when & how |
| [docs/OKF_CLI_SOURCE_INSTALL_UPDATE_ZH.md](docs/OKF_CLI_SOURCE_INSTALL_UPDATE_ZH.md) | Install, `npm link`, update, skills registration |
| [docs/USER_GUIDE_ZH.md](docs/USER_GUIDE_ZH.md) | Full user manual (hosted, knowledge, MCP tools) |
| [okf/bundles/okf-mcp/](okf/bundles/okf-mcp/) | Self-describing OKF product bundle |

---

## Development

```bash
npm ci
npm test
npm run self:validate
```

---

## License

MIT — see [LICENSE](LICENSE). Upstream [mfdaves/okf-mcp](https://github.com/mfdaves/okf-mcp) contributors remain credited.
