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

## 图标看不清时的流程

**打开指定文件并定位**：确认工作区 → Quick Open → 输入文件名 → 核对候选路径 → Enter → 确认文件标题 → Go to Line → 输入行号 → 核对定位。每一步遵守当前工具的观察/令牌要求。

**不用猜快捷键查命令**：命令面板按本地化名称搜索。常用 command ID 可在键盘快捷键设置中搜索核对，例如 `workbench.action.quickOpen`、`workbench.action.gotoLine`、`workbench.action.showCommands`、`workbench.action.openGlobalKeybindings`。不要把 command ID 输入集成终端或假定可在面板中直接执行 ID。

**键位不匹配**：打开 Keyboard Shortcuts 查看当前绑定及 `when` 条件；不要重置用户键位。执行、调试、任务运行、扩展安装、Git 发布都按用户请求单独判断，不把它们当作导航恢复。

来源：Microsoft [Default Keyboard Shortcuts](https://code.visualstudio.com/docs/reference/default-keybindings)（2026-09-09 查阅）。这是默认值核对，没有在用户工作区修改/执行代码来试键。
