# Quick Patterns — dbexplain + 生成 business

**每个模式都必须走确认循环：** R1 盘点已有 → 更新或新建 → R2 提案+例子 → **用户同意** → R3 写入 → `overlay-index`。
见 [confirmation-loop.md](confirmation-loop.md)。

---

## Pattern A — 单表问数

**用户：** 「查 Run 列表 / 按状态过滤」

```bash
dbexplain collect --label <L> --table <T> # 确认 status 列注释
okf dbexplain overlay-draft --bundle-root <dir> --tables taiyi_agent_run --dry-run
```

**写清：** `title`/`aliases`；`status` enum + synonyms；`create_time` 保留 `is_time`；
`description` 说明「一行一次 Run，可按状态和时间过滤」。

---

## Pattern B — 事实表 + 维度（declared FK）

**用户：** 「Run 要关联员工姓名」

```bash
okf dbexplain overlay-draft --bundle-root <dir> --tables taiyi_agent_run,t_employee
```

**写清：** run = 事实、employee = 维度；relationship title「运行记录归属员工」；
employee dataset 加 aliases `[员工]`。

先查 `relationships/declared/index.md`。无 FK → Pattern F。

---

## Pattern C — FK 链（同一子图）

**用户：** 「从会话追到 Run」

读 `observations/current.md` 子图，scope 路径上所有表：

```bash
okf dbexplain overlay-draft --bundle-root <dir> \
  --tables taiyi_agent_thread,taiyi_agent_thread_session,taiyi_agent_run
```

**写清：** 每张表 description 说明在链上的角色（入口 / 实例 / 事实）。

---

## Pattern D — 状态枚举（来自列注释）

1. 读 `tables/...` 中 `status` 的 `comment`
2. overlay-draft 带出 `enum`
3. 校对 zh label；注释空 → 问用户，不猜

**写清：** field `synonyms: [状态, 是否失败]`；description 说明「失败=code 3」若用户确认。

---

## Pattern E — execute 生成问数样板 SQL

**用户有问数意图、无 SQL：**

1. R1：`collect` 确认字段
2. R2：构造 SQL → `execute` 验证 → **提案给用户**（不写 queries/）
3. 用户同意后 R3：`queries/<slug>.md` + overlay-draft

---

## Pattern F — 无 declared FK 的 join

用户确认 join 后：

1. overlay-draft 两张表
2. 手写 `business/relationships/...` + `semantic.join`
3. relationship description 写清连接键与基数

**不**从 `relationships/inferred/` 复制。

---

## Pattern G — 宽表裁剪

observations 标 wide table + 用户常问列：

overlay-draft 后删 fields，保留 PK、时间、状态、外键、用户点名列；
description 注明已裁剪。

---

## Pattern H — diagnostics 写入描述

```bash
dbexplain --context ./ctx --label <L>   # diagnostics.json
```

或读 Bundle `observations/current.md` → 在 dataset `description` 写问数注意点。

---

## Pattern I — 口语术语

用户说「员工」表名却是 `t_employee` → `business/terms/employee.md` + employee dataset aliases。

---

## 首轮最小集（问数 MVP）

| 工件 | 目标 |
| --- | --- |
| Datasets | 3–6 张用户确认表，**每张 description 写清** |
| Relationships | scope 内 declared FK，**title 可读** |
| Queries | 1–3 条用户 SQL + 场景说明 |
| Terms | 仅消歧需要时 |

---

## 增量扩展

新表 → 新 Plan（仅 delta）→ `overlay-draft --tables new_a,new_b`（跳过已有文件）。
