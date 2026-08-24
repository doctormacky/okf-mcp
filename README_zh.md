# okf-mcp

[English](README.md) | [简体中文](README_zh.md)

> 本仓库基于原始项目 [mfdaves/okf-mcp](https://github.com/mfdaves/okf-mcp) 进行企业知识快速发布能力扩展。原项目及其贡献者继续依据 MIT License 获得署名。

`okf-mcp` 是 [Open Knowledge Format v0.2](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md) 的本地优先消费者、验证器、图索引、CLI 和 MCP 服务器。

它消费由 Markdown 文件和 YAML frontmatter 组成的 OKF bundle 目录。可选的工作区模式可以联邦化多个 bundle。概念通过 CLI 命令和 MCP 资源/工具暴露，支持验证、结构化搜索、图导航、溯源检查和基于提案的创作。

核心设计有意避免数据库、嵌入向量或托管服务依赖。它使用 `js-yaml` 处理安全 YAML，CommonMark 解析 Markdown 结构，MiniSearch 实现内存中的 BM25+ 文本检索，并使用官方 Model Context Protocol TypeScript SDK v2 实现 stdio 和 Streamable HTTP MCP。本地根模式不进行任何网络调用。可选远程加载功能从 GitHub 获取公共 Markdown 概念及其明确引用的非活动资源。v0.2 计算支持中的任何部分都不会执行代码或验证回执。

## OKF v0.2 支持与扩展

OKF v0.2 有意定义可移植的文件格式，而非服务或查询运行时。`okf-mcp` 明确保持这一边界：

| 领域 | 官方 OKF v0.2 | okf-mcp 行为 |
| --- | --- | --- |
| Bundle 和标识 | Markdown 文件目录树；概念 ID 是其 bundle 内相对路径（不含 `.md`） | `--root` 直接映射一个 bundle；`okf://` 是可选的工作区定位符，而非可移植的概念 ID |
| 概念元数据 | 必需的 `type`；推荐的 `title`、`description`、`resource` 和 `tags`；允许未知键 | 保留扩展字段和未知类型，同时单独报告规范符合性与工作区策略 |
| 溯源和生命周期 | `sources`、`usage_window`、`generated`、`verified`、`status` 和 `stale_after` | 规范化这些字段以支持搜索、溯源遍历、信任层级和确定性新鲜度检查 |
| 引用 | Markdown 链接和路径值字段 `resource`、`sources[].resource`、`computation`、`executor.resource` 和 `attester.resource` | 构建图边和有界的非活动资源快照，不执行或隐式获取引用的代码 |
| 已验证计算 | 定义合约字段和信息性消费者流，延迟运行时线路协议和验证器包装 | 静态检查合约和摘要，检查声明的参数和回执字段名，不执行或声称验证 |
| v0.1 兼容性 | 当整个 `generated` 映射不存在时允许 `timestamp` 回退，当 `sources` 键不存在时允许 `# Citations` 回退 | 消费两种形式，添加仅审查的迁移检查和提案 |

以下是 okf-mcp 的扩展，而非格式要求：

- CLI、MCP 和 HTTP 接口；内存搜索和图视图
- 可选的多 bundle `okf.project.yaml` 工作区和类型化 `relations`
- 兼容性 `id`、`aliases` 和 `okf://` 定位符
- 基于提案的创作与显式接受
- 有界的 GitHub 远程加载和显式映射的固定 Git 源
- 生成器插件和更严格的可选项目策略（如 `strictLinks`）

## 安装与运行

需要 Node 22 或更高版本。

### 无内部 npm 仓库时从源码运行

不需要企业内部 npm 仓库。可以在一台构建机器上安装一次依赖，再把包含 `node_modules` 的完整运行目录分发给 Agent：

```bash
git clone https://github.com/doctormacky/okf-mcp.git
cd okf-mcp
npm ci --omit=dev
node bin/okf-mcp.js --version
```

复制到 Agent 主机后直接运行：

```bash
node /opt/okf-mcp/bin/okf-mcp.js --version
node /opt/okf-mcp/bin/okf-mcp.js knowledge --help
```

可以在 `/usr/local/bin/okf` 创建固定包装命令：

```bash
#!/usr/bin/env bash
set -euo pipefail
exec node /opt/okf-mcp/bin/okf-mcp.js "$@"
```

Agent Skill 只检查和调用该命令，不会自动安装或升级运行时。

安装本扩展源码版本：

```bash
git clone https://github.com/doctormacky/okf-mcp.git
cd okf-mcp
npm ci
node bin/okf-mcp.js --root ./path/to/okf validate
```

当前 fork 主要通过源码分发，而不是 npm Registry。生产部署应固定 Git commit 或 release archive。上游 npm 包仍可用于上游原有功能，但不包含本 fork 的 hosted rollout 扩展。

```bash
git clone https://github.com/doctormacky/okf-mcp.git
cd okf-mcp
git checkout <commit-or-tag>
npm ci --omit=dev
```

原始上游项目仍位于 [mfdaves/okf-mcp](https://github.com/mfdaves/okf-mcp)。使用当前扩展分支：

```bash
git clone https://github.com/doctormacky/okf-mcp.git
cd okf-mcp
npm ci
npm test
node bin/okf-mcp.js --version
```

`--root` 接受一个本地 OKF bundle 目录，是单个 bundle 推荐的 okf-mcp 接口。每个概念的可移植标识是其在该根目录内不含扩展名的路径。

`--bundle` 接受路径或 `id=path` 格式。为保持兼容性，仍支持多个标志。`--project` 及其 `bundles:` 列表是可选的 okf-mcp 联邦/创作扩展，不属于 OKF v0.2。

`--remote-bundle` 接受 `id=https://github.com/<owner>/<repo>/tree/<ref>/<path>`。它首先获取公共 Markdown，然后仅获取标准 v0.2 资源字段明确命名的 bundle 本地文件。远程内容保持只读和非活动状态。

`--inspect` 打印紧凑的图摘要并退出。如果没有 `--inspect` 且没有显式命令，进程将启动 stdio MCP 服务器。

安装后，包会暴露 `okf` 和 `okf-mcp` 两个二进制文件。如果没有显式源，CLI 首先发现最近的声明 `okf_version` 的根 `index.md`；最近项目发现仍是兼容性回退。

CLI 退出状态码：`0` 表示成功，`1` 表示验证或操作失败，`2` 表示无效用法。未知选项会被拒绝。

## 企业知识快速发布

`hosted` 命令在同一进程中运行经过认证的 MCP Streamable HTTP 和快照发布 API。二者共享同一个不可变活动 generation 和内存索引：

```bash
OKF_READ_TOKEN=agent-read-token \
OKF_ROLLOUT_TOKEN=publisher-write-token \
okf --root /data/okf hosted --host 127.0.0.1 --port 8790
```

端点：

- `POST|GET|DELETE /mcp`：MCP Streamable HTTP，必须使用 hosted token
- `GET /v1/rollout/snapshot`：下载当前活动的不可变快照
- `GET /v1/rollout/status`：查看当前 revision 和 generation
- `POST /v1/rollout/dry-run`：生成经服务端验证、带有效期的预览
- `POST /v1/rollout/submit`：确认并原子激活已预览快照
- `GET /health`：服务健康检查

中央 hosted profile 的 MCP 能力保持只读：完整支持现有查询、图、溯源、资源读取、验证和静态计算检查工具，但不开放提案变更、MCP 直接写入或运行时远程加载。知识发布由 CLI 调用普通 rollout API 完成。

下载、预览、确认并发布：

```bash
export OKF_ROLLOUT_TOKEN=publisher-write-token

okf knowledge download \
  --url https://knowledge.internal.example \
  --out ./okf-work

# 使用仓库自带的 okf-knowledge-publisher Skill 编辑 ./okf-work。

okf knowledge submit \
  --workspace ./okf-work \
  --dry-run

okf knowledge submit \
  --workspace ./okf-work \
  --preview-id <preview-id> \
  --message "补充订单取消流程"
```

CLI 会在权限受限的 `.okf-knowledge.json` 工作区状态中保存下载 revision、preview 绑定、候选摘要和稳定的幂等键。正式提交必须使用同一份未过期 preview，并获得明确确认。基线过期会返回 `409`，此时需要重新下载、合并修改、再次 dry-run 并重新确认。服务端先验证和索引完整候选内容，再原子切换活动 generation；新的 MCP 请求立即读取新版本，执行中的请求继续使用其已捕获的旧索引。

无人值守自动化可显式使用 `--yes` 跳过交互确认，但它不能绕过 preview、摘要、revision、认证、验证或幂等检查。

## 内置 OKF 参考

本仓库发布了一个自描述的 OKF bundle，包含产品、其运行时边界、接口、创作工作流和安全策略。其可移植入口概念 ID 为 `overview/okf-mcp`；`okf://okf-mcp/overview/okf-mcp` 保持为工作区/MCP 资源定位符。

从检出或安装的包验证和查询内置参考：

```bash
okf --root okf/bundles/okf-mcp validate
okf --root okf/bundles/okf-mcp search "proposal"
okf --root okf/bundles/okf-mcp concept overview/okf-mcp
```

直接从此发布版加载参考 bundle：

```bash
okf --remote-bundle okf-mcp=https://github.com/doctormacky/okf-mcp/tree/main/okf/bundles/okf-mcp --inspect
```

源码运行包包含 `okf.project.yaml` 和完整的参考 bundle。

## 可选的多 Bundle 项目配置

仅当一个进程需要联邦多个根、配置生成器或强制执行项目级关系词汇表时，才使用 `okf.project.yaml`：

```yaml
project: Example
strictLinks: false
bundles:
  - id: app
    root: okf/bundles/app
    include: ["**/*.md"]
    exclude: ["archive/**"]
  - id: data
    root: okf/bundles/data
relationTypes:
  - deployed_by
remoteBundles:
  - id: shared
    url: https://github.com/example/okf-atlas/tree/main/bundles/shared
    include: ["public/**"]
    exclude: ["drafts/**"]
plugins:
  - name: docs
    type: filesystem
    root: docs
    output: okf/bundles/app/generated/docs
    bundle: app
```

运行项目命令：

```bash
okf --project okf.project.yaml validate
okf --project okf.project.yaml search "orders"
okf --project okf.project.yaml graph mermaid
okf --project okf.project.yaml generate
okf --project okf.project.yaml mcp
okf --project okf.project.yaml mcp --authoring
okf --project okf.project.yaml mcp --allow-remote-tool
OKF_WRITE_TOKEN=change-me okf --project okf.project.yaml serve
okf --remote-bundle shared=https://github.com/example/okf-atlas/tree/main/bundles/shared --inspect
```

命令：

- `mcp`
- `validate`
- `graph [json|dot|mermaid]`
- `search <query>`
- `concept <concept-id-or-locator>`
- `neighbors <concept-id-or-locator>`
- `paths <from> <to>`
- `provenance <uri>`
- `edge-kinds`
- `computation inspect|prepare|check-receipt`
- `asset <okf-asset-uri>`
- `source <concept-id-or-locator> <source-id>`
- `migrate check|preview`
- `generate`
- `serve`

`serve` 选项：

- `--host <host>`：绑定主机，默认 `127.0.0.1`
- `--port <port>`：绑定端口，默认 `8765`
- `--write-token <token>`：写入端点的 bearer token；默认为 `OKF_WRITE_TOKEN`
- `--proposal-root <path>`：提案 JSON 目录；默认为所选本地根或项目下的 `.okf-proposals`

## MCP 客户端配置

本 fork 通过源码分发。MCP 客户端应使用绝对路径直接调用源码入口。

客户端配置示例：

```json
{
  "mcpServers": {
    "okf": {
      "command": "node",
      "args": [
        "/absolute/path/to/okf-mcp/bin/okf-mcp.js",
        "--root",
        "/absolute/path/to/okf",
        "mcp"
      ]
    }
  }
}
```

项目配置模式，具有只读项目辅助功能但不包含提案变更：

```json
{
  "mcpServers": {
    "okf": {
      "command": "node",
      "args": [
        "/absolute/path/to/okf-mcp/bin/okf-mcp.js",
        "--project",
        "/absolute/path/to/repo/okf.project.yaml",
        "mcp"
      ]
    }
  }
}
```

添加 `--authoring` 启用提案创建、接受和拒绝。对于较小的直接写入表面，添加 `--write --actor <actor>` 暴露只读的 `okf_validate_changes` 和经过验证的批量 `okf_apply_changes`；添加 `--git-commit` 在目录处于干净 Git 工作树时为每个成功批量创建提交。添加 `--allow-remote-tool` 允许 MCP 客户端在运行时加载任意支持的公共远程 bundle。配置的远程 bundle 在没有该运行时加载标志时仍可读。

stdio 服务器使用 `@modelcontextprotocol/server` v2。它服务于现代 `2026-07-28` MCP 修订版和 SDK 的 2025 年代客户端兼容路径（包括 `2025-11-25`）。SDK 负责协议协商、帧处理、资源分发、工具分发和广告模式验证。

来自已知工具的预期失败（如缺失概念、只读 bundle、远程获取失败、无效参数或提案冲突）以 `isError: true` 的 MCP 工具结果返回。对未启用工具的调用会被 SDK 分发拒绝。意外的实现错误会被屏蔽，不暴露内部细节。

## MCP 注册表元数据

`server.json` 将 fork 的源码包身份和 stdio MCP 入口描述为 `io.github.doctormacky/okf-mcp`。这些元数据与源码包保持同步，可用于未来的 Registry 发布；当前 fork 仍通过源码安装。客户端应通过 `--root` 传入绝对 OKF 根路径，并附加固定的 `mcp` 命令。

## 概念标识与扩展

概念 ID 是其 bundle 内 Markdown 路径（移除 `.md`）。这个不含扩展名的路径是可移植的 OKF 标识。okf-mcp 还暴露工作区范围的兼容性定位符：

```text
okf://<bundle-id>/<extensionless-concept-id>
```

旧的 `.md` URI 和有效的自定义 `id` 仍是兼容性查找别名。裸概念 ID 仅在跨加载 bundle 唯一时解析。对于独立聚合目录，当 `services/queue` 全局唯一且 `services` 不是已加载的 bundle ID 时，URI 形式的可移植路径（如 `okf://services/queue.md`）也会解析。精确的规范 URI 始终优先；已知 bundle 未命中或歧义可移植路径保持未解析状态。保留的 `index.md` 和 `log.md` 资源保留其文件名，因为它们不是概念。

以下 `id`、`aliases` 和类型化 `relations` 字段是 `okf-mcp` 扩展。标准 v0.2 标识仍是路径派生的：

```markdown
---
id: okf://app/routes/order-status
type: API Route
title: Order Status Route
description: Serves order status state.
aliases: [order-status]
tags: [api, orders]
relations:
  - type: consumes
    target: okf://data/tables/order_status
  - type: configured_by
    target: repo://src/routes/order-status.js
---

# Order Status Route
```

新内容应使用普通的相对或 bundle 根 Markdown 路径进行内部链接和扩展关系目标。现有的 `okf://` 目标仍受支持；非 OKF 方案（如 `repo://`）保持为不透明的兼容性引用。

### 固定 Git 源

代码知识可能存在于代码仓库之外，而不记录机器特定路径。将标准 `sources` 条目指向 `Git Repository` 概念，并添加以下 okf-mcp `git` 扩展：

```yaml
sources:
  - id: implementation
    resource: /repositories/application.md
    git:
      revision: 0123456789abcdef0123456789abcdef01234567
      path: src/application.js
      lines: { from: 10, to: 30 }
```

仅在本地进程配置中映射仓库概念：

```bash
okf --root /path/to/catalog \
  --repo repositories/application=/work/application \
  source architecture/application implementation
```

`read_git_source` 和 `source` CLI 命令从映射的 Git 对象数据库读取固定的 blob。它们从不读取脏工作树或进行获取。缺失的映射和未固定的修订版仍可见但不可用。仓库映射可以指向普通检出、裸仓库或挂载路径；凭据和本地路径保持在 OKF bundle 之外。

## 工具

- `list_bundles`
- `list_concepts`
- `get_concept`
- `search_concepts`
- `list_types`
- `list_tags`
- `list_relation_types`
- `list_edge_kinds`
- `get_provenance`
- `inspect_attested_computation`
- `read_bundle_asset`
- `read_git_source`
- `prepare_attested_computation`
- `check_computation_receipt`
- `check_v02_migration`
- `load_remote_bundle`
- `list_remote_bundles`
- `okf_validate_concept`
- `okf_suggest_concept_path`
- `okf_propose_concept`
- `okf_propose_update`
- `okf_propose_attested_computation`
- `okf_propose_v02_migration`
- `okf_list_proposals`
- `okf_get_proposal`
- `okf_accept_proposal`
- `okf_reject_proposal`
- `okf_validate_changes`
- `okf_apply_changes`
- `get_graph`
- `get_neighbors`
- `get_subgraph`
- `find_paths`
- `graph_summary`
- `validate_bundle`
- `validate_project`
- `export_graph`

大多数 MCP 工具对当前索引是只读的。`load_remote_bundle` 仅通过获取公共 GitHub 树来变更服务器的内存索引；它不写入文件。概念列表和搜索默认返回紧凑摘要；当需要导航元数据、信号、排名或片段时，传递 `detail: "full"`。关系路径即使在并行边类型连接相同概念时，也会按节点序列去重。

每个 MCP 工具都包含特定用途的描述、输入参数的描述以及涵盖只读行为、破坏性行为、幂等性和外部访问的标准注解。

工具参数在执行前会根据广告的输入模式进行验证。不支持的字段、缺失的必需值、错误的原始类型和超出范围的整数会被拒绝，不会进行强制转换。未知或禁用的工具名称仍是协议级无效参数错误。

工具发现和直接调用使用相同的能力检查：

| 模式 | 普通提案 | 直接实时写入 | 计算提案 | 运行时远程加载 |
| --- | --- | --- | --- | --- |
| 默认 | 禁用 | 禁用 | 禁用 | 禁用 |
| `--authoring` | 启用 | 禁用 | 禁用 | 禁用 |
| `--write --actor openai/gpt-5.6` | 禁用 | 启用 | 禁用 | 禁用 |
| `--authoring --allow-computation-authoring` | 启用 | 禁用 | 启用 | 禁用 |
| `--allow-remote-tool` | 禁用 | 禁用 | 禁用 | 启用 |

显式本地根或项目工作区暴露概念验证、路径建议和提案检查辅助功能。提案变更工具需要 `--authoring`。直接实时工具则需要 `--write` 加上使用 `human:<id>`、`process:<id>` 或 `provider/model` 语法的真实行为者。在普通单根模式下，调用者省略 `bundle`；仅当需要在多个项目根中选择时才需要。远程根保持只读。

通用概念工具无法创建或更改已验证计算合约。`okf_propose_attested_computation` 额外需要 `--allow-computation-authoring`，并为概念加可选的外部计算文件创建一个协调的审查提案。

## 实时概念创作

仅当 MCP 客户端/用户审批边界足够审查时，才使用直接写入能力启动服务器：

```bash
okf --root /path/to/catalog --write --actor openai/gpt-5.6 mcp
```

代理看到一个只读批量验证器和一个破坏性应用工具。它提供结构化的概念字段而非 YAML；OKF 序列化兼容的 Markdown frontmatter，并为整个批量盖上配置的 `generated.by` 加一个 `generated.at` 时间戳。

```json
{
  "name": "okf_apply_changes",
  "arguments": {
    "message": "docs(okf): document order creation",
    "changes": [
      {
        "op": "create",
        "type": "MCP Tool",
        "title": "Create Order",
        "body": "# Create Order\n\nCreates a validated order.",
        "tags": ["orders", "mcp"],
        "sources": ["/repositories/orders-service.md"],
        "relations": [
          { "type": "related_to", "target": "/workflows/order-creation.md" }
        ]
      }
    ]
  }
}
```

创建路径是可选的。服务器首先使用请求前缀内现有同类型概念的强主目录约定，然后回退到确定性的类型/标题 slug。`okf_suggest_concept_path` 报告策略、证据、路径可用性和同类型/标题匹配，以便可用文件名不会被误认为是安全的重复。更新标识现有 `uri`；过时的定位符返回有界的可能替换，而标量字段替换现有值，`tags`、`sources` 和 `relations` 使用显式的 `add`/`remove` 补丁。`metadata` 携带扩展 frontmatter，但不能覆盖标识、生成、集合或计算字段。路径和 URI 在更新期间不可变：移动概念会更改其可移植标识，这是一个单独的、有意不支持的操作。

每个 1-100 项批量作为一个未来图进行验证，因此一起创建的概念可以相互引用，同类型/标题冲突会在创建和更新中被检测。使用完整的目标批量调用 `okf_validate_changes` 以在不写入文件的情况下接收检查时预览。验证和应用共享相同的规划器；应用在写入队列下重复每次检查，因为修订和 Git 状态可能在预览后更改。紧凑回执是 v0.8 默认值；传递 `detail: "full"` 获取 v0.7 规划布局。效果暴露结构化关系，并将服务器管理的生成溯源与实质性的 `changedFields` 分离。

除非每个候选项都有效、修订检查仍匹配且每个目标保持在一个可写 bundle 内，否则服务器不写入任何内容。进程生成的文档、生成器输出目录、隐藏/控制平面路径（如 `.git/**`）、保留文件和已验证计算合约不是实时写入目标。回滚在每个恢复前立即检查修订，并将检测到的替换报告为部分 `rollback_conflict`。该保护在文档化的单外部写入器要求下是尽力而为；它不是跨进程比较并交换保证。

添加 `--git-commit` 作为服务器策略，为每个成功批量创建一个提交。检测到的 Git 工作树必须完全干净，并在发布前配置身份。活动的 Git 过滤器属性和 `assume-unchanged`/`skip-worktree` 索引标志会阻止操作，因此验证无法执行配置的过滤器或忽略隐藏的用户更改；替换对象解析被禁用，因此隐藏的替换历史无法更改父树。服务器从验证的 Markdown 字节构建隔离索引，使用 `commit-tree` 创建该精确树，通过比较并交换 ref 更新发布它，之后仅同步受影响的普通索引路径，且从不推送。并发无关的暂存条目无法进入提交。确定的提交失败会将匹配的有效文件保留为仅工作树文件；模糊的 ref 更新超时会被报告为未知，除非生成的提交树可以被证明。非 Git 目录正常写入。每个响应都使仓库根、提交状态、索引状态、目标字节状态和持久性边界显式化。

## 创作概念

可通过使用 `--authoring` 启动的 MCP 工具和 HTTP API 使用可审查的提案工作流。客户端从不需要直接的本地文件访问。

MCP 提案流程：

```json
{
  "name": "okf_propose_concept",
  "arguments": {
    "path": "tools/create-order.md",
    "frontmatter": {
      "type": "MCP Tool",
      "title": "Create Order",
      "relations": [
        {
          "type": "related_to",
          "target": "/workflows/order-creation.md"
        }
      ]
    },
    "body": "# Create Order\n\nCreates an order through the application MCP tool.",
    "message": "Document create_order for agents."
  }
}
```

然后使用返回的 `proposal.id` 调用 `okf_accept_proposal`。

要更正现有概念，使用 `get_concept` 读取它，然后仅提议需要更改的字段：

```json
{
  "name": "okf_propose_update",
  "arguments": {
    "uri": "okf://app/tools/create-order",
    "frontmatter": {
      "title": "Create Order Tool",
      "description": "Creates a validated order."
    },
    "removeFrontmatterKeys": ["deprecatedField"],
    "message": "Correct outdated tool metadata."
  }
}
```

省略的 frontmatter 字段和省略的正文会被保留。概念 URI 无法通过更新更改。每个更新提案记录源文件修订，接受时会在替换文件前再次检查，因此检测到的并发更改会被拒绝。

安全规则：

- 概念路径必须是安全、非隐藏的可写 bundle 内相对 `.md` 路径
- 概念写入不能遍历可写 bundle 下的符号链接
- 仅在提案被接受时才创建缺失的子目录
- `index.md` 和 `log.md` 不能作为概念进行创作
- 重复的路径和重复的 `okf://` ID 会被拒绝
- 更新不能更改概念标识，拒绝在提案创建后检测到的更改
- 无效的 ID、无效的关系类型和损坏的内部 OKF 关系验证失败
- 允许外部关系目标（如 `repo://...`）
- 直接批量在一个进程内序列化，并在发布前验证组合的未来图
- 独立进程仍需要外部单写入器协调

## HTTP API

启动 HTTP 服务器：

```bash
OKF_WRITE_TOKEN=change-me okf --root /path/to/catalog serve --host 127.0.0.1 --port 8765
```

读取/验证端点：

- `GET /health`
- `GET /v1/bundles`
- `POST /v1/concepts/validate`
- `POST /v1/concepts/suggest-path`

提案检查和变更端点需要 `Authorization: Bearer <OKF_WRITE_TOKEN>`，因为待处理记录可能包含完整的候选 Markdown 和计算代码：

- `GET /v1/proposals`
- `GET /v1/proposals/:id`
- `POST /v1/proposals`
- `POST /v1/proposals/update`
- `POST /v1/proposals/:id/accept`
- `POST /v1/proposals/:id/reject`

默认的基于文件的提案存储将提案 JSON 写入选定根或项目下的 `.okf-proposals`。接受的提案将 Markdown 概念写入选定的本地根。

`POST /v1/concepts/validate` 和 `POST /v1/concepts/suggest-path` 不持久化任何内容。`POST /v1/proposals` 仅持久化提案记录。只有 `POST /v1/proposals/:id/accept` 写入概念 Markdown 文件。

## 远程 Bundle

远程 bundle 允许一个工作区消费另一个仓库发布的概念，而无需将它们 vendor 化。对于主机无关的设置，从任何 Git 主机克隆或挂载 OKF 仓库，并通过 `--root` 传递其目录；传输和同步仍在 OKF 规范之外。

支持的源：

- 公共 GitHub 仓库树 URL：`https://github.com/<owner>/<repo>/tree/<ref>/<path>`

远程加载：

- 盘点树，首先获取选定的 `.md` 文档，然后仅获取明确引用的 bundle 本地资源
- 记录解析的修订元数据、SHA256 摘要、文档/资源字节数和未解析的引用
- 盘点远程路径但从不下载未引用的 `.sql`、`.py` 或二进制文件内容
- 在其配置的 bundle ID 下保留每个远程 bundle
- 支持 `include` 和 `exclude` 过滤器
- 解析远程 bundle 路径内的 Markdown 链接
- 强制执行文件数量和字节限制
- 不执行来自远程仓库的代码

CLI 示例：

```bash
okf --remote-bundle shared=https://github.com/example/okf-atlas/tree/main/bundles/shared --inspect
okf --project okf.project.yaml --remote-bundle vendor=https://github.com/example/vendor-okf/tree/main/bundles/catalog validate
```

MCP 运行时加载：

在调用 `load_remote_bundle` 前启动带有 `--allow-remote-tool` 的 MCP 服务器。

```json
{
  "name": "load_remote_bundle",
  "arguments": {
    "id": "shared",
    "url": "https://github.com/example/okf-atlas/tree/main/bundles/shared",
    "include": ["public/**"]
  }
}
```

使用 `list_remote_bundles` 检查已加载的内容。

## 结构化搜索

`search_concepts` 接受：

- `query`
- `bundle`
- `types`
- `tagsAny`
- `tagsAll`
- `pathPrefix`
- `frontmatter`
- `linkedTo`
- `linkedFrom`
- `relationType`
- `orphanOnly`
- `statuses`
- `trustTiers`
- `freshness` 和确定性的 `asOf`
- `hasSources`
- `runtime` 和 `attestationReady`
- `generatedBy` 和 `verifiedBy`
- `detail`（默认 `compact`，或 `full`）
- `limit`
- `offset`

`list_concepts` 也接受文本 `query`，并将其与列表过滤器一起应用。文本搜索不区分大小写地分词，并要求每个查询词（无论顺序）。BM25+ 对标题、类型、标签、别名、描述、路径和正文匹配进行排名；frontmatter 仍可通过精确结构化过滤器访问，但不会复制到文本索引中。分数在结果集内是相对的，不是稳定的跨版本比例。紧凑结果仅包含 `uri`、`title`、`type` 和 `description`；标题、类型和描述是有界的，而完整结果是无损的。

查询限制为 512 个字符和 16 个词。有意禁用前缀扩展、模糊匹配、词干提取和停用词删除，以便代码标识符和领域术语保持原样。仅标点符号查询不返回匹配。标签和类型不区分大小写地匹配。任意 frontmatter 过滤器支持精确标量匹配和数组包含匹配。`relationType` 选择具有该类型出向关系的概念。

SDK 回归套件还为实际序列化 MCP 文本预算中性的四步研究路径。它使用 UTF-8 字节除以四作为确定性估计，而非精确的模型分词器或计费计数，并保护绝对紧凑预算和紧凑/完整比例。

示例：

```json
{
  "query": "catalog",
  "types": ["API Route"],
  "tagsAll": ["api", "orders"],
  "limit": 10
}
```

对于本地相关性和性能检查，使用 bundle 根和可选的 `{ "query": "...", "expected": "path/or/concept-id" }` 判断 JSON 数组运行非打包开发基准：

```bash
node --expose-gc scripts/search-benchmark.js \
  --root /path/to/okf \
  --qrels /path/to/qrels.json
```

它报告 OKF 和搜索索引构建时间、保留的堆/RSS、p50/p95 查询延迟、Recall@10、MRR@10 和代表性排名。搜索索引是进程本地的，以解析的 OKF 索引为键，因此远程加载和接受的提案会自动获得新鲜索引。

## 图行为

作为 okf-mcp 图投影，Markdown 链接变成 `markdown_link` 边，扩展 `relations` 变成类型化的 `relation` 边，标准 v0.2 路径值字段变成 `resource`、`source`、`computation`、`executor` 和 `attester` 边。内部概念引用解析为规范节点；明确引用的非 Markdown 文件解析为 okf-mcp `okf-asset://` 节点；URL 和范围描述符保持为未获取的外部或不透明叶子。

为了导航方便，当没有精确文档目标时，okf-mcp 将链接解析到嵌套 bundle 目录的保留 `index.md`。这适用于本地和远程 bundle 以及提案创作期间的候选验证。

图工具返回有界的 JSON：

```json
{
  "nodes": [
    {
      "id": "okf://app/routes/order-status",
      "bundle": "app",
      "path": "routes/order-status.md",
      "type": "API Route",
      "title": "Order Status Route",
      "tags": ["api", "orders"],
      "description": "Serves order status state."
    }
  ],
  "edges": [],
  "warnings": []
}
```

首先使用 `graph_summary` 获取按生命周期、信任、新鲜度、运行时、就绪度和边类型的计数。图工具接受 `edgeKinds`；当需要这些叶子节点时，传递 `includeExternal: true` 或 `includeAssets: true`。

默认关系类型：

- `depends_on`
- `produces`
- `consumes`
- `persists_to`
- `materializes_to`
- `configured_by`
- `checked_by`
- `owned_by`
- `supersedes`
- `related_to`

使用 `okf.project.yaml` 中的 `relationTypes` 添加项目特定的关系类型。

`bundles` 和 `plugins` 中的项目路径必须是保持在包含 `okf.project.yaml` 的目录内的相对路径。绝对路径和 `../` 转义会被拒绝。

Bundle `include` 和 `exclude` 过滤器使用简单的路径模式：

- 精确文件路径，如 `services/order-status.md`
- 目录前缀，如 `archive/`
- `*` 匹配一个路径段
- `**` 匹配任意嵌套路径

## 验证

`validate`、`validate_bundle` 和 `validate_project` 返回单独的 `conformant` 和 `validForProject` 字段以及结构化诊断。`valid` 仍是 `validForProject` 的兼容性别名。

OKF 符合性覆盖（当相应文件存在时）：

- 非保留概念文档上的可解析 YAML 映射 frontmatter
- 非空的 `type`
- `index.md` 和 `log.md` 的保留结构

未知的 frontmatter 键和未知的概念类型值不会导致符合性失败。YAML 解析器支持嵌套映射、数组、块标量和其安全 YAML 核心模式接受的其他结构；重复的键和不支持的自定义标签会被拒绝。

缺失的 `index.md` 文件和损坏的交叉链接不会导致 OKF 符合性失败。`strictLinks` 仅影响 okf-mcp 工作区有效性（`validForProject`），而非规范的 `conformant` 结果。

项目有效性还额外报告：

- 重复的 OKF URI
- 损坏的内部 Markdown 链接作为默认建议；设置项目 `strictLinks: true` 或传递 `--strict-links` 使其成为项目无效
- 无效的关系类型
- 缺失的关系目标
- 损坏的 `okf://` 关系目标
- 重复的 bundle ID
- 无效或转义的项目路径
- 解析到配置的 bundle 根之外的链接
- 缺失的 bundle 根

服务器继续从部分 bundle 提供有效概念。

可选的 v0.2 族被规范化为 `signals`。格式错误的溯源、生成、验证、生命周期、新鲜度或计算元数据会产生建议，且永远不会创建第四个信任层级。验证失败关闭到 `unverified`；缺失状态默认为 `stable`；当提供显式 `asOf` 日期时评估新鲜度。创作比消费更严格，拒绝格式错误的已知 v0.2 字段。

## 已验证计算

`inspect_attested_computation` 报告运行时、声明的参数、核准的内联或文件计算摘要、执行器回执字段、验证器引用、索引资源、就绪度和诊断。`prepare_attested_computation` 检查声明的参数名称并返回摘要，不返回值。`check_computation_receipt` 检查字段存在性，不返回值、不持久化回执或声称验证。

okf-mcp 没有执行或验证适配器。它从不运行计算、执行器资源或验证器资源，也从不按需获取外部合约 URI。

CLI 等效功能通过 `computation inspect|prepare|check-receipt`、`provenance`、`edge-kinds` 和 `asset` 提供。使用 `--parameters-file <path|->` 或 `--receipt-file <path|->` 提供敏感值；原始参数和回执 JSON 有意在进程参数中被拒绝。`-` 从 stdin 读取一个 JSON 对象。资源读取接受 `--max-content-bytes`，上限为索引的 1 MiB 限制。

## 迁移现有目录到 v0.2

v0.2 规范通过两个回退保持 v0.1 bundle 可消费：当 `generated` 不存在时的遗留 `timestamp`，以及当 `sources` 不存在时的遗留正文 `# Citations` 列表。okf-mcp 在读取期间应用这些回退，并提供可选的仅审查转换工作流。

对于单个根，检查迁移就绪性并预览提议的原生字段，不写入任何内容：

```bash
okf --root /path/to/catalog migrate check
okf --root /path/to/catalog migrate preview \
  '{"metrics/revenue.md":{"by":"human:owner","confirmed":true}}'
```

在可选的多根项目模式下，在行为者映射 JSON 前提供根 ID。

迁移有意保持保守：

- 原生 `generated` 和 `sources` 字段始终优先
- 仅在显式确认真实 `by` 行为者后，才将有效的 `timestamp` 复制到新的 `generated: { by, at }` 映射
- `# Citations` 仅当来自一个顶级 H1 部分，包含至少一个可安全解析的列表条目，且没有未解析的散文、嵌套部分、歧义条目或转义路径时，才变为 `sources`
- 遗留字段和引用散文为兼容性保留
- 通过 `--generated-path`、文档标志或 `generated_file`/`generatedFile` frontmatter 标记的概念必须通过其生成器更改；远程根仅为报告
- 身份冲突、无效文档、不安全引用和未解析资源会阻止版本声明

`okf_propose_v02_migration` 需要本地根创作。它创建审查清单、每个受影响文件一个提案，以及一个有门控的根 `okf_version: "0.2"` 提案。没有任何内容被自动接受；只有在每个子提案被接受且完整目录验证通过后，才能接受根提案。

## 生成器插件

生成器插件在 `okf.project.yaml` 中配置，通过 `generate` 运行。

内置插件：

- `filesystem`：为每个匹配的源文件创建一个概念。默认为 Markdown 文件。
- `json-spec`：为每个 JSON 文件创建一个概念，当存在目标表时可以发出 `persists_to` 关系。

生成的输出是常规的 Markdown/YAML OKF，由与手工创作概念相同的索引器验证。

## 限制

- MCP 支持 stdio 和 Streamable HTTP。企业快速发布应使用经过认证的 `hosted` 组合模式；独立的 `mcp --http` 只是底层传输模式，不包含 hosted 认证与 rollout API。
- MCP 协议兼容性遵循固定的官方 SDK v2 依赖。
- 没有文件监视器。外部文件更改后重启服务器。通过 MCP 创作接受的概念会立即刷新 MCP 服务器索引。
- Hosted 模式是单进程、单写入者的快速发布服务，不是分布式多租户控制平面。不要让多个写入实例共享同一个 generation 存储。
- Hosted 模式下，配置的 bundle 根只是尽力同步的兼容镜像；不可变 generation 才是实际服务数据源。
- OKF v0.2 计算支持仅限静态检查和预检；不执行任何计算或验证器。
