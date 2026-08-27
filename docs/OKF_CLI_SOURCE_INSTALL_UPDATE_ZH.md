# okf CLI 源码安装、命令注册与更新手册

本文说明如何从源码安装本项目、把 `okf` 注册为系统命令，以及后续如何安全更新和回滚。
本文同时说明 `okf` CLI 与 `okf-dbexplain`、`okf-bundle-business`、`okf-nl2sql`
Skill 的区别。

## 1. 需要区分的独立能力

### 1.1 `okf` CLI

`okf` 是 `package.json` 声明的可执行命令：

```json
{
  "bin": {
    "okf": "bin/okf-mcp.js",
    "okf-mcp": "bin/okf-mcp.js"
  }
}
```

执行 `npm link` 后，npm 会把 `okf` 和 `okf-mcp` 注册到全局 npm 可执行目录。

### 1.2 `okf-dbexplain` Skill（物理事实层）

Skill 位于：

```text
.agents/skills/okf-dbexplain/
```

负责 inspect、连接检查、dry-run、人工确认和 apply，生成**物理事实层** Bundle。
不要让模型手写 Schema Markdown。

```text
$okf-dbexplain 请检查 prod-main 数据库，并预览同步到 /data/okf/prod-database
```

### 1.3 `okf-bundle-business` Skill（业务覆盖层）

```text
.agents/skills/okf-bundle-business/
```

在已有 query-ready Bundle 上增补或纠正 Business 知识。它只要求所需物理事实已经存在，
不要求安装任何其它 Skill。

```text
$okf-bundle-business 给 /data/okf/prod-database 的客户数据集增加 buyer 别名，并补充订单状态枚举
```

### 1.4 `okf-nl2sql` Skill（问数执行）

```text
.agents/skills/okf-nl2sql/
```

从 OKF MCP 检索业务与物理 binding，组装并通过 dbexplain 执行只读 SQL。Bundle 信息
不足时会做受限的实时 schema/聚合探测；用户不需要提供表名或字段名。

```text
$okf-nl2sql 查询上个月各门店退款后的实际销售额
```

只注册 `okf` CLI 不等于安装任何 Skill；只加载 Skill 也不能替代它声明需要的 CLI/MCP
能力。每个 Skill 可以单独安装，不构成相互依赖。

## 2. 环境要求

- Git
- Node.js 22 或更高版本
- npm
- 使用数据库 Bundle 功能时，`dbexplain` 必须已安装到 `PATH`
- dbexplain 配置中的 SQL DSN 必须具有唯一、稳定的 `?label=`

检查环境：

```bash
git --version
node --version
npm --version
command -v dbexplain
dbexplain --version
```

## 3. 第一次从源码安装

从远端仓库获取源码：

```bash
git clone https://github.com/doctormacky/okf-mcp.git
cd okf-mcp
```

`git clone` 只能获取已经提交并推送到远端的代码。本地未提交或未推送的功能不会出现在新 clone 中。

安装锁文件声明的精确依赖：

```bash
npm ci
```

完成验证：

```bash
npm test
npm run self:validate
npm run package:smoke
npm run pack:check
```

直接通过源码入口检查版本：

```bash
node bin/okf-mcp.js --version
node bin/okf-mcp.js dbexplain --help
```

以上步骤证明源码可以运行，但此时不一定已经把 `okf` 注册到系统 `PATH`。

## 4. 使用 `npm link` 注册系统命令

在仓库根目录执行：

```bash
npm link
```

验证 npm 注册结果：

```bash
command -v okf
command -v okf-mcp
okf --version
okf dbexplain --help
```

查看 npm 全局前缀：

```bash
npm prefix -g
```

全局命令通常位于：

```text
<npm-global-prefix>/bin/okf
```

例如 Homebrew Node.js 常见路径是 `/opt/homebrew/bin/okf`。

### 4.1 `command -v okf` 没有输出

先检查全局可执行目录：

```bash
NPM_GLOBAL_BIN="$(npm prefix -g)/bin"
ls -l "$NPM_GLOBAL_BIN/okf"
```

如果文件存在但 shell 找不到，需把该目录加入 `PATH`：

```bash
export PATH="$NPM_GLOBAL_BIN:$PATH"
```

然后把相同配置写入所用 shell 的启动文件，例如 `~/.zshrc` 或 `~/.bashrc`。

### 4.2 不希望使用 npm 全局目录

可以为当前用户建立软链接：

```bash
mkdir -p "$HOME/.local/bin"
chmod +x bin/okf-mcp.js
ln -sfn "$PWD/bin/okf-mcp.js" "$HOME/.local/bin/okf"
export PATH="$HOME/.local/bin:$PATH"
```

该方式同样指向当前源码目录。仓库移动或重新 clone 后，需要重新建立软链接。

## 5. 同一源码目录的日常更新

`npm link` 创建的是指向当前源码目录的链接。因此在同一个 checkout 中更新源码后，通常不需要再次执行 `npm link`。

先确认工作树状态：

```bash
cd /path/to/okf-mcp
git status --short
```

如果存在本地修改，应先检查并明确选择提交或暂存；不要用 `git reset --hard` 丢弃不确定的修改。

在工作树允许更新后执行：

```bash
git pull --ff-only
npm ci
npm test
npm run self:validate
npm run package:smoke
```

验证当前源码和命令：

```bash
git rev-parse HEAD
node -p "require('./package.json').version"
command -v okf
okf --version
okf dbexplain --help
```

`npm ci` 会根据新的 `package-lock.json` 重建 `node_modules`，但不会主动删除指向当前仓库的全局 `npm link`。

注意：项目版本号可能没有在每个 Commit 中递增，所以仅检查 `okf --version` 不足以证明使用的是哪个源码版本。生产记录应同时保存完整 Commit SHA。

## 6. 什么时候需要重新执行 `npm link`

以下情况需要重新执行：

- 仓库移动到了新目录
- 删除旧目录后重新 clone
- 切换到另一个独立 checkout 或 Git worktree
- `package.json` 中的 `bin` 映射发生变化
- `command -v okf` 仍然指向旧目录
- 全局 npm prefix 发生变化，例如切换了 Node.js 安装方式

处理方式：

```bash
cd /new/path/to/okf-mcp
npm ci
npm link

command -v okf
okf --version
```

检查实际链接目标：

```bash
ls -l "$(command -v okf)"
```

## 7. Codex 如何发现更新后的 Skill

当 Codex 的工作目录位于本仓库时，可以发现：

```text
.agents/skills/okf-dbexplain/SKILL.md
.agents/skills/okf-bundle-business/SKILL.md
.agents/skills/okf-nl2sql/SKILL.md
```

源码更新后，建议重新打开项目或创建新会话，再显式调用：

```text
$okf-dbexplain 检查数据库配置，并预览更新数据库 Bundle
```

如果希望从其他项目目录也能使用某个 Skill，可以只为所需能力建立用户级软链接：

```bash
CODEX_SKILL_ROOT="${CODEX_HOME:-$HOME/.codex}/skills"
mkdir -p "$CODEX_SKILL_ROOT"
ln -sfn "$PWD/.agents/skills/okf-dbexplain" "$CODEX_SKILL_ROOT/okf-dbexplain"
ln -sfn "$PWD/.agents/skills/okf-bundle-business" "$CODEX_SKILL_ROOT/okf-bundle-business"
ln -sfn "$PWD/.agents/skills/okf-nl2sql" "$CODEX_SKILL_ROOT/okf-nl2sql"
```

上面三条命令彼此独立；不需要的 Skill 可以不链接。其它 Agent Host 使用其自身的 Skills
目录和注册方式。

仓库移动后需要重建该链接。若 Codex 尚未显示新 Skill，重新打开项目或新建会话，让 Skill 列表从磁盘刷新。

## 8. 更新后第一次同步数据库 Bundle

更新转换器后，不要直接覆盖现有 Bundle。先检查运行时和配置：

```bash
okf dbexplain inspect --include prod-main
okf dbexplain check --include prod-main
```

为本轮同步固定一个 UTC 时间，并进行 dry-run：

```bash
GENERATED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

okf dbexplain sync \
  --include prod-main \
  --bundle-root /data/okf/prod-database \
  --generated-at "$GENERATED_AT" \
  --dry-run
```

检查输出中的：

- `selectedSources`
- `counts`
- `changes.added`
- `changes.updated`
- `changes.deprecated`
- `changes.restored`
- 声明关系和推断关系数量
- `validation.validForProject`
- `planDigest`

确认后，使用相同的选择范围、Bundle 路径和 `GENERATED_AT`：

```bash
okf dbexplain sync \
  --include prod-main \
  --bundle-root /data/okf/prod-database \
  --generated-at "$GENERATED_AT" \
  --expect-plan sha256:<dry-run返回的planDigest>
```

最后验证：

```bash
okf --root /data/okf/prod-database validate
```

如果 apply 返回 `planChanged: true`，说明数据库结构、关系、选择范围、目标 Bundle 或工具版本发生变化。此时旧 Bundle 不会被写入，应重新 dry-run 和确认，不要绕过计划检查。

## 9. 生产环境不要使用可变的 `npm link`

`npm link` 适合开发机和单用户工具环境。生产环境建议构建一次、验证一次，然后部署不可变版本目录：

```text
/opt/okf-mcp-versions/<version-or-commit>/
/opt/okf-mcp-current -> /opt/okf-mcp-versions/<version-or-commit>/
```

系统命令使用稳定包装器 `/usr/local/bin/okf`：

```bash
#!/usr/bin/env bash
set -euo pipefail
exec node /opt/okf-mcp-current/bin/okf-mcp.js "$@"
```

新版本完成测试后，只切换 `/opt/okf-mcp-current`。回滚时将它切回上一个已验证版本，不在已部署版本目录中原地修改代码。

完整生产运行包流程参见 [Source Runtime Deployment](source-runtime-deployment.md)。

## 10. 常见问题

### 更新后 `okf` 仍执行旧代码

```bash
command -v okf
ls -l "$(command -v okf)"
git rev-parse HEAD
```

如果链接目标不是当前 checkout，在当前仓库重新执行 `npm link`。

### 更新后出现 `Cannot find module`

通常是依赖未按新锁文件更新：

```bash
npm ci
```

### `okf dbexplain` 找不到 dbexplain

```bash
command -v dbexplain
dbexplain --version
```

必须先由用户或运维流程安装 dbexplain。`okf-dbexplain` Skill 不会自动安装或升级 CLI。

### Skill 可以调用，但 `okf` 命令不存在

Skill 只是流程说明。回到仓库根目录执行 `npm link`，或者按生产方式创建 `/usr/local/bin/okf` 包装器。

### `git pull --ff-only` 失败

先运行：

```bash
git status --short
git log --oneline --decorate -10
```

检查本地提交或修改与远端历史的关系，再明确选择合并、变基或保留本地分支。不要为了更新工具而直接删除未知的本地工作。
