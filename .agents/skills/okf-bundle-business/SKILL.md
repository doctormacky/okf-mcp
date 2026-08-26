---
name: okf-bundle-business
description: >-
  Authors and updates business overlays on an existing okf-dbexplain Bundle for
  NL2SQL: datasets, relationships, enums, saved queries, and overlay index.md.
  Inventories existing business first and updates matching Concepts in place, or
  creates missing ones after the user approves a logic proposal with example SQL.
  Use when the user asks to add or update Bundle business, 语义层, 问数 semantics,
  overlay-draft, saved queries, or business indexes, or mentions token 消耗 /
  统计 with an existing database Bundle. Do not use to sync physical schema
  (okf-dbexplain) or to guess joins, enums, or SQL.
---

# Author OKF Bundle Business Overlays

在 **事实 Bundle**（`$okf-dbexplain` 已 sync）上，反复把问数意图写成 `business/` 与 `queries/`。

## 反复调用时怎么做

每一次都一样，**先探查已有 business**，再决定更新还是新建：

```text
R1 读 Bundle + dbexplain 探查 + 盘点已有 business/queries
        ↓
    同一业务已有 Concept？
      是 → 提案里写「更新这些文件」
      否 → 提案里写「新建这些文件」
        ↓
R2 逻辑提案 + SQL 例子 → 等你确认
        ↓
R3 写入（改已有 或 overlay-draft 新建）
        ↓
    必须：okf dbexplain overlay-index   ← 你不用手改 index.md
        ↓
R4 报告
```

**index.md：** 第一次 `$okf-dbexplain` sync 就已经建好空的 `business/*/index.md`、`queries/index.md`。模板只在本 Skill references 中，不进入运行时 Bundle。
你**不要手写索引页**。新建或改了 title/description 之后，跑 `overlay-index`，索引会按磁盘上的 Concept **重生**。okf-mcp 检索扫的是 Concept 文件本身；索引是给人和其他 Agent **浏览目录**用的，必须和正文一致。

## 最高优先级规则

1. **先盘点再动手**：打开 `business/datasets/index.md`、`queries/index.md`，并用 `okf search`。
2. **同一业务 → 更新，不要复制一份**。`overlay-draft` **不会覆盖**已有 dataset/relationship。
3. **先提案、后写入**；有疑点就问，不能猜。
4. 每个 semantic Concept 同时维护顶层 `relations` 与 Markdown 投影；okf-mcp 核心不解析 `semantic.*`。
5. **写完必跑 overlay-index + adapter validate**（用户不必关心 index 怎么排）。

完整协议：[references/confirmation-loop.md](references/confirmation-loop.md)

## 什么叫「同样的业务」

| 已有 Concept | 判定命中 | 本轮动作 |
| --- | --- | --- |
| `business/datasets/<slug>.md` 的 `physical_table` 就是本轮那张表 | 同表 dataset | **更新**该文件（title/aliases/description/fields/enum），不 overlay-draft 覆盖 |
| `queries/<slug>.md` 回答同一问数（同一 grain：谁、什么指标、什么时间过滤） | 同问数 query | **更新**该 SQL 与 description |
| `business/relationships/` 连接同一对 dataset | 同 join | **更新** title/description；不新建第二份 |
| `business/terms/` 绑定同一业务词 | 同术语 | **更新** aliases/bindings |
| 上表都没命中 | 新业务 | **新建**：缺的表才 `overlay-draft --tables`；新 query 新文件 |

提案里必须列出「更新 / 新建」对照表，让用户看见不会重复造一份。

## 典型用户说法

```text
请你基于 okf-bundle-business，帮我更新 test-bundle 的 Business。
业务：统计 XXXX 用户在 2026年5月的 token 消耗总量。
```

第二次又说「再加按部门汇总」→ 再走 R1：token 用量表若已有 dataset 则更新描述；新 query 新建。

## Route The Task

| Read when | Reference |
| --- | --- |
| **多轮确认 + 更新/新建** | [references/confirmation-loop.md](references/confirmation-loop.md) |
| dbexplain → business | [references/dbexplain-for-business.md](references/dbexplain-for-business.md) |
| 写清楚语义 | [references/authoring.md](references/authoring.md) |
| Workflow / overlay-index | [references/workflow.md](references/workflow.md) |
| Examples | [references/examples.md](references/examples.md) |

## 首轮最少要问清

1. **Bundle root**
2. **dbexplain label**（需要 `execute` 时）；Bundle 已足够时可先只读 Bundle
3. 用户标识等无法从注释唯一确定的字段

## Standard Procedure

### R1 — 探查 + 盘点已有 business

```bash
okf --root <bundle-root> --strict-links validate
okf --root <bundle-root> search "<关键词>"
```

必读：`business/datasets/index.md`、`queries/index.md`、命中的 dataset/query 正文、`tables/`、`observations/current.md`。

需要连库时：

```bash
dbexplain check --label <label>
dbexplain collect --label <label> --tables
# 只有表清单；需要字段/注释时读取已同步 Table Concept，或：
dbexplain collect --label <label> --table <table>
```

### R2 — 逻辑提案（不写文件）

模板见 confirmation-loop。必须含：更新哪些文件 / 新建哪些文件、SQL 例子、请用户确认。

### R3 — 写入（仅同意后）

**更新：** 直接改已有 Markdown（SQL、aliases、enum、description）。

**新建缺失的 dataset/relationship：**

```bash
okf dbexplain overlay-draft --bundle-root <dir> --tables <仅缺 dataset 的表> --dry-run
# 再 apply。已有文件会被跳过。
```

然后写/改 `queries/`，精修 title。

Agent 生成 Saved Query 时，必须先用 `dbexplain execute` 成功执行完全相同的 SQL，
再把 `process:dbexplain` verification（UTC、statement SHA-256、instance label）写入。
不得把结果行写入 Bundle。

**最后（无论更新还是新建）：**

```bash
okf dbexplain overlay-index --bundle-root <dir>
okf dbexplain validate --bundle-root <dir>
```

不要手改任何 `index.md`。不要用 `sync --dry-run` 当收尾。

### R4 — 验证

```bash
okf --root <bundle-root> --strict-links validate
okf --root <bundle-root> search "<业务词>"
```

## Hard Boundaries

- 未同意前不写 `business/`、`queries/`。
- 不覆盖用户已改语义去「重新 draft」同一文件。
- 不猜 join / 用户列 / enum。
- 不把 `execute` 结果行写入 Bundle。
- 不手写 overlay `index.md`。
- 不使用 `status: reviewed`；只使用 OKF 的 `draft/stable/deprecated`。

## Required Output

**R2：** 提案（含更新 vs 新建对照）+ SQL 例子
**R3 后：** 文件路径 + `overlay-index` 已跑 + Coverage Report
