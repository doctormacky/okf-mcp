# 多轮确认循环（核心协议）

语义层建设**一定是多轮的**。反复调用本技能时：

**探查已有 business → 命中则更新、未命中则新建 → 逻辑提案 + 例子 → 用户同意 → 写入 → overlay-index。**

**禁止：** 不盘点已有 Concept 就再 draft 一份同样的 dataset/query。
**禁止：** 手改 `index.md`。索引由 `okf dbexplain overlay-index` 重生。
**禁止：** 对表名、join、过滤字段、聚合列、用户标识列「靠猜」。

---

## 状态机

```text
用户描述问数意图
        ↓
R1 探查 Bundle + 已有 business（search / index.md / 正文）
        ↓
    判定：更新已有 或 新建
        ↓
R2 逻辑提案 + SQL 例子     ← 用户补充/纠正则回到这里
        ↓ 明确同意
R3 写入（改文件 或 overlay-draft 补缺）
        ↓
    overlay-index（重生全部 overlay index.md）
        ↓
R4 交付
```

### 什么叫「明确同意」

算同意：`可以 / 同意 / 按这个写 / OK / 确认 / 没问题 / 例子对了，写进 bundle`

不算：沉默、只提新问题、`再看看`、`好像不对`、只答了部分澄清。

---

## R1 — 探查 + 盘点（只读）

```bash
okf --root <bundle-root> --strict-links validate
okf --root <bundle-root> search "<关键词>"
```

打开：

- `business/datasets/index.md`、`business/relationships/index.md`、`queries/index.md`
- 命中的 dataset / query 正文（看 `physical_table`、SQL、description）
- `tables/`、`observations/current.md`

连库（可选）：

```bash
dbexplain check --label <label>
dbexplain collect --label <label> --tables        # 仅紧凑表清单
dbexplain collect --label <label> --table <table> # 需要最新字段/注释时
```

判定：

| 命中 | 提案写法 |
| --- | --- |
| 同表已有 dataset | 更新该 dataset，不新建 slug |
| 同一问数已有 query | 更新该 query 的 SQL/描述 |
| 同 join 已有 relationship | 更新 title/description |
| 无命中 | 新建；`overlay-draft` 只对**还没有 dataset 的表** |

---

## R2 — 逻辑提案（必经，含例子）

```markdown
## Business 逻辑提案（待你确认 — 确认前不会写入 Bundle）

**你的问数意图：** 统计 XXXX 用户在 2026年5月的 token 消耗总量

**Bundle：** /path/to/test-bundle

### 已有 business 盘点
| 已有文件 | 判定 |
|----------|------|
| business/datasets/taiyi-agent-model-usage.md | 同表 → **本轮更新** |
| queries/token-usage-by-user-month.md | 无（本轮新建） |

### 1. 业务逻辑
- 事实表 / 维度 / 过滤列 / 时间列 / 指标（每条写依据：列注释或你的说明）

### 2. 示例 SQL
\`\`\`sql
SELECT SUM(u.total_tokens) AS token_total
FROM taiyi_agent_model_usage u
JOIN t_employee e ON u.employee_id = e.employee_id
WHERE e.login_name = 'XXXX'
  AND u.usage_time >= '2026-05-01'
  AND u.usage_time < '2026-06-01';
\`\`\`

### 3. dbexplain 验证（若已执行）
- 结果摘要写在对话里；**不要**把样例行写入 Bundle。

### 4. 将写入的工件
| 动作 | 路径 |
|------|------|
| 更新 | business/datasets/… |
| 新建 | queries/… |

**请回复：是否同意按此逻辑写入？** 不同意请指出哪里不对。
```

---

## R3 — 写入（仅用户同意后）

更新：改已有 Markdown。
新建 dataset：`okf dbexplain overlay-draft --bundle-root <dir> --tables <缺的表>`（已有文件跳过）。
新建 query：新文件，不要覆盖无关 query。

然后**必须**：

```bash
okf dbexplain overlay-index --bundle-root <bundle-root>
okf dbexplain validate --bundle-root <bundle-root>
```

第一次 sync 已经有空的 index.md；`overlay-index` 按当前 Concept 重生目录，包含新 title。
`overlay-draft` 也会刷新索引，但若之后才写 `queries/` 或改了 title，必须再跑 `overlay-index`。

不要手改 index；不要用 `sync apply` 收尾。

---

## R4 — 交付

Coverage Report：更新了哪些、新建了哪些、`overlay-index` 已跑。

---

## 用户纠正

纠正后**只改提案、再确认**，不在同一轮写入。

## 反模式

- ❌ 已有同表 dataset 再 overlay-draft 指望覆盖（不会覆盖，只会跳过）
- ❌ 同一问数复制第二个 query 文件
- ❌ 手写 index.md
- ❌ 提案没有 SQL 例子
- ❌ execute 结果写入 Bundle
