# 安装、验证和回滚

## 1. 适用范围

该补丁当前只在 README 指定的 WorkBuddy 5.5.3 build 上验证过。它修改两个已解包的 JavaScript 文件，不修改 EXE、不重新打包 ASAR、不关闭 Electron 完整性校验。

如果本机已经安装并验证过补丁，仅为了发布这个仓库，**不需要重新安装**。保留本机生成文件，检查 GitHub Desktop 的提交内容即可。以下步骤用于新安装或有计划的重新配置。

## 2. 准备环境和 API

1. 安装 Windows 版 WorkBuddy，核对版本及 build。
2. 安装 Node.js 22 或更新版本；实际 CLI 最好使用 WorkBuddy 自带的 Node 22。
3. 保留 WorkBuddy 的正常登录，不修改账号令牌或全局网络设置。
4. 启动自己的 OpenAI Compatible 服务，确认指定模型可推理。
5. 如果使用共享代理，确认指定模型映射到预期的本地后端，且服务端没有为该模型设置云端回退。

在 WorkBuddy 的自定义模型设置中建立以下配置（界面字段名可能随版本变化）：

| 设置 | 默认值 |
| --- | --- |
| 协议 | OpenAI Compatible，不启用 WorkBuddy 专有协议 |
| 模型 ID | `Qwen3.8-27B-EXL3-3.5bpw` |
| 显示名称 | 同上，便于核对 |
| Base URL | `http://127.0.0.1:8317/v1` |
| API Key | 服务实际要求的密钥，只保存在本机 WorkBuddy 配置中 |
| 工具调用 | 后端确实支持时启用；联网搜索需要工具调用能力 |
| 图片、推理能力 | 按实际模型和适配器能力设置，不要虚报支持 |

WorkBuddy 内部会使用 `custom-local:` 前缀，填写 API 的模型 ID 时不要添加它。补丁保留已配置模型的密钥，但强制覆盖它的地址和模型路由。

`GET /v1/models` 列出模型只表示可见，不代表工具调用、流式输出或真实推理一定可用。应至少做一次实际推理测试。

## 3. 获取源码和设置本机路径

进入本仓库根目录，即包含 `patch.cjs` 的目录。无需安装 npm 依赖。

```powershell
node --version
Copy-Item -LiteralPath .\paths.example.json -Destination .\paths.local.json
notepad .\paths.local.json
```

如果 `paths.local.json` 已经存在，不要复制覆盖，直接打开编辑。示例中的 `YOUR_NAME` 必须替换成真实目录：

```json
{
  "resourcesDir": "C:/Users/YOUR_NAME/AppData/Local/Programs/WorkBuddy/resources",
  "configDir": "C:/Users/YOUR_NAME/.workbuddy",
  "nodePath": "C:/Program Files/nodejs/node.exe",
  "backupDir": "C:/Users/YOUR_NAME/.workbuddy/local-qwen-program-backup"
}
```

- `resourcesDir`：应包含 `app.asar` 和 `app.asar.unpacked`。
- `configDir`：已有 WorkBuddy 用户配置目录，包含模型配置；不要误指向另一个账号。
- `nodePath`：测试 CLI 用的 Node。也可填写 `.workbuddy/binaries/node/versions/实际版本/node.exe`。
- `backupDir`：原始程序备份目录。首次安装时必须尚不存在，脚本拒绝覆盖已有备份。

优先级：**环境变量 → paths.local.json → 默认路径**。对应变量为 `WORKBUDDY_RESOURCES_DIR`、`WORKBUDDY_CONFIG_DIR`、`WORKBUDDY_NODE_PATH`、`WORKBUDDY_BACKUP_DIR`。路径不符合预期时，检查当前终端是否设置了这些变量。它们不是运行中 WorkBuddy 的 API 开关。

例如，仅为当前 PowerShell 会话指定安装目录：

```powershell
$env:WORKBUDDY_RESOURCES_DIR = 'D:/Apps/WorkBuddy/resources'
```

本地 JSON 不含 API Key，也被 Git 忽略。没有配置时，脚本尝试标准 Windows 用户安装目录、用户 `.workbuddy` 和当前 Node。

## 4. 完全退出 WorkBuddy

通过菜单或托盘正常退出，避免丢失任务。关闭窗口不一定意味着进程退出。

在**每次 install 或 restore 前**执行：

```powershell
if (Get-Process -Name WorkBuddy -ErrorAction SilentlyContinue) {
    throw 'WorkBuddy 仍在运行，请先从菜单或托盘退出，再继续。'
}
```

脚本本身不负责关闭应用或检测所有进程。不要批量结束所有 Node 进程，它们可能属于其他应用。如果另有独立运行的 WorkBuddy CLI，也应正常结束。

## 5. 测试策略并准备补丁

```powershell
npm test
node patch.cjs prepare
```

prepare 会：

1. 读取 ASAR 目录元数据和两个原始解包文件。
2. 对照归档中的原始 SHA256，确认文件来自同一构建。
3. 要求每个补丁锚点精确出现一次，不满足就停止。
4. 注入策略和路由修改，用 `vm.Script` 检查生成 JS 的语法。
5. 写入本仓库的 `staged/` 和 `manifest.json`，记录原始/补丁哈希及 ASAR 哈希。

这一步不写入 WorkBuddy 安装目录。如果输入已被补丁处理或已有 `staged/`，会停止，而不是重复叠加修改。

构建不匹配时，应停止并重新分析该版本，不要删掉完整性检查或放宽精确匹配条件。

## 6. 安装备份与程序补丁

确认已经退出 WorkBuddy，且当前终端对安装目录有写入权限。必要时使用管理员终端，但要确认路径仍指向正确的用户配置。

```powershell
node patch.cjs install
```

安装先核对原始文件及暂存文件哈希，将两份原始 JS 和清单写入 `backupDir`，再复制补丁并验证安装哈希。复制/验证阶段异常时，会尝试恢复原始 JS；磁盘或权限故障仍需人工检查。

实际修改文件只有：

```text
resources/app.asar.unpacked/cli/dist/codebuddy.js
resources/app.asar.unpacked/cli/dist/codebuddy-headless.js
```

不要把第三方提供的整包 JS 直接覆盖进去。仓库不提供这些程序包，必须从自己安装的 WorkBuddy 在本机生成。

## 7. 安装后验证

```powershell
npm run test:installed
node smoke.cjs help
node smoke.cjs local
node smoke.cjs auto
node smoke.cjs cloud
node smoke.cjs search
```

完整测试需要 `staged/`、`manifest.json`、安装程序及备份全部存在。10 项检查通过后，再启动桌面 WorkBuddy，检查启动、已有登录和实际会话。

| 模式 | 动作 | 要检查的结果 |
| --- | --- | --- |
| `help` | 读取 CLI supported models | 仅指定模型 |
| `local` | 不启用工具，发送固定短提示 | `assistantReplies[].exactReply=true`，`observedModels` 为指定模型 |
| `auto` | 启动参数指定 Auto | 仍收到指定模型的真实回复 |
| `cloud` | 启动参数指定 `gpt-5.5` | 仍收到指定模型的真实回复 |
| `search` | 只允许 WebSearch，搜索公开 Python 文档 | 工具 `completed`，`hasPythonDocs=true`，会话 `success` |

测试会使用已有模型凭据和登录，搜索测试发送公开查询。测试禁止会话持久化，但 WorkBuddy 本身仍可能写日志或遥测；本脚本只输出诊断摘要。

不要只看 `markerPresent`：提示词本身也含标记，应看真正的助手回复和模型信息。smoke 是诊断工具，不是完整自动验收器；外层退出码不能代替 JSON 中的 `code`、`timedOut`、`results` 和工具结果。

## 8. 回滚

先正常退出 WorkBuddy，执行第 4 节进程检查，再运行：

```powershell
node patch.cjs restore
```

restore 使用当前 `backupDir` 及其清单，确认当前文件为该次补丁或原始文件、备份哈希正确后恢复。如果应用更新导致哈希变化，会拒绝覆盖。

回滚不删除聊天、不清除登录，也不恢复模型设置。要撤销 API 设置，需另行在 WorkBuddy 中修改。不要在 restore 前把 `backupDir` 改成新的空目录。

## 9. 更新和重新安装

WorkBuddy 更新可能覆盖补丁，本项目不拦截更新。更新后不要默认仍是本地专用；先验证，适配完成前避免发送需要严格本地处理的内容。

- 相同构建换 API：按 [API 配置文档](API-CONFIGURATION.md) 先恢复、归档旧生成文件，再重新 prepare/install。
- 新构建：保留旧备份，不强行 restore 覆盖新版；确认新版原始文件完整，再分析新版锚点，并使用新的独立备份目录。
- 完整性校验拒绝补丁：停止使用并恢复原始文件；必要时通过官方安装器修复。不要修改 EXE、ASAR、fuse 或安全校验。

## 10. 常见问题

| 现象 | 检查方向 |
| --- | --- |
| `Staging directory already exists` | 已有准备结果；不要盲删，先确认安装/回滚状态并归档 |
| `Backup exists; refusing overwrite` | 旧备份被保护；先回滚，再为新安装选新目录 |
| `Unexpected build` / integrity mismatch | 文件被改过、版本不符或安装不完整；停止强行安装 |
| `WORKBUDDY_MODEL_POLICY_DENIED` | 检查模型 ID、URL、路径和模型是否禁用；不要改成失败后走云端 |
| `ECONNREFUSED` | API 未启动、端口或监听地址不正确 |
| 登录服务 `EACCES` | 受限终端/沙箱可能禁止联网；本补丁不阻断登录服务 |
| 搜索失败 | 检查账号权限、网络、模型工具调用能力和 WebSearch 状态 |
| 界面仍显示 Auto | 主程序缓存未修改；核对执行引擎、真实响应和补丁哈希 |
| 换接口后仍用旧地址 | 策略嵌入了安装文件；只改源码或界面不会更新已加载的补丁 |
