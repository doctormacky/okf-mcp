# Business Overlay Workflow

反复调用：**盘点已有 → 更新或新建 → 用户确认 → 写入 → overlay-index。**
详见 [confirmation-loop.md](confirmation-loop.md)。

## 命令

### 盘点（R1）

| 步骤 | 命令 |
| --- | --- |
| 校验 | `okf --root <dir> --strict-links validate` |
| 检索已有语义 | `okf --root <dir> search "<term>"` |
| 浏览目录 | 读 `business/datasets/index.md`、`queries/index.md` |

### dbexplain（可选探查 / 验证例子）

| 步骤 | 命令 |
| --- | --- |
| 连通 | `dbexplain check --label <L>` |
| 紧凑表清单 | `dbexplain collect --label <L> --tables` |
| 单表字段 + 注释 | `dbexplain collect --label <L> --table <T>`（Bundle 不足时） |
| 验证 SQL | `dbexplain execute --label <L> '<SELECT>' --human` |

### 写入（R3，仅同意后）

| 步骤 | 命令 |
| --- | --- |
| 新建缺失 dataset | `okf dbexplain overlay-draft --bundle-root <dir> --tables a,b` |
| **重生 overlay 索引** | `okf dbexplain overlay-index --bundle-root <dir>` |
| **领域 + OKF 校验** | `okf dbexplain validate --bundle-root <dir>` |

`overlay-draft` **不覆盖**已有 Concept，但会刷新当时磁盘上的 index。
之后若又写了 `queries/` 或改了 title，**必须再跑 overlay-index**。
不要手改 `index.md`。第一次 `$okf-dbexplain` sync 已创建空索引页。

---

## 阶段清单

- [ ] R1 读现有 datasets/queries，判定更新 vs 新建
- [ ] R2 提案含对照表 + SQL 例子，用户同意
- [ ] R3 更新已有文件，或 overlay-draft 补缺，或新建 query
- [ ] R3 末尾 `overlay-index`
- [ ] R4 `okf dbexplain validate` + `okf search`

---

## Coverage Report

```markdown
## Business Coverage Report

**动作：** 更新 N 个 / 新建 M 个
**overlay-index：** 已运行

### 更新
- …

### 新建
- …

### 索引
- `business/datasets/index.md`、`queries/index.md` 已重生
```
