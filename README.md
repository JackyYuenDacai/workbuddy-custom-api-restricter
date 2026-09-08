# WorkBuddy Custom API Restricter

将 WorkBuddy 的模型推理限制到一个指定的 OpenAI Compatible API 和模型，同时保留现有登录、联网搜索及其他非模型网络功能。

这是针对特定 WorkBuddy 构建的非官方程序补丁，**不是通用插件，也不是防火墙或离线模式**。仓库只提供补丁源码、测试和文档，不分发 WorkBuddy 程序、模型、登录信息或 API Key。

## 当前默认配置

| 项目 | 值 |
| --- | --- |
| 模型 | `Qwen3.8-27B-EXL3-3.5bpw` |
| OpenAI Compatible Base URL | `http://127.0.0.1:8317/v1` |
| 实际请求 | `POST http://127.0.0.1:8317/v1/chat/completions` |
| WorkBuddy 内部模型 ID | `custom-local:Qwen3.8-27B-EXL3-3.5bpw` |
| 已验证版本 | WorkBuddy `5.5.3` |
| 已验证 build | `104760a280d1710d375d024bc87a03f08d97c590` |
| 验证环境 | Windows x64，WorkBuddy 自带 Node `22.22.2-2` |
| 验证日期 | 2026-09-06 |

默认地址是 **8317，不是 5000**。设置中填写 Base URL，不要再加 `/chat/completions`。

## 怎么安装和使用

以下命令在本仓库根目录（包含 `patch.cjs` 的目录）用 PowerShell 执行。需要 Node.js 22+ 和上表对应版本的 WorkBuddy。**已经安装好补丁的用户不必重复安装**，直接使用或按下一节更换 API。

### 1. 在 WorkBuddy 中添加自定义模型

保持正常登录，在自定义模型设置中选择 **OpenAI Compatible**，填写：

- 模型 ID：`Qwen3.8-27B-EXL3-3.5bpw`，不带 `custom-local:` 前缀。
- Base URL：`http://127.0.0.1:8317/v1`，不带 `/chat/completions`。
- API Key：你的服务需要的密钥，只保存在 WorkBuddy，不要写入本仓库。
- 工具调用：后端支持时启用；联网搜索需要模型支持工具调用。

先确认 API 服务已启动。补丁只限制 WorkBuddy 请求，不能代替服务端正确配置模型映射。

### 2. 配置本机安装路径

```powershell
if (!(Test-Path -LiteralPath .\paths.local.json)) {
    Copy-Item -LiteralPath .\paths.example.json -Destination .\paths.local.json
}
notepad .\paths.local.json
```

把示例中的 `YOUR_NAME` 换成实际目录：

```json
{
  "resourcesDir": "C:/Users/YOUR_NAME/AppData/Local/Programs/WorkBuddy/resources",
  "configDir": "C:/Users/YOUR_NAME/.workbuddy",
  "nodePath": "C:/Program Files/nodejs/node.exe",
  "backupDir": "C:/Users/YOUR_NAME/.workbuddy/local-qwen-program-backup"
}
```

`resourcesDir` 必须包含 `app.asar` 和 `app.asar.unpacked`；`backupDir` 首次安装时必须不存在。`nodePath` 也可以填 WorkBuddy 自带 Node 的实际路径。这份 JSON 只配置安装/测试路径，**不配置 API URL**，且不会提交到 Git。

如果设置了 `WORKBUDDY_RESOURCES_DIR`、`WORKBUDDY_CONFIG_DIR`、`WORKBUDDY_NODE_PATH` 或 `WORKBUDDY_BACKUP_DIR` 环境变量，它们优先于 JSON；路径异常时先检查这些变量。

### 3. 退出 WorkBuddy，生成并安装补丁

先保存任务并从菜单或托盘完全退出。关闭窗口不一定退出程序；独立运行的 WorkBuddy CLI 也需要正常结束。然后逐条运行，任一步失败都先停止处理，不要继续安装：

```powershell
if (Get-Process -Name WorkBuddy -ErrorAction SilentlyContinue) {
    throw '请先完全退出 WorkBuddy。'
}
npm test
node patch.cjs prepare
node patch.cjs install
npm run test:installed
```

无需 `npm install`，路由补丁只用 Node 内置模块。prepare 只生成本机 `staged/` 和 `manifest.json`；install 才会备份并修改两个解包 JS 文件。安装目录写入需要相应权限。锚点、哈希或版本不匹配时不要强行覆盖。

### 4. 验证后正常使用

```powershell
node smoke.cjs local
node smoke.cjs auto
node smoke.cjs cloud
node smoke.cjs search
```

前三项应在 `observedModels` 中显示指定模型，且 `assistantReplies[].exactReply` 为 `true`；搜索测试应有 WebSearch 的 `completed` 结果。不要只看提示词中也会出现的 `markerPresent`。

随后启动 WorkBuddy，正常聊天或使用工具即可。现有登录和搜索网络路径保留；界面缓存仍可能显示 Auto，实际路由要以上述验证为准。

## 怎么更换 API URL

**需要同时修改 WorkBuddy 模型设置与 `policy.cjs`，然后重新生成、安装补丁并重启。只改界面会被旧策略覆盖，只改源码也不会改变已经安装的程序。**

### 示例：从 8317 更换到本机 9000 端口

打开 `policy.cjs`，将：

```javascript
const base = 'http://127.0.0.1:8317/v1';
```

改为：

```javascript
const base = 'http://127.0.0.1:9000/v1';
```

然后找到 `guardRequest()` 的 URL 检查，将原来的整段条件：

```javascript
if (url.origin !== 'http://127.0.0.1:8317' || url.pathname !== '/v1/chat/completions' ||
    url.username || url.password || url.search || url.hash) fail('Inference endpoint is not the approved local Chat Completions endpoint.');
```

替换为：

```javascript
if (url.origin !== 'http://127.0.0.1:9000' || url.pathname !== '/v1/chat/completions' ||
    url.username || url.password || url.search || url.hash) fail('Inference endpoint is not the approved local Chat Completions endpoint.');
```

在 WorkBuddy 中，把同一自定义模型的 Base URL 也改成 `http://127.0.0.1:9000/v1`。如果路径也变了，例如 Base URL 为 `https://llm.example.com/openai/v1`，对应的 origin 应为 `https://llm.example.com`，pathname 应为 `/openai/v1/chat/completions`。

不要给 Base URL 加末尾斜杠、查询参数或密钥。该补丁支持 Chat Completions，不是只改地址就能切换到 Responses/Anthropic 协议。使用远程 URL 后，也就不再是“仅本机推理”。

### 已安装补丁时，按此顺序使新地址生效

1. 保存任务并完全退出 WorkBuddy；按上面的进程检查确认退出。
2. **先保持旧 `backupDir` 不变**，运行 `node patch.cjs restore`，恢复原始程序。
3. 用文件管理器把旧 `staged/`、`manifest.json` 归档到 `archives/本次标识/`，同时复制保存旧 `paths.local.json`；保留原始备份目录，不删除它。
4. 打开 WorkBuddy 修改自定义模型的 Base URL，保存并再次完全退出。此时是未补丁过渡状态，不要开始普通推理任务。
5. 按上面的示例修改 `policy.cjs`，在根目录的 `paths.local.json` 中把 `backupDir` 改成一个**尚不存在**的新目录，例如 `.workbuddy/local-qwen-program-backup-api9000`。
6. 逐条运行下面命令，每一步成功后再继续，最后启动 WorkBuddy。

```powershell
npm test
node patch.cjs prepare
node patch.cjs install
npm run test:installed
node smoke.cjs local
node smoke.cjs search
```

首次安装、尚未打过补丁时，不需要 restore 或归档，直接修改策略和模型设置，再执行安装步骤。如果新的允许端口是 `5000`，还要把 `test.cjs` 中原有的 5000 拒绝样例改成另一个确实不允许的端口。

### 更换模型或 API Key

- 换模型：修改 `policy.cjs` 的 `const model = '精确模型ID';`，并在 WorkBuddy 中注册同一模型，按上述恢复/重新安装流程操作。保留 `custom-local:` 的内部前缀逻辑；测试中的拒绝样例不能变成新允许模型。
- 只换 Key、模型和地址不变：只更新 WorkBuddy 自定义模型的 API Key，保存并重启，通常无需重建补丁。用 `node smoke.cjs local` 验证。
- 撤销程序补丁：完全退出 WorkBuddy 后运行 `node patch.cjs restore`。不会删除聊天或清除登录，也不会自动撤销模型设置。

## 本地文档工具（可选安装）

另附 [document-tools 安装与使用说明](document-tools/README.md)：通过 MCP 为 WorkBuddy 提供 HTML 转 PDF、HTML 转 Markdown、Markdown 转 PDF、保存 Markdown 四项工具。使用已有 Edge/Chrome 本地转换，不调用额外模型，需单独安装该子目录的 npm 依赖。

## 本地 Qwen 性能技能

附带 [`local-qwen-performance`](skills/local-qwen-performance/SKILL.md) WorkBuddy 技能，可获取最近请求的 decode / 端到端 token/s、首段输出延迟、排队 / prefill 时间、缓存、MTP 接受率，以及 GPU 利用率、显存、温度和功耗。

安装到 WorkBuddy 用户技能目录（在本仓库根目录执行；已安装时先检查差异，不覆盖）：

```powershell
$performanceSkillTarget = Join-Path $env:USERPROFILE '.workbuddy/skills/local-qwen-performance'
if (Test-Path -LiteralPath $performanceSkillTarget) {
    throw '技能已存在，请先检查已有文件。'
}
Copy-Item -LiteralPath .\skills\local-qwen-performance -Destination $performanceSkillTarget -Recurse
```

在 WorkBuddy 新会话中说：

> 使用 local-qwen-performance 查看本地 Qwen 的速度、首段输出延迟、MTP 接受率和 GPU 显存。

或：

> 查看本地 Qwen performance，每两秒采样一次，共三次，说明速度有没有变化。

若技能未刷新，保存当前任务后重启 WorkBuddy。也可直接运行脚本验证：

```powershell
node skills/local-qwen-performance/scripts/collect.cjs
node skills/local-qwen-performance/scripts/collect.cjs --samples 3 --interval 2
npm run test:performance
```

脚本只读访问 TextGen 的 `http://127.0.0.1:5000/v1/internal/model/info`；**WorkBuddy 推理仍走 8317**，不会为了查性能改路由或发起压测。Node 脚本无额外 npm 依赖，GPU 查询需要本机 `nvidia-smi`。接口有认证时，通过 `TEXTGEN_METRICS_API_KEY` 环境变量提供密钥，勿提交到 Git。可用 `TEXTGEN_METRICS_URL` 指定另一本机端口的同名内部统计端点，不能指向云端或推理端点。

注意：后端只保留最近最多 32 条**已结束**请求，未提供每条请求的完成时间，也没有逐 token 实时速度。无新记录不等于模型停机；GPU 统计是整卡占用。技能会区分这些数据口径，避免将历史速度、采集时间、模型内部 MTP 与外部草稿模型混为一谈。

## Windows 电脑操作技能（可选）

附带 [`windows-computer-use`](skills/windows-computer-use/SKILL.md) 技能和 [`computer-tools`](computer-tools/README.md) 本地 MCP：查找并启动 Firefox/Chrome/Edge/Notepad、浏览器新窗口打开 URL、只读浏览器状态、多窗口切换、弹窗焦点恢复、前台/整屏截图、任务栏与系统托盘点击、中文输入、常用快捷键（含浏览器 Ctrl+L）和滚动。它补充当前 WorkBuddy 内置 ComputerUse 仅支持 macOS 的限制，不修改 WorkBuddy 程序或 Qwen 路由。

安装步骤见 [computer-tools/README.md](computer-tools/README.md)。安装后在 WorkBuddy 新会话中说：

> 使用 windows-computer-use，先查看我指定窗口的截图，不要编辑。

> 使用 windows-computer-use，打开 Firefox，用 Google 搜索 Astra，新建窗口并截图确认搜索结果；不要仅凭启动成功就报告完成。

每个输入动作必须依据最近截图，快照令牌 120 秒有效、只能用一次；窗口或前台发生变化时拒绝操作。最小化窗口会先恢复，活动弹窗会返回实际目标 ID；Windows 仍拒绝焦点时，用新整屏截图点击已显示的目标或请用户手动激活，不绕过限制。付款、发送、删除等最终动作仍需相应确认，不能把安装工具理解成全局自动批准。

只读截图也可能包含隐私内容；保持本地 Qwen 路由，并只选择任务相关窗口。模型如果无法实际看到截图，就不能继续猜测坐标操作。

## 详细文档

- [完整安装、验证、回滚与更新流程](docs/INSTALL.md)
- [替换 API 地址、模型和 API Key](docs/API-CONFIGURATION.md)
- [排查过程、程序修改原理与验证记录](docs/IMPLEMENTATION.md)

首次使用请先读安装文档。源码中有构建相关的精确匹配条件，不能直接拿旧补丁覆盖新版本 WorkBuddy。

## 限制的实际行为

- CLI/ACP 返回的可用模型列表只保留指定模型。
- 默认模型和走相同模型管理器的辅助代理使用指定模型。
- CLI 启动时传入 Auto 或其他模型，会被强制覆盖为指定模型，而不是执行云端推理。
- 运行时切换到非允许模型会被拒绝；底层请求再次校验模型和 URL。
- 模型回退拦截器被禁用，模型请求不使用系统 HTTP 代理、不跟随重定向。
- 不修改登录、搜索客户端、通用网络配置、TextGen 或 8317 代理配置。

桌面主程序缓存仍可能显示 Auto，这不等于执行引擎仍会使用 Auto。应用更新可能覆盖补丁。本项目限制的是 WorkBuddy 发出的模型请求；指定 API 背后的实际模型映射与服务端回退仍需你自己控制。

## 已完成验证

在上述版本和默认配置上完成：

- WorkBuddy 冷启动正常，现有登录会话可用。
- 10 项源码及安装测试全部通过。
- 分别以 Qwen、`auto`、`gpt-5.5` 启动实际 CLI 测试，三次均收到助手回复 `LOCAL_QWEN_OK`，响应模型均为 Qwen。
- 本地 Qwen 实际调用 `WebSearch`，工具状态 `completed`，结果包含 `docs.python.org`，最终会话 `success`。
- 已安装程序哈希匹配，备份可重建补丁，受完整性保护的 `app.asar` 未变更。

未验证所有桌面操作、所有辅助代理或退出后重新登录；这些结果不能替代新版本、新接口的重新测试。

## 仓库文件

| 文件 | 用途 |
| --- | --- |
| `policy.cjs` | 允许的模型、API 地址和请求校验策略；重新生成时注入程序 |
| `patch.cjs` | 准备、安装和回滚两个 CLI bundle |
| `paths.cjs` | 读取本机路径，不改变注入的路由策略 |
| `paths.example.json` | 无密钥的本机路径示例 |
| `test.cjs` | 策略、语法、哈希和备份重建测试 |
| `smoke.cjs` | 通过实际 CLI 测试推理和搜索，输出脱敏摘要 |
| `docs/` | 详细使用和实现文档 |

`paths.local.json`、`staged/`、`manifest.json`、日志、备份均被 Git 忽略。本机已有安装的这些文件应保留，不能因为不提交就删除；回滚和完整验证会用到它们。

只运行不依赖 WorkBuddy 安装的 6 项策略测试：

```powershell
npm test
```

无需 `npm install`，脚本仅使用 Node.js 内置模块。完整安装测试在准备并安装补丁后执行：

```powershell
npm run test:installed
```
 

本项目不包含 WorkBuddy 本身；使用者需自行合法安装 WorkBuddy，并遵守软件条款和相关 API 服务条款。
