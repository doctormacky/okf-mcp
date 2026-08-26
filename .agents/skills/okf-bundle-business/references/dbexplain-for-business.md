# dbexplain 命令 → 生成 Business（问数准备）

本技能的核心：**用 dbexplain 官方命令收集事实、验证问法，再用 `overlay-draft`
生成 business 骨架，最后写清楚语义。**

## 端到端流水线

```text
┌──────────────────────────────────────────────────────────────┐
│  Phase A  dbexplain 探查                                      │
│  check · --context · collect · execute（只读）                │
└────────────────────────────┬─────────────────────────────────┘
                             │ 拓扑 / 诊断 / 注释 / 验证 SQL
                             ▼
┌──────────────────────────────────────────────────────────────┐
│  Phase B  物理层入 Bundle（按需，$okf-dbexplain）              │
│  okf dbexplain sync → tables/ · declared/ · observations/    │
└────────────────────────────┬─────────────────────────────────┘
                             │ 固化事实
                             ▼
┌──────────────────────────────────────────────────────────────┐
│  Phase C  生成 business 骨架                                  │
│  okf dbexplain overlay-draft --tables …                      │
└────────────────────────────┬─────────────────────────────────┘
                             │ datasets · relationships · enum
                             ▼
┌──────────────────────────────────────────────────────────────┐
│  Phase D  写清楚 + 问数样板                                   │
│  精修 aliases/description/synonyms · queries/ · terms/       │
└──────────────────────────────────────────────────────────────┘
```

**原则：** dbexplain 发现什么，就用来**生成或验证** business；不空探查、不猜业务 scope。

---

## 命令速查：每条命令帮 business 生成什么

### P0 — 开工必用

| 命令 | 读什么 | → 生成 / 支撑什么 business |
| --- | --- | --- |
| `dbexplain check --label <L>` | 连通性 | 能否继续 collect/execute |
| `dbexplain --context ./ctx --label <L>` | `summary.json` `topology.json` `diagnostics.json` | **scope 表建议**、relationship 路径、问数风险提示 |
| `dbexplain collect --label <L> --tables` | 紧凑表名、engine、row count | scope 清单、与 Bundle 对比是否需 re-sync |

### P1 — 问数验证与样板 SQL

| 命令 | 读什么 | → 生成什么 business |
| --- | --- | --- |
| `dbexplain collect --label <L> --table <T>` | scope 表字段、类型、注释 | 确认时间列、状态列与 enum 依据 |
| `dbexplain execute --label <L> '<SQL>'` | columns + rows | 用户确认后 → **`queries/<slug>.md`** |
| `dbexplain execute --dsl '…'` | 跨库验证 | 跨 label join 的 query 样板（用户确认后写入） |

### P2 — 变更感知

| 命令 | 用途 |
| --- | --- |
| `dbexplain diff --cache …` | 注释/结构变更 → 提示 re-sync 再 overlay-draft |

---

## dbexplain 输出 → business 工件映射

| dbexplain 事实 | 来源 | business 工件 | 生成方式 |
| --- | --- | --- | --- |
| 表 + 列 + 类型 | collect / sync → `tables/` | `business/datasets/*.md` fields | **overlay-draft** |
| 列注释 `[1:运行,2:成功]` | collect / sync | field `enum.values` | **overlay-draft** |
| 时间列逻辑类型 | sync `default_is_time` | `dimension.is_time` | **overlay-draft** |
| 声明 FK | topology refs / sync `declared/` | `business/relationships/*.md` | **overlay-draft** |
| 子图 / 聚类 | `--context` topology | Business Plan scope | 你规划 → 用户确认 |
| 无主键 / 无时间列 / 宽表 | diagnostics | dataset `description` 约束 | 你撰写 |
| 验证过的 SELECT | `execute` | `queries/*.md` | 你写入（用户确认） |
| 用户口语 | 对话 | `aliases` `synonyms` `terms/` | 你撰写 |
| 跨库 refs | topology | Plan 中标注；query 用 DSL 验证 | execute 后写 query |

**不自动生成：** inferred 关系、无注释的 enum code、metrics。

---

## 推荐探查顺序（生成 business 前）

```bash
# 1. 连通
dbexplain check --label <label>

# 2. 拓扑 + 诊断（定 scope、写 Plan）
dbexplain --context ./ctx --label <label>
# 读 ctx/topology.json、ctx/diagnostics.json、ctx/summary.json

# 3. 紧凑表清单（不含完整字段/注释）
dbexplain collect --label <label> --tables

# 4. Bundle Table Concept 不足时，对 scope 表完整采集
dbexplain collect --label <label> --table <table>

# 5. Bundle 对齐
okf --root <bundle-root> validate
okf --root <bundle-root> search "<关键词>"
```

**对比 collect 与 Bundle `tables/`：**

| 情况 | 下一步 |
| --- | --- |
| 注释/列在 collect 有、Bundle 无 | `$okf-dbexplain` re-sync |
| 一致 | 直接 `overlay-draft --tables` |
| Bundle 无该表 | sync 后再 draft |

---

## overlay-draft：dbexplain 事实的机械落地

```bash
okf dbexplain overlay-draft \
  --bundle-root <bundle-root> \
  --tables taiyi_agent_run,t_employee \
  --dry-run
```

| 输入（来自 sync 的 dbexplain 事实） | 输出 business |
| --- | --- |
| `sql_binding.columns` | `semantic.fields[]` |
| column `comment` 含枚举 | `enum.values` |
| `default_is_time` | `dimension.is_time` |
| scope 内 executable declared FK | `business/relationships/*.md` |

dry-run 检查：`datasetsDrafted`、`relationshipsDrafted`、`validation.validForProject`。

已有 business 文件**跳过**不覆盖——增量加表可再跑。

---

## execute → queries/（R2 验证，R3 写入）

用户有问数意图、无现成 SQL：

**R2（提案，不写文件）：**

1. 读取已同步 Table Concept；必要时 `collect --table` 确认列名与注释。
2. 构造只读 `SELECT`（显式 `WHERE` 时间/状态）。
3. `dbexplain execute` — 验证可执行，结果摘要放进**逻辑提案**。
4. 请用户确认整份提案。

**R3（用户同意后）：**

5. 写入 `queries/<slug>.md`：唯一 SQL fence + `relations` + Markdown 表链接 +
   `process:dbexplain` verification；`overlay-draft` 覆盖涉及表。

示例：

```text
问数：「XXXX 用户 2026年5月 token 总量」

R1 collect → usage 表 + employee 表
R2 提案 SQL + execute 样例 → 「请确认是否写入 test-bundle？」
用户 OK → R3 overlay-draft + queries/token-usage-by-user-month.md
```

**边界：** `DISTINCT`/`GROUP BY` 可辅助理解取值，但 **enum label 仍以列注释或用户确认为准**。

---

## topology → scope 与 relationship

读 `topology.json`：

```text
subgraph "agent"
  thread → session → run → employee
```

生成 business 时：

1. Plan 覆盖问数路径上的表（用户确认）。
2. 一次 `overlay-draft --tables thread,session,run,employee`。
3. declared FK 自动出 relationship；你补 **title/description** 业务语义。

跨 label `refs[]`：在 Plan 标明；用 `execute --dsl` 验证后写 query，不猜 join。

---

## diagnostics → 写进 business 描述

从 `diagnostics.json` 或 Bundle `observations/current.md`：

```markdown
### 问数约束（dbexplain diagnostics）
- taiyi_agent_run：宽表 → fields 裁剪
- audit_x：无主键 → 不建议作明细主表
- run → employee：FK 未索引 → 大表聚合可能慢
```

写入 dataset `description`，让问数 Agent 少踩坑。

---

## 与 $dbexplain-skill / $okf-dbexplain 分工

| 场景 | 用谁 |
| --- | --- |
| 连库 check/collect/context/execute | `dbexplain` CLI（遵循 `$dbexplain-skill` 安全规则） |
| 物理层写入 Bundle | `$okf-dbexplain` sync（用户批准 plan） |
| **生成 business 文件** | **本技能**：overlay-draft + 精修 |
| 只刷新物理、不写 business | `$okf-dbexplain` only |

---

## 问数支撑度自检

- [ ] scope 表均有 dataset，`description` 说明 grain
- [ ] 过滤列有 enum（注释）或用户确认含义
- [ ] 时间列 `is_time` 或 description 指明
- [ ] declared FK 有 relationship + 可读 title
- [ ] top 问数有 `queries/`（用户 SQL 或 execute 验证后）
- [ ] aliases/synonyms/terms 覆盖用户口语
- [ ] `okf search "<词>"` 命中
- [ ] semantic target 同时存在顶层 `relations` 与 Markdown links
- [ ] `okf dbexplain validate --bundle-root <dir>` 通过

完整检查表见 [authoring.md](authoring.md#问数清晰度检查表)。
