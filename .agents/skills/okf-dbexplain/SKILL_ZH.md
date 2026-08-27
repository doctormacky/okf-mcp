---
name: okf-dbexplain
description: 当用户希望检查 SQL 数据库，或使用 dbexplain 生成、刷新 OKF v0.2 数据库 Bundle 的 facts-only 物理层时使用此技能，包括表、字段、SQL binding、关系、observations 和 overlay 索引。也用于连接检查和经过审核的同步预览。不要用于 Business 编写、实时问数、SQL 执行或数据库写入。
---

# 同步 OKF 数据库事实

将 dbexplain 元数据转换为 facts-only OKF Bundle：表、声明和推断关系、observations 以及保留的 overlay 索引。okf-mcp 可以立即索引该 Bundle 以检索 schema。

人工维护的 Business 语义（`business/`、`metrics/`、`queries/`、`policies/`）不属于本 Skill。本 Skill 不运行 `overlay-draft`，也不编辑 overlay Concept。

## 标准流程

读取 [references/sync.md](references/sync.md)。

### 阶段 0：前置条件

- 确认 `dbexplain` 和 `okf` 在 PATH 中；要求 dbexplain `v0.1.11` 或更高版本。
- 解析 `--bundle-root`（绝对路径）；只有存在歧义时才询问。
- 保留用户指定的 source selector；绝不打开数据库配置文件。

### 阶段 1：检查与连通性

```bash
okf dbexplain inspect --include <label>
okf dbexplain check --include <label>
```

### 阶段 2：同步（需要审核）

```bash
okf dbexplain sync \
  --include <label> \
  --bundle-root <absolute-bundle-dir> \
  --generated-at <UTC-with-seconds> \
  --dry-run
```

报告 counts、validation、changes 和 `planDigest`。**等待批准**后再运行：

```bash
okf dbexplain sync \
  --include <label> \
  --bundle-root <absolute-bundle-dir> \
  --generated-at <same-UTC> \
  --expect-plan <sha256:digest>
```

### 阶段 3：验证物理层

```bash
okf dbexplain validate --bundle-root <absolute-bundle-dir>
```

交付 Facts Report：

- instance、表、声明/推断关系数量；
- `observations/current.md` 的重点（核心表、clusters、diagnostics）；
- 嵌套物理目录索引，以及删除的未触碰旧 scaffold；
- 提醒同步后重启 okf-mcp 以重新索引；
- 报告 Business overlay 索引为空、已保留或已有内容。

## 硬边界

- 不读取或修改数据库配置。
- 不安装或升级 dbexplain。
- 不使用 `--sample` 采集；Bundle 中不放凭据或样例行。
- **不运行 `overlay-draft`，不创建人工维护的 Business Concept。**
- 不编造 SQL、JOIN 或枚举含义。
- 同步会保留已有 overlay 字节；只重新生成 overlay 索引。
- 新版 dbexplain 只要仍满足所需 CLI/JSON 合同即可接受；否则在指定 GitHub Issues 地址报告 `unsupported_dbexplain_contract`。

## 必须输出

- 应用同步后表带有 `sql_binding.version: 2`；
- 声明关系带有 `join_binding`；
- validate 返回 `validForProject: true`；
- Facts Report，明确物理层缺口和保留的 overlay 数量。

## 参考

- [references/semantic-overlay.md](references/semantic-overlay.md) —— 合同（仅供阅读）；
- [references/overlay-authoring.md](references/overlay-authoring.md) —— 物理层与 overlay 所有权边界。
