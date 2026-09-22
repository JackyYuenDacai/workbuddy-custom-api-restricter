---
name: codex-mcp-tools
description: 通过 local-codex-tools MCP 让本机 Codex 执行代码分析、审查、修改或独立任务，查询进度并取消任务。当用户要求“用 Codex”“让 Codex 处理”或明确把工作交给 Codex 时使用；普通任务不自动转交。
---

# Codex MCP Tools

使用 WorkBuddy 已连接的 `local-codex-tools`。工具通常显示为 `mcp__local-codex-tools__codex_status` 等带前缀名称，以当前工具列表为准。本 skill 配合仓库 `codex-tools/` 的本地 stdio 服务使用，需要 Node.js 22+、已安装依赖的服务和可用的 Codex CLI。Windows 当前支持真实 `codex.exe`；npm 的 `codex.cmd` 包装文件不能直接作为可执行路径。`codex-tools/` 不在已安装的 skill 目录内，应从 MCP 配置的 `args` 中定位 `server.mjs`，其所在目录即服务目录。若工具是延迟加载的，使用当前宿主提供的发现和调用机制（例如可用时的 `ToolSearch`、`DeferExecuteTool`）；查询定义不是执行任务。工具不可用时先按下文排查，不要假定这些入口始终存在。

## 操作流程

1. 首次使用调用 `codex_status`，检查 `executable`、`version`、`logged_in`。若找不到可执行文件，先修复安装或服务环境中的 `WORKBUDDY_CODEX_PATH`（现有可执行文件的绝对路径）。`logged_in: true` 表示已登录；`false` 表示明确未登录，让用户运行返回的程序的 `login`；`null` 表示检查失败，先读取 `login_error`，必要时用返回的 `executable` 运行 `login status` 查看原因，不要将诊断失败当作未登录。若不在 PATH 中，PowerShell 使用 `& '实际 executable 路径' login`；不要读取或复制认证文件。此检查不证明模型联网成功。
2. 准备 `codex_start` 参数：提供完整 `prompt` 和服务主机上已存在、可访问的绝对目录 `cwd`。说明任务范围、相关文件、预期结果和验收条件；Codex 不会自动获得 WorkBuddy 的对话上下文。修改前记录已有改动，便于区分本次任务的 diff。
3. 启动前确定权限：审查和分析保留 `sandbox: "read-only"`；用户要求修改文件时使用 `"workspace-write"`。已授权的修改无需重复确认。`model` 未指定则省略，沿用 Codex 配置；不要替换用户点名的模型。参数确认后调用 `codex_start`。
4. 先检查 MCP 响应是否有 `isError: true`；当前服务将成功结果编码在 `content` 的文本块中，宿主未解包时先解析该 JSON，再读取 `id`、`state` 等字段。保存返回的 `id`，在同一 MCP 连接上用 `codex_job({"job_id":"返回的 id"})` 查询。通常间隔 5–15 秒，工作较长时向用户报告有意义的进展。`running`、`stopping` 和返回 job ID 都不表示任务完成；启动也可能立即返回 `failed`。
5. `completed` 表示已收到 `turn.completed` 且进程成功退出；此时读取 `answer`，对文件改动检查实际 diff 和相关验证结果；进程成功退出不等于满足验收条件。`failed`、`timed_out`、`cancelled` 时检查 `error`、`stderr` 和可能的部分改动；不要因连接或超时自动重跑写入任务。
6. 用户取消时调用 `codex_cancel({"job_id":"返回的 id"})` 并查询终态。取消报错或持续处于 `stopping` 时，报告尚未确认停止，不要宣称已取消。取消不会撤销已完成的修改。

调用示例（以工具结构参数传入，不拼接 shell 命令；将示例 `cwd` 替换为实际存在的任务目录）：

```json
{
  "prompt": "检查这个仓库的登录流程，列出有文件位置和依据的问题，不修改文件。",
  "cwd": "F:/GitHub/example",
  "sandbox": "read-only",
  "timeout_seconds": 900
}
```

## 限制与恢复

- 此 MCP 服务封装 `codex exec --json`。新版 Codex 已移除 `codex mcp-server`；`codex app-server` 使用独立协议，不能直接填作 MCP 命令，见 [OpenAI 官方说明](https://learn.chatgpt.com/docs/mcp-server)。实际 CLI 能力以 `codex_status` 返回的程序版本及其 `--help` 为准。
- 本地运行的是适配器；模型推理使用 Codex 已配置的账号/服务，可能访问网络。仓库名称 `local-only` 不意味着 Codex 离线推理。
- 每个 MCP 连接同时只运行一个任务，服务进程最多保留 50 个任务记录；新任务会淘汰最旧记录，重启也会清空记录。服务关闭会尝试停止自己的活动任务。重要结果及时保存到用户指定位置。
- 启动提示已有活动任务时，查询已知 ID，或等待该任务结束，不要重复启动或擅自取消。连接中断、启动响应丢失或 `Unknown job_id` 时，不要把查询失败当作任务失败；先核对连接、任务记录和文件改动。当前接口不能列出任务或找回丢失的 ID，无法确认时报告状态未知，不自动重跑写入任务。
- `answer` 只保留最后一条已完成的助手消息，`progress` 只保留最近事件，二者及 `stderr`、`error` 各保留末尾最多 64000 个 UTF-16 代码单元，发生截断时 `output_truncated` 为真。该标记不表示保存了全部历史事件。大型报告需要在启动前约定写入已授权工作区并选择 `workspace-write`；只读任务不能直接要求落盘。
- `timeout_seconds` 默认为 900，必须是 10–3600 的整数。到期尝试停止自己的进程树，不自动重试；停止可能失败或延迟，应以查询到的终态为准。
- 适配器使用 `-a never`，不绕过沙箱。权限/沙箱失败时报告具体错误；不要擅自切换为无沙箱或全盘写入。
- MCP 未出现时，检查 WorkBuddy 的用户配置 `~/.workbuddy/mcp.json`（自定义配置目录时使用实际位置）及项目级 `.workbuddy/mcp.json` 中的 `local-codex-tools`，核对 `command`、`args` 路径、依赖和启用状态，包括 `disabled` 与 `disabledMcpServers`。再刷新连接器或开启新会话；连接重建可能丢失任务记录，先保存已知状态。安装与诊断见上述服务目录内的 `README.md`；该文件缺失时报告缺失路径，不要将其当作 skill 内的相对路径。
