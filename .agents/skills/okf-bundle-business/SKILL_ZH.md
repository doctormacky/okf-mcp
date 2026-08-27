---
name: okf-bundle-business
description: 当用户希望在已有的、可查询的 OKF 数据库 Bundle 中增加或修正 Business 知识时使用此技能，包括数据集、术语、枚举、关系、指标、策略，或将业务维护的可执行 SQL 保存为供后续 NL2SQL grounding 使用的 Saved Query。先盘点现有 Concept，提出经过审核的变更，并原地更新匹配的知识。不要用于实时数据库问数、物理 schema 同步或知识发布。
---

# 丰富 OKF Business 知识

为已有的 query-ready 数据库 Bundle 增加人工维护的 Business 语义。本 Skill 修改知识工件，不回答实时数据问题。

## 要求

- Bundle 中相关物理 Table Concept 必须带 SQL binding v2。缺少物理事实时，报告准确缺失的表、字段或关系；不要编造，也不要假设安装了其它 Skill。
- 使用 `okf`；只有需要验证 SQL 时才使用 `dbexplain`。首次使用前检查命令，不读取数据库配置。
- 不猜测业务定义、枚举含义、指标表达式、JOIN、行过滤、用户身份或生命周期状态。

## 按需读取的参考

- 读取 [discovery.md](references/discovery.md)，盘点已有 Business 并将请求映射到注释和物理 binding。
- 只读取获批工件类型对应的 [authoring.md](references/authoring.md) 部分。
- 用户提供已沉淀 SQL、需要保存为可复用 NL2SQL 证据时，读取 [saved-query-evidence.md](references/saved-query-evidence.md)。
- 需要具体 Concept 形状或提案示例时，读取 [examples.md](references/examples.md)。

## 工作流

进度：

- [ ] 盘点当前 Bundle 和匹配的 Business
- [ ] 将每项变更分类为更新或新建
- [ ] 提出可审核的提案
- [ ] 等待明确批准
- [ ] 应用变更、重建索引并验证

### 1. 盘点

验证 Bundle，读取相关 overlay 索引和完整匹配 Concept，并跟随物理关系。根据含义和 binding 识别现有 Concept，不要只根据文件名判断。

### 2. 提案

向用户展示：

```markdown
Business proposal

| Action | Artifact | Existing target or new path | Evidence |
| --- | --- | --- | --- |

Business definitions requiring confirmation: <only unresolved decisions>
SQL example and verification: <only for a Saved Query or SQL-backed Metric>
```

匹配到相同含义时更新原 Concept，只为缺失的含义创建新 Concept。验证成功或 SQL 执行成功不等于用户批准写入。

### 3. 获批后应用

- 直接编辑已有的人工维护 overlay Markdown。
- 仅使用 `okf dbexplain overlay-draft --bundle-root <dir> --tables <scope>` 创建缺失的机械派生 Dataset/Relationship draft；它不会更新已有文件。
- 对 Saved Query，先通过 dbexplain 成功执行完全相同的单数据源只读 SQL，再记录 `process:dbexplain` verification。执行只证明 SQL 跑通，不证明业务定义已人工审核。
- 新增或未审核的声明保持 `draft`；不要编造人工 verification。
- Bundle 中绝不保存凭据、主机信息或结果行。

### 4. 验证

每次应用变更后运行：

```bash
okf dbexplain overlay-index --bundle-root <dir>
okf dbexplain validate --bundle-root <dir>
okf --root <dir> --strict-links validate
```

如果验证失败，修正提案工件并重复验证。最后搜索代表性业务词，并报告更新或创建的路径。

## 易错点

- `overlay-draft` 会跳过已有工件，不是更新机制。
- 不要手工编辑 overlay `index.md`；由 `overlay-index` 重建。
- 通用 OKF search 不索引任意嵌套的 `semantic.*`；把字段名、同义词、枚举标签和指标含义放入 title、description 或正文。
- 表注释和字段注释是起草描述和字段的主要物理证据，但含义模糊的业务声明仍需用户确认。
- 推断出的物理关系是候选，不是已批准的 Business JOIN。
- 业务维护的 SQL 是权威查询证据。保留其 JOIN、过滤、聚合和粒度；除非用户明确要求，不要重设计它或从中派生其它 Business Concept。
- 参数化 Saved Query 保存的是可执行的样例语句，而不是不可执行的占位符模板。文档中的样例值绝不是后续 NL2SQL 问题的默认值。
- 对 aliases、description、term 和明确的 enum 丰富，不需要 SQL 示例；除非这些变更同时创建 Saved Query 或 SQL expression。
