# okf-mcp

[English](README.md) · [简体中文](README_zh.md)

[Open Knowledge Format v0.2](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md) 的本地运行时：校验 Bundle、检索概念、通过 **MCP** 对外提供知识，并用 [dbexplain](https://github.com/IamWWT/dbexplain) 生成**数据库 Bundle**，供 Agent **问数 / NL2SQL** 使用。

> 基于 [mfdaves/okf-mcp](https://github.com/mfdaves/okf-mcp) fork（MIT）。本 fork 增加：认证 **Streamable HTTP MCP**、不可变知识代际、`okf dbexplain`、内置 Agent Skills。

---

## 你能用到什么

| 组件 | 作用 |
| --- | --- |
| **`okf` CLI** | 校验、检索、同步数据库 Bundle、发布知识 |
| **MCP 服务** | 让 Agent 检索 OKF 概念（表结构、业务语义、已验证 SQL） |
| **内置 Skills** | 引导完成 sync、补 business、发布知识 |

运行时本身**不需要**数据库、向量库或 Embedding 服务。

---

## 依赖

| 依赖 | 用途 | 安装 |
| --- | --- | --- |
| **Node.js ≥ 22** | 运行 `okf` / MCP | [nodejs.org](https://nodejs.org/) |
| **[dbexplain ≥ v0.1.11](https://github.com/IamWWT/dbexplain)** | `okf dbexplain sync`、business Skill 探库 | 兼容的更高版本可直接使用，确保 `dbexplain` 在 `PATH` |
| **`.env.dbexplain`**（或 DSN） | dbexplain 连库 | 用户自行维护；Skill **不会**读写该文件 |
| **Git** | 源码安装 |  tarball 部署时可不要 |

检查环境：

```bash
node --version          # v22+
command -v dbexplain && dbexplain --version
```

---

## 快速开始（数据库 Bundle → 问数）

SmartAdmin / 太易 等场景的典型路径：

```text
1. 安装 okf-mcp + dbexplain
2. $okf-dbexplain        → 把物理事实 sync 进 Bundle 目录
3. $okf-bundle-business  → 多轮确认后补 business 语义
4. okf-mcp 挂载 Bundle → 其它 Agent 检索并拼 SQL
```

### 1. 安装 okf-mcp

```bash
git clone https://github.com/doctormacky/okf-mcp.git
cd okf-mcp
npm ci
npm link                    # 可选：把 okf 注册到 PATH
okf --version
```

详细步骤：[docs/OKF_CLI_SOURCE_INSTALL_UPDATE_ZH.md](docs/OKF_CLI_SOURCE_INSTALL_UPDATE_ZH.md)

### 2. 同步物理层（Skill 或 CLI）

先安装 [dbexplain](https://github.com/IamWWT/dbexplain)，配置好 `.env.dbexplain`，然后：

```text
$okf-dbexplain
请检查 prod-main，并 sync 到 /data/okf/my-database
```

或手动：

```bash
okf dbexplain check --include prod-main
okf dbexplain sync \
  --include prod-main \
  --bundle-root /data/okf/my-database \
  --generated-at 2026-08-26T09:00:00Z \
  --dry-run
# 审阅 plan → 用 --expect-plan <digest> apply
okf dbexplain validate --bundle-root /data/okf/my-database
```

### 3. 补 business 语义

```text
$okf-bundle-business
Bundle: /data/okf/my-database
label: prod-main
业务：统计 XXXX 用户在 2026年5月的 token 消耗总量
请先给逻辑和 SQL 例子，我确认后再写入
```

写入后刷新 overlay 索引（**不要手改 index.md**）：

```bash
okf dbexplain overlay-index --bundle-root /data/okf/my-database
okf dbexplain validate --bundle-root /data/okf/my-database
```

Skill 说明：[docs/SKILLS_ZH.md](docs/SKILLS_ZH.md)

### 4. 挂载 MCP 客户端

见下文 [MCP 两种形态](#mcp-两种形态)。Bundle 变更后需重启或重新加载服务。

---

## 内置 Agent Skills

目录：`.agents/skills/`。在 Cursor、Codex 等宿主中注册后即可 `$skill名` 调用。

| Skill | 什么时候用 | 示例说法 |
| --- | --- | --- |
| **[okf-dbexplain](.agents/skills/okf-dbexplain/)** | 首次或刷新 **物理事实** Bundle | `$okf-dbexplain 把 prod-main sync 到 /data/okf/my-db` |
| **[okf-bundle-business](.agents/skills/okf-bundle-business/)** | 在已有 Bundle 上 **补/改 business**（问数） | `$okf-bundle-business 更新 test-bundle 的 token 统计 business` |
| **[okf-knowledge-publisher](.agents/skills/okf-knowledge-publisher/)** | 向 **中心知识库** 发布/更新（hosted MCP） | `$okf-knowledge-publisher 发布 workspace 到服务器` |

另含 **[okf-v02-migration](.agents/skills/okf-v02-migration/)**：仅在做 v0.1 → v0.2 迁移时使用。

**分工：** 物理层（`okf-dbexplain`）→ 语义层（`okf-bundle-business`）→ MCP 检索。不要让一个 Skill 替另一个猜业务。

完整说明：[docs/SKILLS_ZH.md](docs/SKILLS_ZH.md) · [docs/SKILLS.md](docs/SKILLS.md)

---

## MCP 两种形态

stdio 与 Streamable HTTP 在**相同启动参数**下暴露**相同工具**。数据库问数场景，默认只读 profile 即可。

完整工具列表：[docs/MCP_TOOLS_ZH.md](docs/MCP_TOOLS_ZH.md) · [docs/MCP_TOOLS.md](docs/MCP_TOOLS.md)

| 形态 | 命令 | 适用 |
| --- | --- | --- |
| **stdio MCP** | `okf --root <bundle> mcp` | Cursor、Claude Desktop、本地 IDE |
| **Streamable HTTP（开发）** | `okf --root <bundle> mcp --http` | 本地 HTTP 客户端调试（loopback） |
| **Streamable HTTP（hosted）** | `okf hosted --root <bundle>` | 团队服务；Bearer 认证 + 不可变代际 |

### 工具（只读 — 以上三种形态均有）

| 类别 | 工具 |
| --- | --- |
| **发现与检索** | `list_bundles`、`list_concepts`、`search_concepts`、`get_concept`、`list_types`、`list_tags`、`list_relation_types`、`list_edge_kinds`、`list_remote_bundles` |
| **图导航** | `get_graph`、`get_neighbors`、`get_subgraph`、`find_paths`、`graph_summary`、`export_graph`、`get_provenance` |
| **校验** | `validate_bundle`、`validate_project`、`check_v02_migration` |
| **资产 / 计算** | `read_bundle_asset`、`read_git_source`、`inspect_attested_computation`、`prepare_attested_computation`、`check_computation_receipt` |

**Resources：** `okf-documents` 模板 — 通过 `okf://` URI 读取任意已索引 Markdown 概念。

**问数流程：** `search_concepts` → `get_concept` → `get_neighbors` → 结合 `queries/` 中已保存 SQL 拼语句。

可选写/authoring 工具（`okf_propose_*`、`okf_apply_changes`、`load_remote_bundle`）仅在**本地 stdio/HTTP** 加额外 flag 时可用；**hosted 不提供**。知识发布走 `okf knowledge` CLI，不走 MCP 写工具。

### stdio（本地 Agent）

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

`npm link` 之后可简化为：

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

### hosted（Streamable HTTP + 发布）

企业模式：MCP 在 **`/mcp`**，发布 API 在 **`/v1/rollout/*`**。

```bash
export OKF_READ_TOKEN="<read-token>"
export OKF_ROLLOUT_TOKEN="<rollout-token>"
okf hosted --root /path/to/catalog --host 127.0.0.1 --port 8765
# → http://127.0.0.1:8765/mcp
```

用 **`okf-knowledge-publisher`** Skill 走 download → dry-run → submit；其它 Agent 通过该 MCP 地址消费已发布知识，请求头带 `Authorization: Bearer $OKF_READ_TOKEN`。

仅本机调试可用无认证 HTTP（不推荐生产）：

```bash
okf --root /path/to/bundle mcp --http --host 127.0.0.1 --port 8765
```

生产环境请用 **`hosted`**。

---

## 常用 CLI

```bash
okf --root /path/to/bundle validate
okf --root /path/to/bundle search "token"
okf --root /path/to/bundle concept business/datasets/my-dataset
okf dbexplain inspect --include prod-main
```

---

## 文档索引

| 文档 | 内容 |
| --- | --- |
| [docs/MCP_TOOLS_ZH.md](docs/MCP_TOOLS_ZH.md) / [docs/MCP_TOOLS.md](docs/MCP_TOOLS.md) | MCP 工具 — stdio 与 HTTP 一致性、完整列表 |
| [docs/SKILLS_ZH.md](docs/SKILLS_ZH.md) / [docs/SKILLS.md](docs/SKILLS.md) | 内置 Skills 用法 |
| [docs/OKF_CLI_SOURCE_INSTALL_UPDATE_ZH.md](docs/OKF_CLI_SOURCE_INSTALL_UPDATE_ZH.md) | 安装、`npm link`、更新、注册 Skill |
| [docs/USER_GUIDE_ZH.md](docs/USER_GUIDE_ZH.md) | 完整手册（hosted、knowledge、MCP 工具） |
| [okf/bundles/okf-mcp/](okf/bundles/okf-mcp/) | 产品自描述 OKF Bundle |

---

## 开发

```bash
npm ci
npm test
npm run self:validate
```

---

## 许可证

MIT — 见 [LICENSE](LICENSE)。保留上游 [mfdaves/okf-mcp](https://github.com/mfdaves/okf-mcp) 贡献者署名。
