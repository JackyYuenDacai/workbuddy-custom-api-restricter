# WorkBuddy Codex MCP 工具

将本机 `codex exec --json` 封装为 WorkBuddy 可调用的 stdio MCP 服务，并配套 `../skills/codex-mcp-tools/SKILL.md`。

四个工具：`codex_status` 检查安装和登录；`codex_start` 启动任务；`codex_job` 查询进度/结果；`codex_cancel` 取消自己的任务。启动立即返回 ID，避免 MCP 单次请求等待整个模型任务。

## 安装与启用

需要 Node.js 22+、已登录的 Codex CLI 和 WorkBuddy。此适配器复用 Codex 的现有模型配置；不存储密钥。本地服务不代表离线推理。

在此目录运行：

```powershell
npm ci
if (!(Test-Path -LiteralPath ./local-install.json)) {
    Copy-Item -LiteralPath ./local-install.example.json -Destination ./local-install.json
}
# 将 local-install.json 的三个路径改为本机实际位置。
node workbuddy-install.cjs install
node workbuddy-install.cjs check
```

安装器通过 WorkBuddy CLI 注册用户级 `local-codex-tools`，备份原 MCP/settings 配置，安装 skill 并移除此 skill 的禁用覆盖。已有同名服务或 skill 时拒绝覆盖。`local-install.json` 和依赖目录均被 Git 忽略。WorkBuddy 配置改变后，刷新连接器或新开会话；以 CLI `get` 的 Connected 状态和实际工具调用为验证。

Windows 当前要求真实 `codex.exe`，不直接执行 npm 的 `codex.cmd` / `.bat` 包装脚本；仅安装 npm 版时需要定位包中的原生 Codex 二进制并设置 `WORKBUDDY_CODEX_PATH`。

Codex 可执行文件按 `WORKBUDDY_CODEX_PATH`、PATH、本机 `%LOCALAPPDATA%/OpenAI/Codex/bin/*/codex.exe` 顺序查找；最后一种方式选择最新文件。升级后无需硬编码哈希目录。非 Windows 系统可通过 PATH 或环境变量指定实际可执行文件。

默认 `workspace-write`，使用用户指定的目标工作目录和 `--approve-for-me` 自动审批审查；审查任务明确选择 `read-only`（此模式仍使用 `-a never`）。`additional_write_dirs` 支持用户授权的其他目录，不提供关闭沙箱参数。提示词通过 stdin 传递，不执行 shell 字符串。`model` 省略时继承用户配置。

每个连接一次只运行一个任务，默认 900 秒超时，上限 3600 秒。任务和最近 50 个结果只在进程内保存，连接断开或重启后不可查；正常断开或关闭服务时会尝试停止其活动任务并等待退出；强制杀死服务或系统崩溃无法保证清理。取消与超时不撤销已完成修改。不要自动重试修改任务。

## 验证  

```powershell
npm test
node probe.mjs
node probe.mjs --live
```

普通测试覆盖参数边界、完成事件确认、输出截断、失败、互斥、取消、超时、断连清理及安装健康状态，不调用模型。probe 验证 MCP 握手和工具发现；`--live` 额外发起一次只读模型请求并轮询结果，会使用 Codex 额度。成功的登录检查不保证网络可用。`codex_status` 的 `logged_in` 使用三态：`true` 已登录、`false` 明确未登录、`null` 检查异常；异常详情见 `login_error`。

`check` 不仅检查连接，还检查 MCP 是否启用、启动路径是否指向本仓库，以及已安装 skill 是否缺失、禁用或与仓库不同；任一异常以非零状态退出。探针遇到缺失工具、工具错误或登录无法确认时也返回非零状态。

若检查提示 skill 与仓库不同，先比较并合并两份文件，再同步到 WorkBuddy 用户技能目录。安装器不会覆盖已有 skill。MCP 使用仓库中的脚本，升级后刷新连接器/新开会话才能加载新代码；刷新前先确认没有活动任务。

## 卸载

使用 WorkBuddy 的 MCP 管理删除 `local-codex-tools`；删除用户技能目录中的 `codex-mcp-tools`。不会影响已有 `codex-exec` 或其他 MCP 服务。安装备份位于 WorkBuddy 配置目录下的 `backups/codex-tools-*`；恢复时合并相关条目，避免覆盖此后新增配置。

## 接口依据

- [OpenAI：Codex MCP server removal](https://learn.chatgpt.com/docs/mcp-server)：旧命令已移除；App Server 不是 MCP 协议的直接替代品。
- [WorkBuddy：MCP 配置](https://www.workbuddy.ai/docs/zh/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/MCP-Guide)：用户级 MCP 使用 `~/.workbuddy/mcp.json`。
- 本机验证基线：`codex-cli 0.155.0-alpha.9.2` 的 `codex exec --help`。


## 权限修复与人工审批（1.1）

`codex_start` 默认工作区可写。`approval_policy` 支持 `auto-review`、`ask-user`、`never`。自动审查模式不与 `--sandbox` 同传，因为本机 CLI 将它们定义为互斥，`--approve-for-me` 本身选择 workspace-write。CLI 必须支持该选项；较旧版本先升级。状态返回实际 sandbox、approval_policy、additional_write_dirs 和观察到的 permission_issues。

新增 `codex_request_approval(job_id)`：等原任务结束后，在相同保存的 thread 里续接，以 app-server `approvalPolicy=on-request`、`approvalsReviewer=user` 接收真实审批请求。新任务也可直接选择 ask-user。

`codex_job` 的 `phase=awaiting_user` 和 `pending_approvals` 表示等待用户，WorkBuddy 应显示具体请求并等待答复。`codex_approval_reply(job_id, approval_id, decision, user_response, answers?)` 将真实答复传回等待中的 Codex 请求。单次 command/file approval 使用 accept/decline/cancel；permissions 只返回已请求权限，scope=turn；不会写永久策略。当前支持命令、文件变更、权限和用户问题四类请求；未知/无法完整显示的请求明确拒绝，不放行。

等待用户最长 30 分钟，期间暂停任务执行计时。过期或重复 approval_id 被拒绝，进程关闭时取消挂起请求。审批连接属于当前 MCP 进程，重连后不能假定原 job 仍可操作。人工同意不等于绕过组织要求或修复 Windows 的沙箱 ACL。

更新已安装技能（先处理活动任务，再重新连接 WorkBuddy MCP）：

```powershell
node workbuddy-install.cjs update
node workbuddy-install.cjs check
```

update 备份原技能并同步源码，不修改其他 MCP 或账号设置。自动审批协议参考：[OpenAI approvals/security](https://learn.chatgpt.com/docs/agent-approvals-security)，人工审批参考：[OpenAI app-server](https://learn.chatgpt.com/docs/app-server)。
