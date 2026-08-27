# 内置 Agent Skills

[English](SKILLS.md) · [简体中文](SKILLS_ZH.md)

okf-mcp 在 `.agents/skills/` 下提供五个相互独立的 Skill。可以单独安装，也可以任意
组合；任何 Skill 都不假设其他 Skill 已安装，也不存在运行时自动转交。

## 能力清单

| Skill | 独立职责 | 典型请求 |
| --- | --- | --- |
| [okf-dbexplain](../.agents/skills/okf-dbexplain/) | 从数据库生成或刷新物理事实 Bundle | “预览并同步 prod-main 的表、字段和外键” |
| [okf-bundle-business](../.agents/skills/okf-bundle-business/) | 增补或纠正已有 query-ready Bundle 的 Business 知识 | “给客户数据集增加 buyer 别名并补订单状态枚举” |
| [okf-nl2sql](../.agents/skills/okf-nl2sql/) | 把业务问题转换为单数据源只读 SQL 并返回真实结果 | “上个月各门店退款后的实际销售额是多少” |
| [okf-knowledge-publisher](../.agents/skills/okf-knowledge-publisher/) | 预览、确认并发布中心 OKF 知识快照 | “把 workspace dry-run 后等我确认再发布” |
| [okf-v02-migration](../.agents/skills/okf-v02-migration/) | 检查并迁移旧版 OKF v0.1 内容 | “预览这个目录的 v0.2 迁移” |

这些能力可以组成工作流，但组合由用户或 Agent Host 决定，不是 Skill 的安装依赖。
缺少某项能力时，当前 Skill 应报告具体缺口，而不是假设另一个 Skill 可用。

## `okf-dbexplain`

适用于首次生成或刷新物理事实层：Table SQL binding、字段 comments、声明外键、推断关系
候选和 observations。它不编辑 Business，也不执行业务问数。

```text
$okf-dbexplain
请检查 prod-main，并预览同步到 /data/okf/my-database
```

核心约束：

- dbexplain v0.1.11 或更高版本在 `PATH` 中；
- 不读取数据库配置，不使用 sample rows；
- `sync --dry-run` 后等待批准，再带同一 plan digest apply；
- 保留已有 Business overlay 内容；
- 完成后运行 `okf dbexplain validate` 并报告物理事实和缺口。

## `okf-bundle-business`

仅在用户明确要求修改知识工件时使用。支持 Dataset、字段 aliases/synonyms、Term、Enum、
Relationship、Metric、Policy 和 Saved Query。普通“统计多少、趋势、排行、查明细”不属于
这个 Skill，因为它们要求数据结果而不是知识变更。

```text
$okf-bundle-business
请盘点 /data/okf/my-database 中已有 Business，给客户数据集增加 buyer 别名，
并把订单 state 字段注释中的显式状态码投影为可检索枚举。先提案，批准后再写。
```

核心流程：盘点已有 → 更新/新建提案 → 明确批准 → 写入 → `overlay-index` → validate。

核心约束：

- 同一物理 binding 或同一业务定义更新原 Concept，不复制；
- 表 comment 和字段 comment 是主要物理证据，但模糊业务含义仍需用户确认；
- aliases、description、term、显式 enum 不强制 SQL 示例；
- Saved Query 或 SQL-backed Metric 才需要执行完全相同的 SQL 进行机器验证；
- 不手改 overlay `index.md`，不把结果行写入 Bundle。

## `okf-nl2sql`

面向不知道表结构的业务用户。它先通过 OKF MCP 检索 Business 和 comments；知识不足时
使用 dbexplain 做无 sample 的受限实时探测，然后执行单 label 的只读 SQL。

```text
$okf-nl2sql
上个月各门店退款后的实际销售额是多少？按金额从高到低排列。
```

核心约束：

- 搜索使用 1–2 个原子业务词，因为 OKF lexical search 是全词 AND；
- 表 comment 用于识别主题，字段 comment 用于指标、维度、时间和显式枚举召回；
- `process:dbexplain` 证明 SQL 执行过，不证明业务口径已经人工审核；
- 查询前固定基础 grain，防止反向一对多和多事实表重复计数；
- 所有表属于同一 label，只执行单条 `SELECT` / `WITH ... SELECT`；
- 只返回经过验证的业务结果及必要限制；SQL、物理字段、证据和执行元数据仅供内部使用；
- 结果使用 Markdown 渲染，多行结果使用 Markdown 表格。

## 独立安装

将需要的 Skill 目录单独复制或链接到 Agent Host 的 Skills 路径。例如：

```bash
ln -sfn "$PWD/.agents/skills/okf-nl2sql" "$AGENT_SKILL_ROOT/okf-nl2sql"
```

安装多个 Skill 时分别建立链接。`agents/openai.yaml` 是可选宿主元数据，不是通用 Skill
运行依赖。

## 评测资产

三个数据库 Skill 都包含：

- `evals/trigger-queries.json`：可定制的调用问题。`okf-nl2sql` 只提供一条通用模板，
  用户可替换为自己的业务问题；知识编写类 Skill 仍保留正反触发用例；
- `evals/output-scenarios.json`：comments、信任等级、fanout、inferred 和更新原 Concept
  等与自身职责对应的可观察行为场景。`okf-dbexplain` 重点覆盖事实精确性、plan drift、
  incomplete collection、unsupported kind 和 overlay preservation。

先按目标业务定制通用模板，再在实际 Agent Client 中将每条 trigger query 至少运行三次，
记录 Skill 是否被加载。评测运行方式由宿主决定，不在 Skill 中绑定特定模型或 CLI。
