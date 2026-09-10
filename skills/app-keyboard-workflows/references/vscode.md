# Visual Studio Code — Windows

先确认是目标工作区/窗口，焦点不在终端、WebView、调试控制台或模态窗口。Vim、Emacs、JetBrains keymap 扩展和用户 keybindings 可覆盖默认值。以下组合键仅在实际工具支持时发送。

## 优先导航与查找

| 操作 | 默认键 | 状态/结果核对 |
| --- | --- | --- |
| 命令面板 / Show All Commands | `Ctrl+Shift+P` 或 `F1` | 出现带 `>` 的命令输入框；输入命令名称，确认结果项后 Enter |
| 快速打开文件 / Quick Open | `Ctrl+P` | 输入文件名或路径，核对工作区和完整路径再打开 |
| 跳到行/列 | `Ctrl+G` | 输入 `行:列`，例如 `120:8`；核对当前文件和状态栏 |
| 当前文件符号 | `Ctrl+Shift+O` | 出现符号列表；输入符号名过滤 |
| 工作区符号 | `Ctrl+T` | 需要对应语言服务支持；核对文件归属 |
| 当前文件查找 | `Ctrl+F` | 查找框获得焦点；核对大小写、正则、选区范围 |
| 下一个/上一个匹配 | `F3` / `Shift+F3` | 核对当前匹配和行号，不默认为跳转成功 |
| 工作区搜索 | `Ctrl+Shift+F` | 搜索侧栏出现；检查包含/排除路径 |
| 当前文件替换 | `Ctrl+H` | 先审阅匹配和范围；不默认 Replace All |
| 错误/警告列表 | `Ctrl+Shift+M` | Problems 面板和诊断列表 |
| 下一/上一诊断 | `F8` / `Shift+F8` | 核对诊断位置与消息 |
| 转到定义 / 返回 | `F12` / `Alt+Left` | 依赖语言服务；确认跳转文件/符号 |
| 快速修复 | `Ctrl+.` | 只先打开候选菜单；选择后可能修改代码 |

## 焦点、布局与编辑

| 操作 | 默认键 | 状态/结果核对 |
| --- | --- | --- |
| 聚焦第一编辑器组 | `Ctrl+1` | 是编辑器组，不是“第一个标签” |
| 资源管理器 | `Ctrl+Shift+E` | 文件树焦点；文件树中的 Delete 会删文件 |
| 侧栏显隐 | `Ctrl+B` | 切换状态，先确认当前是否显示 |
| 底部面板显隐 | `Ctrl+J` | 面板可能是终端；不是执行命令的授权 |
| 最近编辑器切换 | `Ctrl+Tab` / `Ctrl+Shift+Tab` | 按 MRU 顺序，不保证是相邻标签 |
| 保存当前文件 | `Ctrl+S` | 新文件会弹路径对话框；核对目标及脏标记 |
| 关闭当前编辑器 | `Ctrl+W` | 处理未保存提示，不默认丢弃 |
| 重命名符号 | `F2` | 语言服务可能改多个文件；核对符号和编辑结果 |
| 格式化文档 | `Shift+Alt+F` | 确认 formatter；可能改整份文件 |
| 切换行注释 | `Ctrl+/` | 核对选区；键盘布局可能改变触发方式 |
| 撤销/重做 | `Ctrl+Z` / `Ctrl+Y` | 仅在明确知道待撤销内容时使用 |
| 打开快捷键设置 | `Ctrl+K → Ctrl+S` | 或命令面板搜索 “Preferences: Open Keyboard Shortcuts” |

## 选择、编辑和重构速查

以下均以普通文本编辑器获得焦点为前提。多光标修改会同时作用于多个位置；先检查光标数与选区。

| 目标 | Windows 默认键 | 说明 |
| --- | --- | --- |
| 按单词移动/选择 | `Ctrl+Left/Right` / 加 `Shift` | 受语言单词分隔设置影响 |
| 行首/末、文件首/末 | `Home/End`、`Ctrl+Home/End` | 加 Shift 扩展选区；Home 可能先到首个非空白字符 |
| 选择当前行 | `Ctrl+L` | 重复会扩大选区；不是浏览器地址栏 |
| 扩展/缩小语法选区 | `Shift+Alt+Right/Left` | 依语言服务，从表达式扩展到外围结构 |
| 选中下一个相同文本 | `Ctrl+D` | 当前词或选区的下一匹配；检查是否应加入 |
| 选择全部相同匹配 | `Ctrl+Shift+L` | 一次建立多个光标，范围是当前文件 |
| 在上/下增加光标 | `Ctrl+Alt+Up/Down` | 某些显卡/系统热键会截获；不反复重试 |
| 撤销最后一个光标动作 | `Ctrl+U` | 不等于撤销文字内容 |
| 上/下移动整行 | `Alt+Up/Down` | 包含当前选择的多行 |
| 上/下复制整行 | `Shift+Alt+Up/Down` | 新增代码，核对重复范围 |
| 删除整行 | `Ctrl+Shift+K` | 不要求先选行；必须确认当前行 |
| 下/上插入空行 | `Ctrl+Enter` / `Ctrl+Shift+Enter` | 编辑器中与终端/聊天发送语义不同 |
| 缩进/取消缩进 | `Ctrl+]` / `Ctrl+[` | 工具可写 `CTRL+RBRACKET/LBRACKET`，以实际 schema 为准 |
| 块注释 | `Shift+Alt+A` | 依当前语言注释规则 |
| 格式化选区 | `Ctrl+K → Ctrl+F` | 需 formatter 支持，避免误格式化整文件 |
| 折叠/展开当前区域 | `Ctrl+Shift+[` / `Ctrl+Shift+]` | 核对光标所在代码块 |
| 全部折叠/展开 | `Ctrl+K → Ctrl+0` / `Ctrl+K → Ctrl+J` | 改变显示，不删除代码 |
| 查看定义而不离开 | `Alt+F12` | Peek Definition；Esc 退出已确认的 Peek |
| 查找引用 | `Shift+F12` | 查看引用不修改；重命名仍需 F2 和结果复查 |

## 工作区、搜索和设置

| 目标 | 默认键/命令 | 说明 |
| --- | --- | --- |
| 新建未保存文件 | `Ctrl+N` | 保存前核对文件类型和路径 |
| 另存为 | `Ctrl+Shift+S` | 保留/改变原文件依实际保存结果核对 |
| 打开文件夹 | `Ctrl+K → Ctrl+O` | 可能切换工作区；检查未保存文件 |
| 拆分编辑器 | `Ctrl+BACKSLASH` | 分组视图，不是复制磁盘文件 |
| 聚焦第 1/2/3 编辑器组 | `Ctrl+1/2/3` | 不同于标签序号 |
| 工作区替换入口 | `Ctrl+Shift+H` | 先审阅文件、匹配数、包含/排除和差异 |
| 设置 | `Ctrl+COMMA` | 搜索设置名，区分 User 与 Workspace 范围 |
| Zen Mode | `Ctrl+K → Z` | 布局切换；可通过同一已核实命令退出 |
| 源代码管理视图 | `Ctrl+Shift+G` | 先查看 diff；不自动 stage、commit、push |
| Markdown 预览 | `Ctrl+Shift+V` | 需要当前 Markdown 文件；不是粘贴纯文本 |
| 侧边 Markdown 预览 | `Ctrl+K → V` | 第二笔是单字母 V，不带 Ctrl |

搜索框中的正则、大小写、全词和“在选区查找”都会改变命中。工作区搜索也受 `.gitignore`、排除设置、当前根文件夹影响；零结果不能直接证明文件不存在。大范围替换先读差异预览与匹配上下文，执行后查看相关改动。

**调试与终端只按任务需要使用**：F5 通常启动/继续调试，F9 切换断点，F10/F11/Shift+F11 为逐过程/逐语句/跳出，Shift+F5 停止调试；它们会影响运行程序。`Ctrl+BACKTICK` 打开集成终端，不能用于“让编辑器恢复焦点”。当前 WorkBuddy 的终端/开发者控制台输入保护仍然适用。

## 图标看不清时的流程

**打开指定文件并定位**：确认工作区 → Quick Open → 输入文件名 → 核对候选路径 → Enter → 确认文件标题 → Go to Line → 输入行号 → 核对定位。每一步遵守当前工具的观察/令牌要求。

**不用猜快捷键查命令**：命令面板按本地化名称搜索。常用 command ID 可在键盘快捷键设置中搜索核对，例如 `workbench.action.quickOpen`、`workbench.action.gotoLine`、`workbench.action.showCommands`、`workbench.action.openGlobalKeybindings`。不要把 command ID 输入集成终端或假定可在面板中直接执行 ID。

**键位不匹配**：打开 Keyboard Shortcuts 查看当前绑定及 `when` 条件；不要重置用户键位。执行、调试、任务运行、扩展安装、Git 发布都按用户请求单独判断，不把它们当作导航恢复。

来源：Microsoft [Default Keyboard Shortcuts](https://code.visualstudio.com/docs/reference/default-keybindings)（2026-09-09 查阅）。这是默认值核对，没有在用户工作区修改/执行代码来试键。
