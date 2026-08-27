---
name: okf-v02-migration
description: 当用户明确希望检查、预览或分阶段处理已有 Open Knowledge Format v0.1 或混合目录迁移到 OKF v0.2 时使用此技能。分析迁移就绪状态并创建可审核提案，不直接重写文件或自动接受提案。不要用于普通验证、Business 丰富或物理数据库同步。
---

# OKF v0.2 迁移

使用软件包提供的确定性迁移检查器和提案工具。绝不直接重写目录文件、编造 provenance 或 verification、自动接受提案，或修改远程 Bundle。

## 工作流

1. 在创建提案前确认 repository worktree 状态。保留无关变更；如果迁移目标与未审核编辑重叠则停止。
2. 运行 `okf --root <catalog> migrate check`。可选的多 root project 中运行 `okf --project <config> migrate check <bundle>`。记录 classification、blocker、identity collision、generated-file skip、referenced assets 和 migration readiness。
3. 提案前解决 blocker：
   - 为每个 legacy `timestamp` 向目录所有者确认真实的 `generated.by` actor；必须取得明确映射；
   - 将生成文件交回其 generator，不直接提案修改；
   - 不猜测地解决 malformed citation、conformance error、不安全路径及 ID/alias collision；
   - 映射格式为 `{"<concept-uri-or-path>":{"by":"<actor>","confirmed":true}}`；只有所有者确认一个 actor 对所有 timestamp 都真实适用时，才可使用 `$default`；
   - 使用 `human:<id>`、`process:<id>` 或 `<provider>/<model>` actor 格式。检查器会拒绝缺失 actor 或非布尔 confirmation。
4. 运行 `okf --root <catalog> migrate preview '<actor-mappings-json>'`；多 root project 模式提供 Bundle ID。根据 [field-mapping.md](references/field-mapping.md) 审查每个文件变更。
5. 展示 preview，并等待明确批准后再调用 `okf_propose_v02_migration`。该 MCP 工具要求可写本地 root 和 `--authoring`；没有创建 proposal 的 CLI 命令。
6. 提案工具可能创建 migration manifest 和逐文件 child proposal。除非用户明确批准对应 proposal，否则不要接受任何 child。
7. 只有所有 Stage-A Concept proposal 都接受且整个 Bundle 通过验证后，才接受保留的 `index.md` 版本 proposal。
8. 再次运行 project validation，报告本地证据、保留的 legacy 字段、剩余 generator 工作，以及任何未通过 owner mapping 或外部 repository 验证的内容。

## 安全边界

- 原生 `generated` 和 `sources` 始终优先于 legacy fallback。
- 迁移增加原生 v0.2 字段，同时保留 `timestamp` 和 `# Citations` 以兼容。
- 除非有独立授权和证据，不添加 `verified`、credibility signal、生命周期字段或 freshness 声明。
- 迁移过程中绝不执行 computation、executor 或 attester。
- 远程 Bundle 只能报告；必须在拥有独立权限的源 repository 中创建提案。
- checker 结果是分析，不是批准。创建 proposal 是一次写入；接受 proposal 是另一次明确写入。

## 完成标准

报告 checker classification、拟议 child 文件、manifest ID、验证结果、保留的兼容字段，以及任何因 owner mapping 或外部 repository 而阻塞的内容。只要版本声明 proposal 或验证仍未完成，就不要称迁移完成。
