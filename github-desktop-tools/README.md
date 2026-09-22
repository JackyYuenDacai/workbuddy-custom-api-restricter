# GitHub Desktop 仓库 MCP

让 WorkBuddy 读取 GitHub Desktop 已登记的本地仓库，查询 Git 状态。Windows / Node.js 22+ / Git；已实测 GitHub Desktop 3.6.5、WorkBuddy 内置 Node 22.22.2。

## 工具

| 工具 | 用途 |
| --- | --- |
| `desktop_repositories` | 完整登记清单：ID、名称、路径、缺失标记；可按 `query` 筛选 |
| `desktop_repository_status` | 按 `repositoryId` 返回分支、HEAD、上游、领先/落后、改动分类、冲突、文件、脱敏远程地址 |
| `desktop_repository_statuses` | 每页最多 8 个仓库，4 路并发查询；跟随 `nextOffset` 获取全部状态 |

可直接对 WorkBuddy 说：

> 列出 GitHub Desktop 管理的全部仓库，标出哪些有未提交改动、哪些落后于上游。

> 检查 workbuddy-local-only 的状态，列出暂存、未暂存、未跟踪和冲突文件。

查询接口只读，不修改 Desktop 数据库或 Git 索引；新增的 commit/push 接口按显式参数执行授权操作，不自动 fetch/pull。远程比较来自上次更新的本地跟踪引用，并非 GitHub 实时状态；没有上游时 ahead/behind 为 null。clean 仅表示工作区无改动，仍可能有未推送提交。未跟踪目录按目录聚合，计数不是递归文件总数；暂存与未暂存分类可能重叠。`maxFiles` 仅限制返回明细，完整计数保持不变。

## 安装 / 检查

```powershell
cd F:\GitHub\textgen\user_data\workbuddy-local-only\github-desktop-tools
npm ci --ignore-scripts
Copy-Item local-install.example.json local-install.json
# 编辑 local-install.json 中 Node、WorkBuddy CLI、配置目录、Desktop 数据库和 Git 的绝对路径
node workbuddy-install.mjs install
node workbuddy-install.mjs check
```

已有本机 `local-install.json` 时保留该文件，不覆盖。安装器通过 WorkBuddy 自身 CLI 注册用户级 `github-desktop-repos`，同时设置 `WORKBUDDY_CONFIG_DIR` 与 `CODEBUDDY_CONFIG_DIR`，避免误写 `.codebuddy`。先备份 `mcp.json` 与 `settings.json`，保留其他 MCP 和技能配置。配套技能安装到 `.workbuddy/skills/github-desktop-repos` 并保持默认自动选择。已有同名安装时拒绝覆盖，先检查差异。已打开的 WorkBuddy 会话若未刷新工具列表，新建会话或重新加载 MCP。

环境变量：
- `GITHUB_DESKTOP_DB_PATH`：默认 `%APPDATA%/GitHub Desktop/IndexedDB/file__0.indexeddb.leveldb`。
- `GITHUB_DESKTOP_GIT_PATH`：默认 PATH 中的 `git`；安装器使用配置的绝对路径。

卸载：在 WorkBuddy MCP 设置中删除 `github-desktop-repos`，删除对应用户技能目录；如需恢复设置，参考安装输出中的备份路径。不要用整份旧备份覆盖后续新增的其他配置。

## 数据一致性与限制

清单读取 GitHub Desktop 的 `Database` / `repositories` IndexedDB 对象存储，不扫描磁盘，不访问 GitHub API，不读取登录凭证。独立实现 LevelDB 日志、Manifest、SST 与 Chromium IndexedDB 数据解码：只读当前 Manifest 引用的表及当前日志，按序列号合并并应用删除记录；校验 CRC32C，校验读取前后文件状态。无数据库写锁，不保存数据库副本。连续三次无法取得一致快照时返回错误，不用旧仓库记录凑出清单。

Desktop 使用内部数据库格式，升级可能需要适配。当前支持 LevelDB 原始/Snappy 表、Blink 16–21 的普通 V8 对象；未知格式、外部值、缺文件、损坏均报错。数据库读取上限 256 MiB。Git 单仓库总时限 15 秒、单命令 12 秒、输出上限 8 MiB，超限作为该仓库错误返回。每页状态是独立采样，不是所有仓库同一瞬间的事务快照。

依据 Desktop 记录选择仓库，查询时校验真实 Git 根路径，支持 Windows 短路径和链接路径；目录丢失或意外落入父仓库时明确报告。Git 使用参数数组、不经 shell，关闭 optional locks 和外部 fsmonitor。远程 URL 的凭证、查询字符串和 fragment 不返回。

## 验证

```powershell
npm test
npm run probe
```

`npm test` 使用临时目录测试日志分片/校验、SST 压缩、Manifest 淘汰、删除记录、IndexedDB 解码、路径丢失、未初始化提交、改名、Unicode、冲突、分支差异、脱敏、取消与查询前后索引哈希不变。`probe` 使用真实 stdio MCP 握手、工具发现、分页遍历全部本机仓库、单仓库调用和无效 ID 错误验证，输出实时结果到 stdout。可用 WorkBuddy 的 Node 路径运行以验证目标运行时。

格式参考：[GitHub Desktop 仓库数据库](https://github.com/desktop/desktop/blob/development/app/src/lib/databases/repositories-database.ts)、[LevelDB 日志](https://github.com/google/leveldb/blob/main/doc/log_format.md)、[LevelDB 表格式](https://github.com/google/leveldb/blob/main/doc/table_format.md)、[Chromium IndexedDB 格式](https://github.com/chromium/chromium/blob/main/content/browser/indexed_db/docs/leveldb_coding_scheme.md)。


## Commit / Push（1.1）

新增 `desktop_repository_commit` 与 `desktop_repository_push`，共 5 个工具。二者需要 repositoryId、expectedBranch、expectedHead，默认 dryRun=true。commit 预览不写索引；push 预览连接远端但不更新引用。

Commit 默认 mode=staged；mode=paths 加 paths 字面相对路径列表可暂存并提交指定当前内容，保留其他暂存文件。dryRun=false 才执行。保留 hook 和签名配置，不 amend。执行失败可能留有已暂存改动，先检查状态。

Push 只把固定的当前 HEAD 推到指定 remote 的同名分支，不 force、不推 tags/其他分支、不自动设 upstream。拒绝多个 pushurl。proxy 省略沿用现有设置，空字符串直连，具体 URL 仅覆盖本次 Git 进程，不更改 global/local config。已停止的代理仍须恢复；不会自动改用旧截图中的端口。

每条写入命令默认 25 秒、范围 5–120 秒，输出上限 1 MiB；整个操作另有总时限。超时/取消终止进程树并标记 outcomeUnknown，实际引用可能已更新，须核对后重试。错误分类包含 proxy/network/authentication/remote-rejected/git-lock/identity。跨 MCP 进程通过工作树 Git 目录内的独占锁防止同时操作；进程异常退出后的旧锁需确认 owner 不再运行后处理。

```powershell
node workbuddy-install.mjs update
node workbuddy-install.mjs check
```

更新技能后重新连接 MCP 或新建 WorkBuddy 会话。使用示例与审批边界见配套 SKILL.md。测试通过真实临时仓库与本地 bare remote 完成，不向用户 GitHub 远端发布测试内容。
