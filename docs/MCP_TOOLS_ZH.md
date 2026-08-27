# MCP 工具参考

[English](MCP_TOOLS.md) · [简体中文](MCP_TOOLS_ZH.md)

okf-mcp 在 **stdio** 与 **Streamable HTTP** 上使用**相同启动参数**时，暴露**完全相同的 MCP 工具集**。自动化测试（`test/mcp-http-parity.test.js`、`test/hosted-mode.test.js`）会校验两种传输方式的工具名、schema 与返回 payload 一致。

差异在**传输与认证**，不在工具实现：

| 传输 | 命令 | 认证 |
| --- | --- | --- |
| **stdio** | `okf --root <bundle> mcp` | 本地进程，无 HTTP |
| **HTTP（开发）** | `okf --root <bundle> mcp --http` | 无认证；默认仅 loopback |
| **hosted HTTP** | `okf hosted --root <bundle>` | `/mcp` 需 Bearer `OKF_READ_TOKEN` |

**Resources：** 各 profile 还通过 `okf-documents` 资源模板（`okf://{+locator}`）暴露 Markdown 文档。

---

## 工具 Profile（哪些工具会被启用）

工具按启动参数过滤。**Hosted 为只读 profile**，等同于本地默认 MCP（不带写/authoring 参数）。

| Profile | 启动命令 | 在只读基础上额外启用的工具 |
| --- | --- | --- |
| **只读（默认）** | `okf --root <bundle> mcp` | — |
| **只读 HTTP** | `okf --root <bundle> mcp --http` | 与 stdio 相同 |
| **Hosted** | `okf hosted --root <bundle>` | 与上面只读集相同 |
| **Project 辅助** | `--project <okf.project.yaml>` | `okf_validate_concept`、`okf_suggest_concept_path`、`okf_list_proposals`、`okf_get_proposal` |
| **Proposal 编写** | `--authoring` | `okf_propose_concept`、`okf_propose_update`、`okf_propose_v02_migration`、`okf_accept_proposal`、`okf_reject_proposal` |
| **计算 Proposal** | `--authoring --allow-computation-authoring` | `okf_propose_attested_computation` |
| **Live 批量写入** | `--write --actor <actor>` | `okf_validate_changes`、`okf_apply_changes` |
| **运行时远程加载** | `--allow-remote-tool` | `load_remote_bundle` |

Hosted **禁止** `--authoring`、`--write`、`--allow-remote-tool` 等参数。

数据库 Bundle 问数场景通常用默认**只读** profile 即可：Agent 检索概念、读 business 语义，不通过 MCP 写入。

---

## 只读工具（stdio / HTTP / hosted 均有）

### 发现与检索

| 工具 | 作用 |
| --- | --- |
| `list_bundles` | 列出已加载的本地/远程 Bundle 及计数 |
| `list_concepts` | 概念摘要列表；支持文本 query 与过滤 |
| `search_concepts` | BM25 排序检索；支持 lifecycle、tag、relation、frontmatter 过滤 |
| `get_concept` | 读取单个概念：frontmatter、正文、链接、signals、资产、git 源 |
| `list_types` | 按 `type` 统计概念数 |
| `list_tags` | 按 tag 统计 |
| `list_relation_types` | 统计图中 typed relation |
| `list_edge_kinds` | 统计语义边与扩展边 |
| `list_remote_bundles` | 内存中远程 Bundle 元数据 |

**`get_concept` 定位方式**（三选一）：

- `id` — 可移植的无扩展名 Concept ID
- `uri` — 规范 `okf://…` URI
- `bundle` + `path` — Bundle id 与相对 Markdown 路径

### 图导航

| 工具 | 作用 |
| --- | --- |
| `get_graph` | 有界节点与边，可过滤 |
| `get_neighbors` | 某概念的入边/出边 |
| `get_subgraph` | 从种子 URI 向外遍历 |
| `find_paths` | 两概念间有界路径 |
| `graph_summary` | Bundle、概念、边、类型、tag、健康度汇总 |
| `export_graph` | 导出 JSON / Graphviz DOT / Mermaid |
| `get_provenance` | 追踪内部 source 溯源（不拉取外部 URL） |

### 校验与迁移（只读）

| 工具 | 作用 |
| --- | --- |
| `validate_bundle` | 单 Bundle 或全索引的 OKF 一致性 |
| `validate_project` | 一致性 + 项目有效性 + 诊断 |
| `check_v02_migration` | Stage-A 迁移分析，不写文件 |

### 静态计算（不执行）

| 工具 | 作用 |
| --- | --- |
| `inspect_attested_computation` | 静态检查 Attested Computation 合约 |
| `read_bundle_asset` | 读取已索引 Bundle 资产并校验 digest |
| `read_git_source` | 从映射的 checkout 读取 pinned `sources[].git` |
| `prepare_attested_computation` | 参数 digest 准备（不回显参数值） |
| `check_computation_receipt` | 仅检查 receipt 字段名 |

---

## 可选工具（仅 stdio / HTTP，需 flag）

### Proposal 工作流（`--project` + `--authoring`）

| 工具 | 作用 |
| --- | --- |
| `okf_validate_concept` | 校验候选概念，不写文件 |
| `okf_suggest_concept_path` | 由 type + title 建议安全路径 |
| `okf_propose_concept` | 创建可审阅的新概念 proposal |
| `okf_propose_update` | 创建可审阅的更新 proposal |
| `okf_propose_v02_migration` | 创建迁移 manifest 与子 proposal |
| `okf_propose_attested_computation` | 协调型计算 proposal（需 `--allow-computation-authoring`） |
| `okf_list_proposals` | 列出已存 proposal |
| `okf_get_proposal` | 读取单个 proposal 及校验结果 |
| `okf_accept_proposal` | 接受 proposal → 写入概念文件 |
| `okf_reject_proposal` | 拒绝 proposal |

### Live 批量写入（`--write --actor <actor>`）

| 工具 | 作用 |
| --- | --- |
| `okf_validate_changes` | 校验 1–100 条结构化 create/update |
| `okf_apply_changes` | 将校验通过的批次写入本地 Bundle |

### 运行时远程加载（`--allow-remote-tool`）

| 工具 | 作用 |
| --- | --- |
| `load_remote_bundle` | 拉取公开 GitHub 树到内存索引 |

---

## 问数场景：Agent 最常用的工具

当已加载的数据库 Bundle 含物理 binding，并可能含 Business 语义时：

```text
list_bundles          → 确认 Bundle 已加载
search_concepts       → 找 dataset、query、business 术语
get_concept           → 读完整 dataset / query / relationship 语义
get_neighbors         → 沿 business join 扩展
validate_bundle       → 变更后检查 Bundle 健康
```

示例（stdio 与 HTTP 参数相同）：

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

Bundle 文件变更后需**重启或重载 MCP**，索引才会收录新概念。

---

## 客户端配置

### stdio（Cursor / Claude Desktop）

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

### Streamable HTTP — 本地开发

```bash
okf --root /path/to/bundle mcp --http --host 127.0.0.1 --port 8765
# MCP 端点：http://127.0.0.1:8765/mcp
```

### Streamable HTTP — hosted（生产）

```bash
export OKF_READ_TOKEN="<read-token>"
export OKF_ROLLOUT_TOKEN="<rollout-token>"
okf hosted --root /path/to/catalog --host 127.0.0.1 --port 8765
# MCP 端点：http://127.0.0.1:8765/mcp
# 请求头：Authorization: Bearer <OKF_READ_TOKEN>
```

知识发布走 **`okf knowledge`** CLI + `/v1/rollout/*` REST（见 `okf-knowledge-publisher` Skill），**不走** MCP 写工具。

---

## 一致性说明

| 对比 | 结果 |
| --- | --- |
| stdio vs `mcp --http`（相同 flag） | 工具、Resources、payload **完全一致** |
| hosted `/mcp` vs 默认只读 stdio | 工具、Resources、payload **完全一致** |
| hosted vs 带 `--authoring` / `--write` 的 stdio | **不同** — hosted 按设计省略写/authoring 工具 |

若需 MCP 上编写概念，用本地 stdio/HTTP 并加对应 flag。若需团队共享已发布知识，用 **hosted 只读 MCP** + **`okf knowledge submit`** 写入。

详见：[okf/bundles/okf-mcp/interfaces/mcp-tools.md](../okf/bundles/okf-mcp/interfaces/mcp-tools.md)
