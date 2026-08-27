# okf-mcp v0.9.0 中文使用手册

> 当前源码版本为 `0.9.0`，但目前还没有 `v0.9.0` Git Tag、GitHub Release 或正式 npm 包。
> 生产部署请固定到经过验证的完整 Git Commit SHA。

## 1. 产品角色

`okf-mcp` 可以承担三个角色：

| 角色 | 作用 |
| --- | --- |
| MCP 服务器 | 向 Agent 提供知识搜索、读取、图查询和溯源 |
| OKF Publisher | 通过 Skill 和 CLI 安全更新知识库 |
| Agent 知识源 | 让业务 Agent 通过 MCP Streamable HTTP 使用知识 |

推荐架构：

```text
发布者
  -> okf knowledge CLI
  -> Rollout API
  -> 不可变 Generation
  -> MCP 索引
  -> Agent 通过 /mcp 查询
```

读写 Token 分开：

```text
OKF_READ_TOKEN      Agent 查询知识
OKF_ROLLOUT_TOKEN   发布者下载和提交知识
```

两个 Token 必须非空且不同。

## 2. v0.9.0 主要能力

- 认证 `hosted` 模式。
- MCP Streamable HTTP。
- stdio 和 HTTP 使用同一套 MCP Tools 与 Resources。
- 不可变 Generation 和原子发布。
- `okf knowledge` 发布 CLI。
- 内置 `okf-knowledge-publisher` Skill。
- 服务端 dry-run 和有界 Diff。
- Preview 绑定、Revision 冲突检查和幂等重试。
- 发布失败恢复和损坏 Generation 回退。

---

## 3. 安装

### 3.1 环境要求

- Node.js 22 或更高版本
- Git
- 一个 OKF Bundle 目录

### 3.2 从源码安装

```bash
git clone https://github.com/doctormacky/okf-mcp.git
cd okf-mcp

# 生产环境请替换为经过验证的完整 Commit SHA
git checkout <commit-sha>

npm ci
npm test
npm run self:validate
npm run package:smoke
npm run pack:check
```

查看版本：

```bash
node bin/okf-mcp.js --version
```

预期输出：

```text
0.9.0
```

### 3.3 配置 `okf` 命令

可以直接执行源码：

```bash
node /opt/okf-mcp/bin/okf-mcp.js --help
```

也可以创建 `/usr/local/bin/okf`：

```bash
#!/usr/bin/env bash
set -euo pipefail
exec node /opt/okf-mcp/bin/okf-mcp.js "$@"
```

验证：

```bash
okf --version
okf knowledge --help
```

没有内部 npm Registry 时，可以在构建机完成验证，再分发包含 `node_modules` 的源码运行目录。详细步骤见 [源码部署说明](source-runtime-deployment.md)。

---

## 4. 准备 OKF Bundle

最简单的目录：

```text
/data/catalog/
├── index.md
├── services/
│   └── order-api.md
└── workflows/
    └── cancel-order.md
```

概念文件示例：

```markdown
---
type: Workflow
title: Cancel Order
description: 订单取消流程。
tags: [orders, cancellation]
---

# Cancel Order

只有未履约订单可以取消。
```

基本规则：

- 普通概念文件必须有 YAML frontmatter。
- `type` 不能为空。
- 路径必须位于 Bundle 内。
- 不要使用隐藏路径、`../` 或符号链接。

验证：

```bash
okf --root /data/catalog validate
```

多个 Bundle 可以使用 `okf.project.yaml`：

```yaml
project: EnterpriseKnowledge
strictLinks: false

bundles:
  - id: app
    root: bundles/app
  - id: data
    root: bundles/data
```

```bash
okf --project /data/knowledge/okf.project.yaml validate
```

---

# 角色一：部署 MCP 服务器

## 5. 启动 Hosted 服务

生产环境推荐使用 `hosted`。它在同一进程中提供：

- MCP Streamable HTTP
- 知识发布 API
- 不可变 Generation
- 当前活动索引

单 Bundle：

```bash
export OKF_READ_TOKEN='请替换为高强度读Token'
export OKF_ROLLOUT_TOKEN='请替换为高强度写Token'

okf --root /data/catalog hosted \
  --host 127.0.0.1 \
  --port 8790
```

Project 模式：

```bash
okf --project /data/knowledge/okf.project.yaml hosted \
  --host 127.0.0.1 \
  --port 8790
```

Hosted 不允许同时启用：

```text
--authoring
--write
--git-commit
--allow-remote-tool
--allow-computation-authoring
```

## 6. Hosted 端点

| 路径 | 用途 | Token |
| --- | --- | --- |
| `/mcp` | MCP Streamable HTTP | 读 Token |
| `/v1/rollout/snapshot` | 下载活动快照 | 读或写 Token |
| `/v1/rollout/status` | 查看当前 Revision | 读或写 Token |
| `/v1/rollout/dry-run` | 服务端预览 | 写 Token |
| `/v1/rollout/submit` | 发布知识 | 写 Token |
| `/health` | 健康检查 | 无 |

健康检查：

```bash
curl http://127.0.0.1:8790/health
```

Token 规则：

- MCP 只接受 `OKF_READ_TOKEN`。
- `OKF_ROLLOUT_TOKEN` 不能调用 MCP。
- dry-run 和 submit 只接受写 Token。
- Token 不要写入 Git、Bundle、Skill 或命令参数。

## 7. TLS 和反向代理

内置 Hosted 服务只提供 HTTP。生产环境建议让它绑定 `127.0.0.1`，再通过 Nginx 或企业网关提供 HTTPS。

Nginx 示例：

```nginx
location / {
    proxy_pass http://127.0.0.1:8790;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Authorization $http_authorization;
    proxy_buffering off;
    proxy_read_timeout 3600s;
}
```

## 8. 其他 MCP 模式

本地 stdio：

```bash
okf --root /data/catalog mcp
```

本机 Streamable HTTP 测试：

```bash
okf --root /data/catalog mcp --http \
  --host 127.0.0.1 \
  --port 8766
```

地址：

```text
http://127.0.0.1:8766/mcp
```

`mcp --http` 没有 Hosted 的认证和发布 API，不建议用于生产。非 Loopback 地址默认被拒绝；`--insecure-http` 会关闭该保护。

## 9. MCP Tools

Bundle 和概念：

```text
list_bundles
list_concepts
get_concept
search_concepts
list_types
list_tags
list_relation_types
list_edge_kinds
```

图查询：

```text
get_graph
get_neighbors
get_subgraph
find_paths
graph_summary
export_graph
```

溯源、资源、验证和静态计算：

```text
get_provenance
read_bundle_asset
read_git_source
inspect_attested_computation
prepare_attested_computation
check_computation_receipt
check_v02_migration
validate_bundle
validate_project
list_remote_bundles
```

Hosted 不提供写入和运行时加载工具，例如：

```text
load_remote_bundle
okf_propose_concept
okf_propose_update
okf_accept_proposal
okf_validate_changes
okf_apply_changes
```

知识发布统一使用 `okf knowledge` CLI。

---

# 角色二：发布 OKF 知识

## 10. 发布流程

内置 Skill：

```text
.agents/skills/okf-knowledge-publisher/SKILL.md
```

标准流程：

```text
download
  -> enrich
  -> server dry-run
  -> explicit confirmation
  -> submit
  -> MCP verify
```

## 11. 下载当前知识

```bash
export OKF_ROLLOUT_TOKEN='publisher-write-token'

okf knowledge download \
  --url https://knowledge.internal.example \
  --out ./okf-work
```

多个 Bundle 时：

```bash
okf knowledge download \
  --url https://knowledge.internal.example \
  --bundle app \
  --out ./okf-work
```

工作区会生成 `.okf-knowledge.json`，用于保存 Revision、Preview 和幂等信息。它不保存 Token，也不要手工修改。

## 12. 编辑知识

在工作区中创建、修改或删除 Markdown 文件。

注意：

- 删除文件表示请求删除远端概念。
- 不要使用符号链接。
- 不要编造来源、Schema、URL 或业务事实。
- 保留不认识的 frontmatter 扩展字段。

## 13. 服务端 Dry-run

```bash
okf knowledge submit \
  --workspace ./okf-work \
  --dry-run
```

服务端会返回：

- 新增、修改和删除的文件
- OKF 验证结果
- 有界 `diffText`
- Preview ID
- Candidate Digest
- Preview 过期时间

默认限制：

```text
每文件 Diff 最多 8 KiB
总 Diff 最多 64 KiB
Preview 有效期 15 分钟
```

如果 Diff 被截断，应额外检查完整文件。

## 14. 确认并提交

```bash
okf knowledge submit \
  --workspace ./okf-work \
  --preview-id <preview-id> \
  --message "补充订单取消流程"
```

CLI 会再次显示服务端 Diff，并要求输入 `y` 或 `yes`。

如果 Preview 后工作区发生变化，需要重新 dry-run。

自动化可以显式使用 `--yes`，但它不会绕过 Preview、Revision、Digest、验证或幂等检查。

## 15. 处理 409 冲突

收到 `409 Conflict` 时：

1. 停止提交。
2. 重新下载最新快照。
3. 合并本地修改。
4. 重新 dry-run。
5. 重新人工确认。
6. 使用新的 Preview 提交。

不要强制覆盖。当前没有 `--force`，也没有服务器端自动合并。

## 16. 发布后验证

查看状态：

```bash
okf knowledge status \
  --url https://knowledge.internal.example \
  --bundle app \
  --json
```

然后通过 MCP 调用：

```text
get_concept
search_concepts
get_neighbors 或 get_graph
```

如果 submit 已成功但 MCP 暂时不可用，不要重复提交。记录已发布 Revision，稍后重新验证。

---

# 角色三：配置 Agent 使用知识

## 17. Streamable HTTP 配置

不同 Agent 平台的配置格式可能不同。常见形式：

```json
{
  "mcpServers": {
    "okf": {
      "transport": "streamable-http",
      "url": "https://knowledge.internal.example/mcp",
      "headers": {
        "Authorization": "Bearer <OKF_READ_TOKEN>"
      }
    }
  }
}
```

有些客户端不需要 `transport` 字段，请以客户端文档为准。

必须满足：

- URL 指向 `/mcp`。
- 使用 MCP Streamable HTTP。
- 请求带 `Authorization: Bearer <OKF_READ_TOKEN>`。
- 不要给业务 Agent 配置 `OKF_ROLLOUT_TOKEN`。

## 18. stdio 配置

```json
{
  "mcpServers": {
    "okf": {
      "command": "node",
      "args": [
        "/absolute/path/to/okf-mcp/bin/okf-mcp.js",
        "--root",
        "/absolute/path/to/catalog",
        "mcp"
      ]
    }
  }
}
```

## 19. 推荐查询顺序

```text
list_bundles
  -> search_concepts 或 list_concepts
  -> get_concept
  -> get_neighbors 或 get_graph
  -> get_provenance
```

MCP 客户端会自动处理初始化、工具发现和资源读取，不建议用普通 `curl` 手工模拟完整 MCP 会话。

---

## 20. Generation 和备份

Hosted 使用不可变 Generation 提供知识，不会持续读取原始 Bundle Root。

默认目录：

```text
Root 模式:    <root父目录>/.<root目录名>.okf-generations
Project 模式: <project-root>/.okf-generations
```

发布时会验证完整候选，然后原子切换活动 Generation 和 MCP 索引。

注意：

- 当前 Hosted CLI 默认不会把发布内容回写到原始 Bundle Root。
- 备份和状态检查应以 Generation Store 为准。
- 活动 Generation 损坏时会尝试回退。
- 全部 Generation 损坏时 Hosted 拒绝启动。
- 默认保留数量有限，不能替代正式备份。

## 21. 数据库直接生成 OKF Bundle

安装并配置 dbexplain v0.1.11 或更高版本后，先检查运行时和配置选择。兼容的
未来版本无需更新 okf-mcp；CLI/JSON 契约变化时会返回 issue 地址。Agent 不读取
`.env.dbexplain` 内容；显式配置文件通过子进程环境变量传递：

```bash
dbexplain --version
okf dbexplain --help
okf dbexplain inspect --include prod-main
okf dbexplain check --include prod-main
```

配置中的每个 SQL DSN 都必须有唯一且稳定的 `?label=`。一个同步可以选择多个
label，生成一个专用 Bundle。首版 query-ready 生成支持 MySQL、PostgreSQL、
GaussDB、SQLite 和 Oracle；其他数据库类型会在写入前失败。

先做不写文件的预览：

```bash
okf dbexplain sync \
  --include prod-main \
  --bundle-root /data/okf/prod-database \
  --generated-at 2026-08-25T09:00:00Z \
  --dry-run
```

确认 `changes`、声明/推断关系数量、Observation 刷新数和 OKF 验证结果后，用原
参数和 `planDigest` 写入：

```bash
okf dbexplain sync \
  --include prod-main \
  --bundle-root /data/okf/prod-database \
  --generated-at 2026-08-25T09:00:00Z \
  --expect-plan sha256:<plan-digest>

okf dbexplain validate --bundle-root /data/okf/prod-database
```

apply 会重新采集。只有运行指标变化时 Observation 使用最新值；结构或关系变化
会返回 `planChanged: true` 并保持旧 Bundle 不变，需要重新 dry-run 和确认。

生成结果的核心边界：

- 表路径为 `tables/<label>/<namespace>/<table>.md`，仅在碰撞时追加 hash。
- Table 带 binding v2、方言化 source 和逐列 SQL 标识符；声明 FK 带结构化 Join
  模板和机械校验的 cardinality。
- 推断引用是 `draft` 且未验证，不是批准的业务 Join。
- 行数、容量、运行统计和诊断与 Table Schema 分离。
- 消失对象保留并标记 `deprecated`，再次出现时恢复原身份。
- 不保存原始 JSON、DSN、主机、凭据、Sample Rows 或配置内容。
- 物理目录按 label/database 生成分层 reserved indexes；overlay 只生成空索引，模板留在 Skills，避免污染 MCP 搜索。
- `semantic.profile: dbexplain-okf-v1` 是原样保存的扩展；同一知识同时投影到现有 `relations` 和 Markdown body，通用 okf-mcp 无需理解数据库字段。
- Agent 生成的 Saved Query 必须先经 `dbexplain execute` 成功执行并由用户确认，再记录 SQL digest verification；结果行不进入 Bundle。
- 物理事实同步、Business 知识丰富和真实问数是可独立安装的能力；任何 Skill 都不假设其它 Skill 已安装。

## 22. 常见错误

| 错误 | 原因 | 处理 |
| --- | --- | --- |
| `401` | 没有 Token | 配置正确的 Token |
| `403` | Token 错误或角色不对 | MCP 用读 Token，发布用写 Token |
| `409` | Revision、Preview 或幂等冲突 | 重新下载并 dry-run |
| `422` | Preview、Digest、路径或验证失败 | 按错误详情修复 |
| `404` | Bundle、Preview 或资源不存在 | 用 `list_bundles` 核对 |
| Preview expired | 超过 15 分钟 | 重新 dry-run |
| Diff truncated | Diff 超过限制 | 检查完整文件 |
| MCP 无法连接 | URL、TLS、代理或 Token 错误 | 检查 `/mcp` 和读 Token |
| 修改 Root 不生效 | Hosted 不监听 Root | 使用 Publisher 流程 |
| Hosted 拒绝启动 | Generation 损坏 | 从备份恢复 |
| 请求过大 | 超过 8 MiB | 减少内容或拆分 Bundle |

## 23. 生产检查清单

- [ ] 固定到完整 Git Commit SHA。
- [ ] `npm test` 通过。
- [ ] `npm run self:validate` 通过。
- [ ] `npm run package:smoke` 通过。
- [ ] `npm run pack:check` 通过。
- [ ] Hosted 绑定 Loopback，并通过 HTTPS 暴露。
- [ ] 读写 Token 非空且不同。
- [ ] Agent 只有读 Token。
- [ ] Publisher 只有写 Token。
- [ ] Generation Store 已备份。
- [ ] submit 后 MCP 能读取新内容。
- [ ] 重启后仍使用相同活动 Revision。

## 24. 当前限制

- Hosted 是单进程、单写入者服务。
- 不支持多个写实例共享 Generation Store。
- 不支持分布式锁和服务器端自动合并。
- 请求体默认上限为 8 MiB。
- 一次候选最多 5000 个 Markdown 文件。
- 没有内置 TLS。
- 没有向量数据库或 Embedding 服务。
- Hosted 不开放 MCP 写工具和运行时远程 Bundle 加载。
- Attested Computation 仅做静态检查，不执行计算。

## 25. 版本和上游

当前源码版本：

```text
0.9.0
```

当前最高 Git Tag：

```text
v0.8.0
```

目前没有 `v0.9.0` Tag、GitHub Release 或正式 npm 包。生产部署请使用 `0.9.0 + 完整 Git Commit SHA`。

本 fork 基于：

```text
https://github.com/mfdaves/okf-mcp
```

项目继续遵循 MIT License，并保留原项目及贡献者署名。
