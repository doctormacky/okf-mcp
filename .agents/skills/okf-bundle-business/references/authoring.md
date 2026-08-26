# Hand Authoring — 把 business 写清楚

**仅在 R3（用户同意逻辑提案后）** 执行精修或更新已有文件。R2 不写文件。
同一表的 dataset、同一问数的 query：**改原文件，不要复制一份**。写完跑 `okf dbexplain overlay-index`，不要手改 `index.md`。

`overlay-draft` 生成骨架；你补充问数所需的 **title / aliases / description / synonyms**。
见 [confirmation-loop.md](confirmation-loop.md)。

每个 `semantic.profile: dbexplain-okf-v1` Concept 必须同时维护三种表达：

1. `semantic.*`：dbexplain-aware Agent 使用的精确 binding。
2. 顶层 `relations`：原版 okf-mcp 的通用图导航。
3. Markdown body：普通搜索与纯 Markdown 客户端使用，必须链接同一 target。

okf-mcp 核心不会索引任意嵌套 `semantic.*`；字段名、synonyms、枚举 label
必须出现在正文表格中才能被 `search_concepts` 召回。

## overlay-draft vs 人工

| overlay-draft（读 Bundle 物理层） | 你写（问数清晰度） |
| --- | --- |
| fields 列映射、datatype | `title`, `aliases`, `description` |
| comment → enum 结构 | 校对 `labels.zh`；缺注释问用户 |
| `is_time` | 确认时间轴列；description 说明过滤方式 |
| declared relationship 文件 | relationship 的 title/description |
| 全量 fields | 裁剪为问数相关列 |
| — | `queries/`、`terms/`、`synonyms` |

---

## Dataset：三张卡写清楚

### 1. 表级 — 回答「这是什么、能问什么」

```yaml
type: Semantic Dataset
title: Agent 运行记录
aliases: [运行记录, Agent Run]
description: >
  一行代表一次 Agent 执行。用于按时间范围统计 Run 数量、按 status 筛选成功或失败，
  并通过 employee_id 关联员工维度。宽表字段已裁剪为问数常用列。
status: draft
relations:
  - type: depends_on
    target: /tables/prod/app/taiyi_agent_run.md
    label: physical_table
```

正文至少包含物理表链接和 Semantic Fields 表格；更新 fields 时同步更新正文。

`description` 第一句写 **grain**（一行是什么），第二句写 **典型问法**。

### 2. 字段级 — 检索词与过滤维度

问数常涉及的列加 `synonyms`（用户说的词）：

```yaml
- name: create_time
  column: create_time
  datatype: DateTimeTz
  dimension: { is_time: true }
  synonyms: [创建时间, 运行时间, 时间]

- name: status
  column: status
  datatype: String
  synonyms: [状态, 执行结果, 是否失败]
  enum:
    values:
      - code: "2"
        labels: { en: Success, zh: 成功 }
      - code: "3"
        labels: { en: Failed, zh: 失败 }
```

enum **code** 来自 `tables/` 列注释；**label** 可与用户口语对齐，不改 code。

### 3. 约束级 — 把 diagnostics 写进描述

Bundle observations 标「无时间列」「无主键」「宽表」时，在 `description` 末尾注明，
避免问数 Agent 误用：

```yaml
description: >
  …
  注意：dbexplain 诊断本表列数较多，fields 已裁剪；明细去重请使用主键 id。
```

---

## Relationship：业务可读

```yaml
type: Semantic Relationship
title: 运行记录归属员工
description: >
  每条 Agent Run（多）对应一名员工（一），连接键 run.employee_id = employee.employee_id。
  问数时用于展示员工姓名、按员工聚合失败次数。
status: draft
relations:
  - {type: depends_on, target: /business/datasets/taiyi-agent-run.md, label: from_dataset}
  - {type: depends_on, target: /business/datasets/t-employee.md, label: to_dataset}
  - {type: depends_on, target: /relationships/declared/taiyi_agent_run__t_employee.md, label: physical_relationship}
semantic:
  profile: dbexplain-okf-v1
  kind: relationship
  physical_relationship: /relationships/declared/taiyi_agent_run__t_employee.md
  from_dataset: /business/datasets/taiyi-agent-run.md
  to_dataset: /business/datasets/t-employee.md
```

overlay join（无 FK）仅在用户确认后编写，模板见 semantic-overlay.md。

---

## 裁剪 fields（宽表）

读 observations「Wide tables」+ 用户常问列：

**保留：** PK、时间轴、`status`/类型列、主要外键、用户点名的 3–8 列
**删除：** 大 JSON blob、内部审计列、问数无关扩展字段

每保留列的 `column` 必须在物理表存在。

---

## Saved Query：问数样板

```yaml
---
type: Saved Query
title: 近 7 日失败 Run 按员工统计
description: >
  回答「最近一周各员工失败 Run 有多少次」。依赖 run.status=失败(3) 与员工 join。
  时间窗口写在 SQL 内，非参数化。
status: draft
relations:
  - {type: depends_on, target: /tables/prod/app/taiyi_agent_run.md, label: query_table}
  - {type: depends_on, target: /tables/prod/app/t_employee.md, label: query_table}
verified:
  by: process:dbexplain
  at: "2026-08-26T09:00:00Z"
  method: dbexplain_execute
  statement_sha256: sha256:<LF-normalized-SQL-digest>
  instance_label: prod
semantic:
  profile: dbexplain-okf-v1
  kind: query
  dialect: mysql
  tables:
    - /tables/prod/app/taiyi_agent_run.md
    - /tables/prod/app/t_employee.md
---
```

```sql
-- 经 dbexplain execute 成功执行、再由用户确认的完全相同 SQL
SELECT …
```

`description` 写**适用问题**，不只写「报表 SQL」。

---

## Business Term（口语消歧）

当用户说「员工」但检索可能 miss `t_employee`：

```yaml
type: Business Term
title: 员工
aliases: [职员, 用户]
relations:
  - type: related_to
    target: /tables/prod/app/t_employee.md
    label: binding:employee_id
semantic:
  profile: dbexplain-okf-v1
  kind: term
  bindings:
    - table: /tables/prod/app/t_employee.md
      column: employee_id
```

---

## Enumeration 共享

多表共用同一套 code → `references/enums/<name>.md`，dataset field 引用。
codes 仍须来自列注释或用户确认。

---

## 问数清晰度检查表

交付前逐项核对：

| # | 检查项 | 通过标准 |
| --- | --- | --- |
| 1 | Grain | 每张 dataset `description` 说明一行代表什么 |
| 2 | 时间轴 | 时间过滤列有 `is_time` 或 description 指明列名 |
| 3 | 状态/枚举 | 过滤列有 enum 或用户确认含义 |
| 4 | 检索词 | `aliases` + 关键 field `synonyms` 覆盖用户口语 |
| 5 | Join 路径 | relationship title 可读；declared FK 已覆盖 |
| 6 | 问数样板 | top 问题有 `queries/`（若用户已给 SQL） |
| 7 | 消歧 | 易混口语有 `terms/` |
| 8 | 裁剪 | 宽表 fields 不噪音；诊断限制已注明 |
| 9 | 可检索 | `okf search "<词>"` 命中 dataset/field |
| 10 | 状态 | 未审核保持 `draft`；合法 `human:<id>` verification 后才可 `stable` |
| 11 | 通用投影 | semantic target 均有同目标 relation + Markdown link |
| 12 | Adapter 校验 | `okf dbexplain validate --bundle-root <dir>` 通过 |

---

## 不要改的文件

- `tables/`、`relationships/declared/`、`observations/`（物理/sync 层）
- overlay `index.md`（工具再生）
