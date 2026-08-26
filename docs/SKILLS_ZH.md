# 内置 Agent Skills

[English](SKILLS.md) · [简体中文](SKILLS_ZH.md)

okf-mcp 在 `.agents/skills/` 下提供四个 Skill。做数据库问数时，通常按顺序用 **三个**：

```text
okf-dbexplain  →  okf-bundle-business  →  （可选）okf-knowledge-publisher
```

在 Agent 宿主（Cursor、Codex 等）中注册该目录后，即可 `$skill名` 调用。

---

## okf-dbexplain — 同步物理事实

**路径：** [.agents/skills/okf-dbexplain/](../.agents/skills/okf-dbexplain/)

### 什么时候用

| 适用 | 不适用 |
| --- | --- |
| 从线上库首次生成 Bundle | 补 business 语义、直接回答问数 |
| schema 变更后刷新表 / 外键 / observations | `overlay-draft`、写 `business/` |
| 执行 `okf dbexplain inspect/check/sync` | 猜 join、枚举、SQL |

### 前置条件

- 已安装 [dbexplain](https://github.com/IamWWT/dbexplain) v0.1.11 或更高版本且在 `PATH` 中
- 用户自行维护 `.env.dbexplain`（Skill **不会**读写）
- 目标 `--bundle-root` 绝对路径

### 怎么调用

```text
$okf-dbexplain
请检查 prod-main，并 sync 到 /data/okf/my-database
```

### Skill 会做什么

1. `okf dbexplain inspect --include <label>`
2. `okf dbexplain check --include <label>`
3. `okf dbexplain sync ... --dry-run` → 汇报 plan → **等你确认**
4. `okf dbexplain sync ... --expect-plan <digest>` 正式写入
5. `okf dbexplain validate --bundle-root <bundle>`
6. 输出 Facts Report，提醒重启 MCP，并引导使用 `$okf-bundle-business`

### 产出（仅物理层）

- `tables/` — 列级事实
- `relationships/declared/` — 声明外键
- `observations/current.md` — 拓扑与诊断摘要
- 空的 reserved overlay 索引（`business/*/index.md`、`queries/index.md`）；模板留在 Skills 中

再次 sync 只更新物理文件；已有 `business/`、`queries/` **不会被覆盖**。

---

## okf-bundle-business — 编写 business 语义层

**路径：** [.agents/skills/okf-bundle-business/](../.agents/skills/okf-bundle-business/)

### 什么时候用

| 适用 | 不适用 |
| --- | --- |
| 增改 dataset、join、枚举、已保存 SQL | 物理层 sync（`okf-dbexplain`） |
| 在已有 Bundle 上做问数 / NL2SQL | 未经确认就猜测写入 |
| `$okf-dbexplain` 已完成之后 | 对生产库直接跑 SQL |

### 前置条件

- Bundle 已由 `$okf-dbexplain` sync
- 用户给出明确业务问题（谁、什么指标、时间范围、过滤条件）

### 怎么调用

```text
$okf-bundle-business
Bundle: /data/okf/my-database
label: prod-main
业务：统计 XXXX 用户在 2026年5月的 token 消耗总量
请先给逻辑和 SQL 例子，我确认后再写入
```

### 多轮确认（每次相同）

```text
R1  读 Bundle + dbexplain 探查 + 盘点已有 business/queries
R2  逻辑提案 + SQL 例子 → 等你明确同意
R3  更新已有文件 或 overlay-draft 新建 → 必须 overlay-index
R4  覆盖率报告（adapter validate + search）
```

### 常用命令（由 Agent 执行）

```bash
# 探查（只读）
okf dbexplain inspect --include <label>
okf --root <bundle> search "token"

# 为缺失表创建 overlay（必须带 scope）
okf dbexplain overlay-draft --bundle-root <bundle> --tables <table> ...

# 任意 business/queries 写入后 — 必跑
okf dbexplain overlay-index --bundle-root <bundle>
okf dbexplain validate --bundle-root <bundle>
```

### 硬性规则

- 同一表 / 同一问数 / 同一 join **更新原文件**，不要复制第二份
- `overlay-draft` **不会覆盖**已有 dataset 或 relationship
- **先提案、后写入**
- 同时维护匹配的 `semantic`、顶层 `relations` 与 Markdown links/body
- Agent 生成 Saved Query 前必须成功执行 `dbexplain execute` 并记录 verification
- **不要手改** `business/*/index.md`、`queries/index.md`，用 `overlay-index` 重建

---

## okf-knowledge-publisher — 发布中心知识库

**路径：** [.agents/skills/okf-knowledge-publisher/](../.agents/skills/okf-knowledge-publisher/)

### 什么时候用

| 适用 | 不适用 |
| --- | --- |
| 向 **hosted** 服务器发布/更新团队 OKF 目录 | 本地数据库 Bundle sync |
| download → 编辑 → dry-run → submit | 直接调 rollout HTTP API |
| 通过远程 MCP 验证已发布内容 | 替代 `$okf-bundle-business` 做库表语义 |

### 前置条件

- `okf hosted` 已启动，并配置 `OKF_READ_TOKEN` / `OKF_ROLLOUT_TOKEN`
- 能访问知识库服务器 URL
- 已确认服务器上的 bundle ID

### 怎么调用

```text
$okf-knowledge-publisher
从 https://knowledge.example 下载当前知识，补充新手册，dry-run 后等我确认再 submit
```

### 工作流

```text
download → 本地 enrich → okf knowledge submit --dry-run → 用户确认 → submit → MCP 验证
```

示例：

```bash
okf knowledge download --url https://knowledge.internal.example --out ./okf-work
# 编辑 ./okf-work 下文件
okf knowledge submit --workspace ./okf-work --dry-run
# 确认后：
okf knowledge submit --workspace ./okf-work
```

**读取**已发布知识始终走 **远程 MCP**（`list_bundles`、`search`、`get_concept`），不走本 Skill 的写入流程。

---

## okf-v02-migration — 旧版目录迁移

**路径：** [.agents/skills/okf-v02-migration/](../.agents/skills/okf-v02-migration/)

仅在把 OKF **v0.1** 目录迁移到 v0.2 时使用，**不属于**数据库问数主路径。

---

## 端到端示例（数据库 → Agent）

```text
# 1. 物理层
$okf-dbexplain 把 prod-main sync 到 /data/okf/smartadmin

# 2. 语义层（可多轮）
$okf-bundle-business
Bundle: /data/okf/smartadmin
业务：按部门统计 2026年5月 token 用量
… 确认提案 …

# 3. 本地 MCP，供其它 Agent 检索
okf --root /data/okf/smartadmin mcp
# → 在 Cursor / Claude Desktop 配置 stdio MCP

# 4. （可选）把运维文档发布到中心库
$okf-knowledge-publisher 发布更新后的运维手册
```

---

## 在 Cursor 中注册

将项目或用户 Skills 路径指向本仓库（或复制 `.agents/skills/` 到你的项目）。注册后用 `$okf-dbexplain`、`$okf-bundle-business` 等调用。

详见：[OKF_CLI_SOURCE_INSTALL_UPDATE_ZH.md](OKF_CLI_SOURCE_INSTALL_UPDATE_ZH.md)
