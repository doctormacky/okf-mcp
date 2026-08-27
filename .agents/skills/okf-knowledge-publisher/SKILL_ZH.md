---
name: okf-knowledge-publisher
description: 当用户希望通过受控 workspace 流程发布或更新中心 OKF v0.2 知识库时使用此技能：下载当前快照、预览服务器端变更、要求明确确认、通过 okf knowledge CLI 提交，并通过远程 MCP 验证。不要仅为读取已发布知识或编辑本地数据库 Bundle 使用此技能。
---

# 发布 OKF 知识

严格遵循以下流程：

```text
download -> enrich -> server dry-run -> explicit confirmation -> submit -> MCP verify
```

## 边界

- 通过配置好的远程 MCP 服务器读取和查询已发布知识。
- 通过 `okf knowledge` CLI 下载、dry-run 和提交。
- 不直接调用私有 HTTP endpoint。
- 不使用 MCP 写工具执行本流程。
- 不自动安装或升级 CLI。
- 不把凭据放入本 Skill、OKF Bundle、命令参数或日志。
- 成功 dry-run 不等于获得提交批准。

## 1. 检查运行时

修改知识前运行：

```bash
command -v okf
okf --version
okf knowledge --help
```

如果找不到 `okf` 或没有 `knowledge` 命令，停止并报告需要更新 Agent runtime。不要用 `curl`、`npm install` 或直接 HTTP 请求绕过。

## 2. 确认目标

确认服务器、Bundle、本地 workspace 和知识范围。Bundle 未知时使用 MCP `list_bundles`。绝不猜 Bundle ID。

## 3. 下载当前快照

```bash
okf knowledge download \
  --url https://knowledge.internal.example \
  --out ./okf-work
```

Hosted service 中有多个可写 Bundle 时，再传入已确认的 `--bundle <id>`。

把返回的 revision 作为强制基线状态。只在下载的 workspace 内工作，不要再包一层 Bundle 目录。

## 4. 本地丰富

遵循 OKF v0.2 规则：

- 每个非保留 Markdown Concept 都有 YAML frontmatter 和非空 `type`；
- 保留未知 frontmatter 和扩展字段；
- 优先使用原生 v0.2 `generated`、`sources`、生命周期和 relation 字段；
- 使用安全的 Bundle 相对 Markdown 路径；
- 不编造事实、schema、URL、source 或标识符；
- 更新时保持 Concept 路径稳定；
- 删除文件表示有意删除，必须清楚说明。

本地验证有帮助，但不能替代服务器预览。

## 5. 运行服务器 dry-run

```bash
okf knowledge submit --workspace ./okf-work --dry-run
```

向用户展示服务器返回的路径变更、受限 `diffText`、截断元数据、validation diagnostics、提交/当前 revision、preview ID 和 candidate digest。不要用本地计算的 diff 代替服务器结果。

## 6. 要求明确确认

等待明确的确认，例如 `确认提交`。原始更新请求、成功验证或“继续检查”都不授权提交。

确认只对已经展示的 preview 有效。如果 preview 后 workspace 文件发生变化，重新 dry-run 并再次请求确认。

## 7. 提交

确认后提交完全相同的 preview workspace：

```bash
okf knowledge submit \
  --workspace ./okf-work \
  --preview-id <preview-id> \
  --message "<concise change description>"
```

服务器必须重新检查基线 revision、candidate digest、OKF validation 和完整的 future index 后才发布。

## 8. 处理冲突

遇到 `409 Conflict`：

1. 停止；绝不 force 或覆盖；
2. 将最新快照下载到全新的 workspace；
3. 在新基线上重新应用用户意图；
4. 再次运行服务器 dry-run；
5. 展示新的 diff 并再次获取确认；
6. 使用新的 preview 提交。

遇到 validation error，展示文件级 diagnostics，修复 workspace，并从 dry-run 重新开始。遇到认证或授权错误，停止并报告，不尝试绕过。

## 9. 通过 MCP 验证

提交后不要检查服务器文件系统，而要通过远程 MCP 验证：

1. 对主要变更 Concept 调用 `get_concept`；
2. 调用 `search_concepts` 确认新知识可搜索；
3. 关系变更时调用 `get_neighbors` 或 `get_graph`；
4. 确认返回的 revision 与已发布 revision 一致。

只有验证成功后才报告完成。如果发布成功但 MCP 暂时不可用，报告已发布 revision 和验证失败；不要重新提交。

## 面向用户的总结

报告：

- 已发布 revision；
- 新增、修改和删除的 Concept 数量；
- 通过 MCP 验证的 Concept；
- 仍存在的 warning；
- 未完成的验证。
