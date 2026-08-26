# Scoping — 用 dbexplain 定 business 范围

范围来自**用户问数意图**，经 **R1 探查** 收敛，在 **R2 逻辑提案** 里写清并等用户确认。
见 [confirmation-loop.md](confirmation-loop.md)。

## 首轮可合并的问题

若用户已在自然语言里说清意图，只补问：

```text
1. Bundle 绝对路径？（若只说 test-bundle）
2. dbexplain label？
3. 用户标识/业务词若有歧义（如 XXXX 是工号还是登录名）？
```

**不要**在 scoping 阶段写 business 文件。

## 帮选表 — dbexplain + Bundle

### Step 1：`dbexplain --context`

```bash
dbexplain check --label <label>
dbexplain --context ./ctx --label <label>
```

| 文件 | scoping 用途 |
| --- | --- |
| `topology.json` subgraphs | 同一模块一次建议多张关联表 |
| `topology.json` refs | 哪些表有 declared 连接 |
| `diagnostics.json` | Plan 里写问数约束 |
| `summary.json` | 实例/表规模概览 |

### Step 2：紧凑表清单 + Bundle 对齐

```bash
dbexplain collect --label <label> --tables
okf --root <bundle-root> search "<关键词>"
```

`--tables` 只返回紧凑表清单，不返回完整字段与列注释。优先读取 Bundle 的
Table Concept；确需确认最新字段时运行：

```bash
dbexplain collect --label <label> --table <table>
```

对比完整单表 collect 与 Bundle `tables/`：不一致 → 先 re-sync。

### Step 3：编号建议（待用户确认）

```text
根据 dbexplain 拓扑「agent」子图和你的问数目标，建议：

1. taiyi_agent_run   — 事实表（collect：status 注释含 [1:…,3:失败]）
2. t_employee        — 维度（topology refs 有 FK）
3. taiyi_agent_thread — 会话入口（子图上游）

请确认或调整。确认前不 overlay-draft。
```

**不用** core_tables 自动写 business；inferred 仅作「待确认」提示。

## 表 → Bundle 路径

```bash
okf --root <bundle-root> search "taiyi_agent_run"
```

## 物理层缺口

collect 有表/注释、Bundle 没有 → `$okf-dbexplain` sync → 再 `overlay-draft`。
