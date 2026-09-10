---
name: app-keyboard-workflows
description: 为 Windows computer-use 提供 Office（Word、Excel、PowerPoint、Outlook、OneNote、Access）、QQ、VS Code、Firefox 和 Altium 的快捷键与键盘工作流。在图标难辨认或需要命令搜索、菜单、编辑和导航时使用，区分焦点、组合键、顺序键和版本差异。
---

# 应用键盘工作流 / App keyboard workflows

这是 computer-use 的补充技能，提供应用知识，不替代桌面工具。WorkBuddy 搭配 `windows-computer-use`；其他环境搭配当前可用的 computer-use 技能，沿用其窗口选择、输入工具、截图令牌和权限要求。

只读当前应用的参考文件：

| 应用 | 按需参考 | 首选入口 |
| --- | --- | --- |
| QQ / QQNT | [QQ](references/qq.md) | 恢复现有窗口，确认账号和联系人，查看当前热键设置 |
| Visual Studio Code / VSCode | [VS Code](references/vscode.md) | 命令面板、快速打开、工作区搜索 |
| Mozilla Firefox | [Firefox](references/firefox.md) | 地址栏、页面查找、浏览器菜单 |
| Altium Designer / AD | [Altium](references/altium.md) | 确认文档类型和交互模式，快捷键帮助或视图恢复 |
| Office 共通 | [Office 共通操作](references/office-common.md) | Alt/F10 KeyTips、Alt+Q 命令搜索、窗格与保存 |
| Word | [Word](references/word.md) | 段落定位、样式、表格、域、修订、导出 |
| Excel | [Excel](references/excel.md) | 单元格范围、编辑模式、公式、表格、筛选、计算 |
| PowerPoint | [PowerPoint](references/powerpoint.md) | 缩略图/对象/文本焦点、排版、放映 |
| Outlook | [Outlook](references/outlook.md) | 先辨经典/新版/网页，再搜索、草稿、日历 |
| OneNote | [OneNote](references/onenote.md) | 笔记本/分区/页面、搜索、待办、同步 |
| Access | [Access](references/access.md) | 导航/设计/记录模式、主键与提交时点 |

Windows 窗口/托盘、按键参数、输入法、同键冲突与故障恢复见 [通用导航与排查](references/navigation-and-recovery.md)。Office 任务先读共通章再读所需应用章；不用为单项任务加载整本手册。完整阅读版由这些参考文件生成，供人检索/打印。

## 截图难辨认时，怎样继续

1. 先用窗口 ID、进程、标题或结构化应用状态确认目标。未知前台窗口时不能发送快捷键。QQ 托盘驻留不等于已关闭；按主技能的任务栏/托盘流程恢复，不反复启动。
2. 目标应用已确认，但小图标难辨认：优先一个可预测的导航动作，例如 Firefox `Ctrl+L`、VS Code `Ctrl+Shift+P`。它们可以把难辨认区域变成有文字的地址栏或命令列表。确认没有会拦截按键的模态对话框。
3. 取主技能要求的新截图/令牌再操作。随后用可访问性控件名称、角色、焦点、字段值、窗口/文档标题、URL、选中项文字或放大后的目标区域确认结果。工具返回“已发送按键”不等于操作成功。
4. 只有窗口身份已知、控件焦点未知时，可以尝试该应用明确的**导航入口**；不能因此直接输入、全选、删除、保存、发送或在 Altium 放置对象。截图全黑且工具又没有足够结构化证据时，停止依赖视觉的操作并说明缺少什么证据。
5. 若按键未生效，先检查焦点、弹窗、中文输入法组合状态、键位映射和工具能力。输入法候选窗里的 Enter 可能只确认候选词；不要自动再按一次，聊天软件下一次可能发送。避免固定次数的 Tab、重复开窗口或盲目连续 Esc。

## 按键表示与工具能力

- `Ctrl+Shift+P`：同时按住修饰键并按 P，完成后释放。
- `Ctrl+K → Ctrl+S`：两个依次发送的组合键，不是四键同时按。首键建立 chord 状态后，按工具支持的时限发送第二键；若观察延迟导致状态消失，改用菜单/命令面板，不盲目续接。
- `P → W`：先按字母 P、释放，确认菜单，再按 W。不是 `Ctrl+P`，也不是向正文输入字符串 `PW`。
- 表格是应用默认键位知识；实际工具的 schema 才决定可发送的键名、F 键、数字键、按住/释放或 chord 能力。不要把显示写法直接当作工具参数。
- WorkBuddy `local-computer-tools` 0.6.0 已支持通用键盘：`key="CTRL+SHIFT+P"`、`key="SHIFT+F1"`，或 `sequence=["CTRL+K","CTRL+S"]`。包含 Ctrl/Shift/Alt/Win 与左右修饰键、A–Z、0–9、F1–F24、导航、数字小键盘、标点、多媒体及 `VK_0xNN`。每个组合自动释放，不再有应用快捷键白名单。运行时若仍发现旧 enum，重新连接该 MCP 后重新发现 schema。
- 一个已确认的快捷操作可用 `sequence`（1–8 strokes）在一次新窗口令牌下发送，避免模型调用延迟使 chord 失效。它不是导航、输入、发送的盲目宏；每一步检查前台、窗口、敏感控件和 STOP，目标变化就停止并报告已完成数量。系统切换窗口后需新观察。Windows 安全桌面、Ctrl+Alt+Delete 和硬件 Fn 不是普通 SendInput 可保证实现的能力。

## 完成与副作用

菜单打开、文件打开、导航到目标、内容写入、保存、消息发送是不同完成条件。根据用户实际请求执行；已有授权不重复询问，单纯操作应用不扩展为发送消息、发布、运行代码或制造输出。保存/关闭/撤销依当前文档和用户授权判断；不要通过再次发送或撤销用户历史来验证第一次动作。

跨应用同名键会不同：Firefox `Ctrl+W` 关闭标签，Altium 原理图 `Ctrl+W` 进入画线；VS Code `Ctrl+P` 快速打开，Firefox/Altium `Ctrl+P` 打印；Altium PCB `Ctrl+F` 翻转板视图，不是通用查找。先读对应应用参考。

本技能提供 Windows 默认值和可核对的工作流，不宣称已验证用户所有自定义键位。遇到版本/布局差异，以该实例的菜单、快捷键设置或交互帮助为准，不为匹配本表修改用户设置。
