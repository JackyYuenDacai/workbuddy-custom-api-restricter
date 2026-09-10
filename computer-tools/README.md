# Windows Computer Use for WorkBuddy

为 Windows WorkBuddy 提供本地电脑操作 MCP，以及配套的 [`windows-computer-use`](../skills/windows-computer-use/SKILL.md) 技能。当前 WorkBuddy 内置 ComputerUse 的实现仅支持 macOS；本项目不修改该平台限制，而是添加独立 Windows 工具。

## 能做什么

- 查找并启动 Firefox、Chrome、Edge、Notepad：注册表/常见目录/PATH 多来源查找，使用完整 exe 路径；不接受任意命令。
- 用指定浏览器在新窗口打开 HTTP(S) URL；读取指定浏览器标题和可用的地址栏状态。
- 列出并依次切换多个窗口；恢复最小化窗口，自动转向目标拥有的可见活动弹窗。
- 截取整个虚拟桌面并按一次性截图坐标操作任务栏、系统托盘、隐藏图标弹层和可见窗口。
- 截取指定前台窗口，返回 MCP 图片，不默认保存截图。
- 根据截图点击、双击、右键，输入中文/Unicode 文本。
- 常用编辑/导航快捷键、鼠标滚动。

不提供任意命令执行、自动 UAC/管理员操作、密码读取、剪贴板读取或远程桌面功能。查找/带 URL 启动/文本状态读取不要求视觉能力；按截图点击和确认页面内容仍需要视觉输入能力，不能仅依靠技能文字就获得视觉能力。

## 安装

需要交互式 Windows 桌面、Node.js 22+、Windows Python 和 Pillow。文本路由限制仍由原有补丁控制。本机使用 TextGen 已有的 Python/Pillow，无需给运行中的模型安装新 Python 包。

先按父目录文档填写 `paths.local.json`，然后进入 `computer-tools`：

```powershell
npm.cmd ci --ignore-scripts --no-fund
if (!(Test-Path -LiteralPath .\local-install.json)) {
    Copy-Item -LiteralPath .\local-install.example.json -Destination .\local-install.json
}
notepad .\local-install.json
```

填写实际 Windows Python 路径：

```json
{
  "pythonPath": "C:/Path/To/Python/python.exe"
}
```

可用该 Python 的 `-c "import PIL"` 确认 Pillow 是否已有。缺少时优先在独立虚拟环境安装 Pillow，不改动正在工作的模型环境；此处不自动安装或升级 Python 包。

```powershell
node workbuddy-install.cjs install
node workbuddy-install.cjs check
```

仅新增用户级 `local-computer-tools` MCP 条目，保留其他工具、登录和模型设置。检查应显示 `registered=true`、`connected=true`。存在同名条目或状态不明时拒绝覆盖。

再从仓库根目录安装技能：

```powershell
$computerSkillTarget = Join-Path $env:USERPROFILE '.workbuddy/skills/windows-computer-use'
if (Test-Path -LiteralPath $computerSkillTarget) {
    throw '技能已存在，请先检查差异。'
}
Copy-Item -LiteralPath .\skills\windows-computer-use -Destination $computerSkillTarget -Recurse
```

保存当前任务后，新建 WorkBuddy 会话或重启以刷新 MCP/技能。无需启用全局自动批准、关闭防火墙或修改模型路由。

### 已安装用户升级

MCP 注册指向本仓库的 `server.mjs`，源码更新后无需删除再注册。先比较仓库 `skills/windows-computer-use/SKILL.md` 与用户目录同名技能，保留自定义修改，备份旧文件后更新。随后保存任务并重启 WorkBuddy，让已启动的 MCP 进程重新加载；新会话中发现的工具应包含 `desktop_find_app`、`desktop_launch`、`desktop_browser_state`、`desktop_screen_observe` 和 `desktop_screen_click`，共 13 个工具。仅 `Connected` 不证明旧进程已加载新工具。

## 使用示例

> 使用 windows-computer-use，打开 Firefox，在 Google 搜索 Astra。先查找应用，用新窗口打开搜索 URL，不关闭现有窗口；读取浏览器状态并截图核对结果，不能仅凭启动成功就说搜索完成。

> 使用 windows-computer-use，查看我指定的记事本窗口，先截图确认内容，不要编辑。

> 使用 windows-computer-use，在我打开的测试窗口输入“你好 WorkBuddy”，操作后截图确认，不要发送或保存。

WorkBuddy 延迟加载工具时，先使用 ToolSearch 查找 `local-computer-tools`，再按实际 schema 使用 DeferExecuteTool。必须确认模型接收到了真实图片；如果它说看不到截图，应停止坐标操作。

## 工具与关键约束

| 工具 | 约束 |
| --- | --- |
| `desktop_find_app` | `app`: `firefox` / `chrome` / `edge` / `notepad`；PATH 未找到不代表未安装 |
| `desktop_launch` | `app` 同上；浏览器可加 `url`，仅 HTTP(S)、无内嵌账号密码，最多 2000 字符；固定新窗口，无任意参数；Notepad 不接受 URL |
| `desktop_browser_state` | 目标浏览器的 `window_id`；返回标题、可用的 `url` 或 `address_bar_text`，不改变焦点、不遍历网页文档表单 |
| `desktop_windows` | 只列可见窗口；标题可能含隐私信息 |
| `desktop_focus` | 恢复并置前窗口；可见活动弹窗优先，使用返回的 `activated_window_id` 继续；`focused=false` 时用整屏截图点击可见窗口或请用户手动激活 |
| `desktop_observe` | 只捕获当前前台且完整显示的目标窗口，图片最大 1600×1200 |
| `desktop_click` | 使用返回图片内坐标，最多双击，不能使用猜测的整屏坐标 |
| `desktop_type_text` | 最多 2000 字符，禁止换行/控制字符，不借用剪贴板，不自动 Enter |
| `desktop_key` | General Windows key/chord or short sequence; see keyboard examples below. |
| `desktop_scroll` | 必须传入截图内的 `x,y`，工具自动将指针移到目标正文/列表后滚动，不先点击；`amount` 正数向上、负数向下，单次 1–5 格 |
| `desktop_screen_observe` | 截取全部显示器、可见窗口、任务栏、系统托盘和壳弹层；返回一次性 `snapshot_id` |
| `desktop_screen_click` | 使用同次整屏截图的图片像素 `x,y` 点击；内部处理缩放和负坐标显示器，不接受盲猜绝对坐标 |

每个输入动作需要最近截图的 `snapshot_id`：120 秒有效、一次性，返回的 `valid_for_seconds` 为准。有效期适应本地模型约 50 秒的推理等待；界面变化后仍需重新观察。动作前再次检查目标窗口、进程、前台状态及边界；失败后不自动重试输入。多显示器负坐标和截图缩放由工具转换。

滚动会再次检查指针实际位置和该点所属的顶层窗口，防止窗口遮挡或用户移动鼠标后向错误目标发送滚轮。`performed=true` 仅表示输入发送成功，`content_movement_verified=false` 提醒调用方通过新截图比较内容位置。无变化时检查目标面板和滚动边界，不要盲目重复。升级后需重新连接 MCP 或重启 WorkBuddy，确认 `desktop_scroll` schema 包含必填 `x,y`。

常规 GUI 操作使用 `desktop_observe`：只向模型返回当前目标窗口，最大 1600×1200。跨窗口切换、任务栏、系统托盘及隐藏图标弹层使用 `desktop_screen_observe` → `desktop_screen_click`；第一次点击打开弹层后必须重新整屏观察再点击其中图标。Windows 仍只有一个键盘前台窗口，因此切换后要用新窗口 ID 重新观察，不能跨窗口复用 snapshot。

启动应用会使旧截图令牌失效。`process_started=true` 只表示进程启动调用成功，`window_observed=true` 只表示检测到新窗口。它们均不证明页面加载完成；`page_verified` 固定为 `false`，需要调用者根据新截图另行核对。如果窗口出现较慢而工具没找到，先查看窗口列表，不盲目重复启动。

浏览器状态通过 Windows 自带 UI Automation 读取浏览器界面中已知地址栏控件，不读网页文档、密码框、剪贴板或历史数据库。使用固定的 Windows PowerShell `-Command` 查询，不更改执行策略，不使用 `ExecutionPolicy Bypass`，无需新增 Python 包。版本、权限、加载过程可能导致 `url=null`；Firefox 将地址显示为搜索词时返回 `address_bar_text`，绝不能把它当作实际网址或加载完成证明。查询有 5 秒超时，失败退回标题和明确的未知状态。截图仍是页面内容验证所需证据。

窗口内页面发生变化不一定改变窗口边界，因此快照令牌不是对所有界面变化的检测器。用户切换同一窗口内的标签页或控件焦点时，也应停止并重新观察。

输入工具标注为可能产生后果的工具；MCP annotations 是提示而非权限隔离。应保留 WorkBuddy 的批准规则，并遵守技能中对发送、购买、删除等最终动作的确认要求。终端进程/明显 DevTools 输入被拒绝，但嵌入式终端无法完全识别，不能用 GUI 绕过命令权限。

## 暂停

- 告诉 WorkBuddy 停止操作。
- 把指针移到主屏左上角 `(0,0)` 或整个虚拟桌面的角落；输入检查将拒绝继续。
- 在此目录创建名为 `STOP` 的文件，锁定应用启动、焦点切换和输入；只读查找、状态、列表和截图仍可调用。

```powershell
New-Item -ItemType File -Path .\STOP
```

由用户手动移开指针或移除 STOP 后才能恢复，技能不能自行解除暂停。此机制不撤销已经执行的动作，也不是毫秒级的紧急硬件中断；请勿让工具操作未经授权的敏感界面。

## 验证

```powershell
npm.cmd test
# 替换成 local-install.json 配置的 Windows Python 路径：
& 'C:/Path/To/Python/python.exe' -X utf8 -m unittest test_backend -v
```

纯逻辑测试不触碰桌面，检查坐标变换、单次令牌、超时、暂停、焦点变化及禁止并行。

可选 Firefox 实测（会联网搜索 Astra，保留新窗口，不关闭任何现有窗口）：

```powershell
node browser-smoke.mjs --launch
# 若需要手动激活，点击测试窗口后，替换成上一步返回的 window_id：
node browser-smoke.mjs --window 123456
# 可选：在该窗口测试 Ctrl+L，只选中地址栏，不输入或提交：
node browser-smoke.mjs --window 123456 --ctrl-l
```

脚本通过真实 MCP 调用，截图仅保存到忽略目录 `test-output/`；需要查看截图才能判断结果是否加载。该测试不自动调用 Qwen，不把 MCP 工具链验证等同于模型自主规划能力验证。

另有 WorkBuddy + 本地 Qwen 的只读集成检查，从仓库根目录执行：

```powershell
node tests/check-computer-skill.cjs
```

它让 WorkBuddy 加载技能、发现并调用一次 `desktop_find_app(app="firefox")`，90 秒超时，不启动应用、不截图或输入，不改变全局工具批准设置。它验证模型能调用新工具，但不是完整的自主浏览器操作测试。

可选交互验证（会临时打开测试窗口，请先保存工作）：

```powershell
node smoke.mjs
```

Windows 拒绝自动激活时，可在用户同意后执行交互版本，并手动点击弹出的测试窗口：

```powershell
node smoke.mjs --manual
```

只在临时 Tk 窗口测试截图、中文输入、Ctrl+A、点击和实际滚动：鼠标从按钮移入右侧文本区，验证向下/向上的内容位置变化及左侧文本区保持不动。测试截图保存在被 Git 忽略的 `test-output/`。不会自动给 WorkBuddy/Qwen 发送该截图。窗口自动关闭；Windows 拒绝切换前台时测试会停止，不会把输入发到其他窗口。

锁屏、RDP 断开、UAC 安全桌面或后台服务会话可能无法截图或输入。不要因此关闭 UAC、提高模型权限或绕过操作系统限制。

## 本机验证记录（2026-09-06）

- 用户级 `local-computer-tools` 注册成功，状态 `Connected`；`windows-computer-use` 技能格式校验与安装哈希通过。
- 10 项 Node 控制器测试及 8 项 Python 后端测试通过：涵盖原有保护、启动令牌失效、无 PATH 的注册表查找、固定启动参数、URL 限制、浏览器快捷键和 UIA 超时降级。
- Firefox 不在 PATH，但从 HKLM App Paths 正确找到完整安装路径；真实 MCP 新开 Firefox 并 Google 搜索 Astra，最终截图确认搜索结果和 Ctrl+L 地址栏选中，未关闭原有窗口。初次截图仍在加载，后续截图才确认结果，不把标题出现当作页面成功。
- Firefox 155 的地址栏通过 UIA 暴露为 ComboBox，而不是普通 Edit，已兼容；本机搜索页返回 `address_bar_text="Astra"`、`url=null`，没有伪造实际 URL。
- WorkBuddy + 本地 Qwen 只读集成检查通过：实际调用 `Skill → ToolSearch → DeferExecuteTool`，成功获取 Firefox 的注册表路径和 `on_path=false`，没有启动或操作桌面。
- 经用户手动激活临时 Tk 测试窗口后，实际 MCP 截图、中文输入、Ctrl+A 替换、按钮点击均通过；滚动输入已发送，但测试窗口没有滚动内容，因此不将其描述为验证了页面滚动效果。
- 检查了最终测试截图，中文文字清晰，按钮状态显示 `Click received`；没有操作其他应用，测试窗口已关闭。
- Windows 首次拒绝自动切换前台时，工具停止而未绕过限制。测试窗口的 DPI 设置已与截图/输入使用的物理坐标保持一致。
- 原有 10 项模型路由测试和 8 项性能采集测试仍通过。没有修改推理地址、全局批准规则、UAC 或防火墙。
- 这验证的是本地 MCP/Win32 工具链，尚未验证 Qwen 对复杂界面的视觉识别准确率或整个 GUI 任务的自动规划能力。

## 滚动修复验证（2026-09-07）

- 新增截图坐标定向滚动：覆盖缩放、负显示器坐标、无效坐标/步数、指针移动失败、遮挡和前台切换；13 项 Node 测试和 15 项 Python 测试通过。
- 快照有效期改为 120 秒，测试模拟 50 秒推理仍能执行一次动作，同时验证超时及令牌重复使用仍被拒绝。
- 真实 MCP / Win32 / Tk 双面板测试通过：鼠标从按钮移入右侧正文，无需额外点击；右侧向下滚动位置为 0.048，再向上至 0.032，左侧始终为 0。截图确认左侧从第 1 行开始，右侧从第 4 行开始。
- 同次实测中文输入、Ctrl+A 和按钮点击通过；测试窗口自动关闭。已通过技能格式校验并同步到 WorkBuddy 安装目录，保留旧版备份。已有 MCP 进程仍需重新连接或重启 WorkBuddy 才会加载新 schema。

## 隐私与卸载

截图在正常调用时通过 MCP 返回给 WorkBuddy，其会话/日志保留策略由 WorkBuddy 控制；“不保存截图文件”不等于“截图没有进入会话”。本工具没有云端 API，但 WorkBuddy 配置的模型会收到截图，因此需自行维持正确的本地路由。

```powershell
node workbuddy-install.cjs remove
```

只移除用户级 `local-computer-tools` 条目，不删除其他设置、技能或测试产物。还要禁用技能时，可在 WorkBuddy 技能界面停用 `windows-computer-use`。源码和依赖锁文件可以提交；`node_modules`、本机路径配置、截图和测试产物被 Git 忽略，不应上传。

Keyboard 0.6.0: `key="CTRL+SHIFT+P"`, `sequence=["CTRL+K","CTRL+S"]`. All standard key families and documented `VK_0xNN` keys are supported. Sequences contain 1?8 strokes for one known operation; each stroke releases its keys and checks target/STOP. Secure desktop and hardware Fn cannot be bypassed. Reconnect the MCP to load the new schema. Validation: 21 controller tests, 41 backend tests, and real MCP delivery of Ctrl+Shift+P, Shift+F1, Ctrl+K then Ctrl+S, and Ctrl+Home to a disposable recorder.
