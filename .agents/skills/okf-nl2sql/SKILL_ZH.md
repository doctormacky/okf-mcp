---
name: okf-nl2sql
description: 当用户希望用业务语言获得 SQL 数据库的实际答案时使用此技能，包括总量、趋势、排行、比较或受限明细，即使用户不知道 schema、方言或数据源 label。通过 MCP 检索相关 OKF 知识，组装单数据源只读 SQL，交给 dbexplain 执行，并返回经过验证的结果，不暴露 SQL。不要用于写入、schema 同步、知识编写、NoSQL 或不需要实时数据的问题。
---

# 用 SQL 回答业务问题

先使用 OKF 知识；只有知识不足时才进行受限数据库探查。用户提供业务意图，而不是物理 schema 名称。

## 要求

- 发现 MCP 中提供 `list_bundles`、`search_concepts` 和 `get_concept` 的工具；使用当前 host 提供的完整工具名，不假设 MCP server namespace。
- 第一次 CLI 调用前运行 `command -v dbexplain` 和 `dbexplain --version`；要求 v0.1.11 或更高版本。缺少能力时报告，不安装软件。
- 不读取或编辑数据库配置，不索要凭据，不构造命令行 DSN，不使用 `--sample`，不写数据库或 Bundle。
- SQL、query plan、物理标识符、命令和执行 receipt 只留在内部，最终回答中不得暴露。

## 工作流

进度：

- [ ] 明确业务意图
- [ ] 检索并 grounding 所需的每个 Concept
- [ ] 创建并验证 query plan
- [ ] 执行一条只读 SQL
- [ ] 验证并报告结果

### 1. 明确意图

识别 measure、entity、dimensions、时间范围、过滤条件和输出粒度。只询问会改变答案的业务歧义。不要让用户选择表、字段、JOIN、方言或 label。

### 2. 检索证据

如果第一批知识命中不能唯一覆盖全部 intent slot，读取 [retrieval-and-grounding.md](references/retrieval-and-grounding.md)。使用 binding 前读取完整 Concept；compact search summary 只是发现结果，不是 SQL 证据。

当 Saved Query 与业务意图匹配时，使用它的完整 Concept 作为成熟 SQL 证据来组装当前查询。它不能绕过 Metric、Policy、粒度检查、参数澄清或最终执行。

如果需要，读取 [live-database-discovery.md](references/live-database-discovery.md) 处理缺失或过期的物理事实；没有可执行或语义关系且需要推断候选 JOIN 时，读取 [inferred-join-validation.md](references/inferred-join-validation.md)。

### 3. 规划并验证

创建内部 query plan：

```text
business meaning | source Concept/comment | base grain | measure | dimensions
time/filter semantics | physical tables/columns | joins | policies | label
```

执行前确认：

- 所有物理标识符来自当前 binding 或实时元数据；
- 每张表使用同一个 `instance_label` 和方言；
- 基础事实粒度明确，JOIN 不会放大它；
- 反向一对多输入及多个事实表在目标粒度 JOIN 前分别预聚合；
- 已检查适用的 Policy Concept；
- SQL 是单条 `SELECT` 或 `WITH ... SELECT`，字段明确且明细有界，不包含 `SELECT *`、写操作或 `EXPLAIN ANALYZE`。

### 4. 执行并验证

使用 grounding 后的 label 执行 JSON 输出：

```bash
dbexplain execute --label <label> --limit <bounded-result-limit> --timeout 30 '<sql>'
```

所有定量结论使用 SQL aggregate。检查 `columns`、`rows`、`row_count`、`truncated`、`execution_time` 和 `stripped_columns`。

遇到 binding/schema error，刷新受影响证据并最多做一次等价修复。不要用猜测修复业务歧义，不绕过 `ACCESS_DENIED`，不自动放宽空结果或增加 timeout。

### 5. 返回答案

只返回使用用户语言撰写的、经过验证的 GitHub Flavored Markdown 业务结果，不要再套外层 code fence。

- 先用简短句子给出直接业务答案；
- 单值用正文表达，不做一格表格；
- 多行或多维结果用 Markdown 表格，只有天然适合短列表时才用列表；
- 只在结果后放影响解读的 coverage 限制，用 Markdown blockquote；没有限制就省略；
- 不返回 raw JSON、CSV、ASCII 表格或 HTML。

不要包含 SQL 语句或片段、SQL code fence、dbexplain 命令、内部 query plan、物理标识符、Concept URI、instance label 或执行元数据。如果没有得到验证结果，简洁说明 blocker，不展示尝试过的 SQL，也不猜答案。

## 易错点

- OKF lexical search 要求所有查询词都匹配；使用一到两个原子业务词，不要把完整自然语言问题作为搜索词。
- 表注释会进入表 description；字段注释会进入表正文和 SQL binding。注释是强检索证据，但不是模糊业务定义或 JOIN 的自动证明。
- `process:dbexplain` 证明确切 SQL 执行过，不证明业务含义已人工审核。
- Saved Query 的参数样例只说明表示方式，不是默认值。缺少当前值时必须用业务语言询问。
- `join_binding.executable: true` 表示同 label、目标键唯一的声明外键；不表示已人工审核。
- 明细结果被截断时，不能据此声称覆盖全部行、唯一性或完整排行。
