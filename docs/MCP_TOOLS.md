# MCP Tools Reference

[English](MCP_TOOLS.md) · [简体中文](MCP_TOOLS_ZH.md)

okf-mcp exposes **the same MCP tool catalog** on **stdio** and **Streamable HTTP** when started with the **same flags**. Automated tests (`test/mcp-http-parity.test.js`, `test/hosted-mode.test.js`) assert identical tool names, schemas, and payloads across transports.

What differs is **transport and auth**, not the tool implementations:

| Transport | Command | Auth |
| --- | --- | --- |
| **stdio** | `okf --root <bundle> mcp` | Local process; no HTTP |
| **HTTP (dev)** | `okf --root <bundle> mcp --http` | Unauthenticated; loopback only by default |
| **hosted HTTP** | `okf hosted --root <bundle>` | Bearer `OKF_READ_TOKEN` on `/mcp` |

**Resources:** every profile also exposes Markdown documents through the `okf-documents` resource template (`okf://{+locator}`).

---

## Tool profiles (what gets enabled)

Tools are filtered by server flags. **Hosted mode is read-only** — it matches default local MCP without optional write/authoring flags.

| Profile | Start command | Extra tools beyond read-only |
| --- | --- | --- |
| **Read-only (default)** | `okf --root <bundle> mcp` | — |
| **Read-only HTTP** | `okf --root <bundle> mcp --http` | Same as stdio |
| **Hosted** | `okf hosted --root <bundle>` | Same read-only set as above |
| **Project helpers** | `--project <okf.project.yaml>` | `okf_validate_concept`, `okf_suggest_concept_path`, `okf_list_proposals`, `okf_get_proposal` |
| **Proposal authoring** | `--authoring` | `okf_propose_concept`, `okf_propose_update`, `okf_propose_v02_migration`, `okf_accept_proposal`, `okf_reject_proposal` |
| **Computation proposals** | `--authoring --allow-computation-authoring` | `okf_propose_attested_computation` |
| **Live batch writes** | `--write --actor <actor>` | `okf_validate_changes`, `okf_apply_changes` |
| **Runtime remote load** | `--allow-remote-tool` | `load_remote_bundle` |

Hosted **rejects** `--authoring`, `--write`, `--allow-remote-tool`, and related flags.

For database Bundle NL2SQL, the default **read-only** profile is usually enough: agents search concepts and read business semantics — they do not write through MCP.

---

## Read-only tools (always on stdio / HTTP / hosted)

### Discovery & search

| Tool | Purpose |
| --- | --- |
| `list_bundles` | List loaded local and remote bundles with counts |
| `list_concepts` | List concept summaries; optional text query and filters |
| `search_concepts` | Ranked BM25 search with lifecycle, tag, relation, and frontmatter filters |
| `get_concept` | Read one concept: frontmatter, body, links, signals, assets, git sources |
| `list_types` | Count concepts by `type` |
| `list_tags` | Count concepts by tag |
| `list_relation_types` | Count typed relations in the graph |
| `list_edge_kinds` | Count semantic and extension edge kinds |
| `list_remote_bundles` | Metadata for in-memory remote bundles |

**Locator for `get_concept`:** pass any one of:

- `id` — portable extensionless concept ID
- `uri` — canonical `okf://…` URI
- `bundle` + `path` — bundle id and relative Markdown path

### Graph navigation

| Tool | Purpose |
| --- | --- |
| `get_graph` | Bounded nodes and edges with optional filters |
| `get_neighbors` | Incoming/outgoing edges for one concept |
| `get_subgraph` | Traverse outward from seed URI(s) |
| `find_paths` | Bounded paths between two concepts |
| `graph_summary` | Bundle, concept, edge, type, tag, and health counts |
| `export_graph` | Export as JSON, Graphviz DOT, or Mermaid |
| `get_provenance` | Trace internal source provenance (no external fetch) |

### Validation & migration (read-only)

| Tool | Purpose |
| --- | --- |
| `validate_bundle` | OKF conformance for one bundle or full index |
| `validate_project` | Conformance + project validity + diagnostics |
| `check_v02_migration` | Stage-A migration analysis without writes |

### Static computation (no execution)

| Tool | Purpose |
| --- | --- |
| `inspect_attested_computation` | Static contract inspection |
| `read_bundle_asset` | Read indexed bundle asset with digest check |
| `read_git_source` | Read pinned `sources[].git` from mapped checkout |
| `prepare_attested_computation` | Parameter digest preparation (values not echoed) |
| `check_computation_receipt` | Receipt field-name check only |

---

## Optional tools (stdio / HTTP only, flag-gated)

### Proposal workflow (`--project` + `--authoring`)

| Tool | Purpose |
| --- | --- |
| `okf_validate_concept` | Validate candidate concept without writing |
| `okf_suggest_concept_path` | Suggest safe path from type + title |
| `okf_propose_concept` | Create reviewable new-concept proposal |
| `okf_propose_update` | Create reviewable update proposal |
| `okf_propose_v02_migration` | Create migration manifest + child proposals |
| `okf_propose_attested_computation` | Coordinated computation proposal (`--allow-computation-authoring`) |
| `okf_list_proposals` | List stored proposals |
| `okf_get_proposal` | Read one proposal with validation result |
| `okf_accept_proposal` | Accept proposal → write concept file |
| `okf_reject_proposal` | Reject proposal |

### Live batch writes (`--write --actor <actor>`)

| Tool | Purpose |
| --- | --- |
| `okf_validate_changes` | Validate 1–100 structured create/update ops |
| `okf_apply_changes` | Apply validated batch to local bundle |

### Runtime remote load (`--allow-remote-tool`)

| Tool | Purpose |
| --- | --- |
| `load_remote_bundle` | Fetch public GitHub tree into in-memory index |

---

## Database NL2SQL: tools agents use most

After `$okf-dbexplain` sync and `$okf-bundle-business` overlays:

```text
list_bundles          → confirm bundle is loaded
search_concepts       → find datasets, queries, business terms
get_concept           → read full dataset / query / relationship semantics
get_neighbors         → follow declared business joins
validate_bundle       → check Bundle health after changes
```

Example (stdio or HTTP — same arguments):

```json
{
  "name": "search_concepts",
  "arguments": {
    "query": "token usage",
    "pathPrefix": "business/",
    "limit": 10
  }
}
```

```json
{
  "name": "get_concept",
  "arguments": {
    "uri": "okf://my-database/business/datasets/token-usage.md"
  }
}
```

Restart or reload MCP after Bundle file changes so the index picks up new concepts.

---

## Client configuration

### stdio (Cursor / Claude Desktop)

```json
{
  "mcpServers": {
    "okf": {
      "command": "okf",
      "args": ["--root", "/absolute/path/to/bundle", "mcp"]
    }
  }
}
```

### Streamable HTTP — local dev

```bash
okf --root /path/to/bundle mcp --http --host 127.0.0.1 --port 8765
# MCP endpoint: http://127.0.0.1:8765/mcp
```

### Streamable HTTP — hosted (production)

```bash
export OKF_READ_TOKEN="<read-token>"
export OKF_ROLLOUT_TOKEN="<rollout-token>"
okf hosted --root /path/to/catalog --host 127.0.0.1 --port 8765
# MCP endpoint: http://127.0.0.1:8765/mcp
# Header: Authorization: Bearer <OKF_READ_TOKEN>
```

Publishing knowledge uses **`okf knowledge`** CLI + `/v1/rollout/*` REST (see `okf-knowledge-publisher` Skill), not MCP write tools.

---

## Parity guarantee

| Comparison | Result |
| --- | --- |
| stdio vs `mcp --http` (same flags) | Identical tools, resources, payloads |
| hosted `/mcp` vs default read-only stdio | Identical tools, resources, payloads |
| hosted vs stdio with `--authoring` / `--write` | **Different** — hosted omits write/authoring tools by design |

If you need authoring over MCP, use local stdio/HTTP with the appropriate flags. If you need team-wide published knowledge, use **hosted read MCP** + **`okf knowledge submit`** for writes.

See also: [okf/bundles/okf-mcp/interfaces/mcp-tools.md](../okf/bundles/okf-mcp/interfaces/mcp-tools.md) (OKF concept describing this contract).
