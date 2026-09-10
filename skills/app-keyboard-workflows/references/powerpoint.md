# PowerPoint 操作手册

先读 [Office 共通操作](office-common.md)。最重要的是区别幻灯片缩略图、画布对象、文本插入点、备注窗格与放映窗口。相同 Ctrl+D、Delete、Tab 在这些区域产生不同结果。

## 编辑与组织

| 操作 | 默认键 | 核对 |
| --- | --- | --- |
| 新幻灯片 | `Ctrl+M` | 当前演示文稿及新页位置/版式 |
| 复制选中幻灯片 | `Ctrl+Shift+D` | 缩略图选择先确认；使用当前 Windows 绑定 |
| 复制选中对象 | `Ctrl+D` | 画布对象焦点；不要把它当成通用复制整页 |
| 删除页/对象/文字 | `Delete` | 完全由焦点/选择决定，执行前确认对象类型 |
| 窗格切换 | `F6` / `Shift+F6` | 缩略图、画布、备注、Ribbon 等 |
| 下一/上一对象 | `Tab` / `Shift+Tab` | 对象选择状态；文本内 Tab 可能缩进或进下一单元格 |
| 选择窗格 | `Alt+F10` | 用对象名/顺序替代小图标定位，仍需验证对应对象 |
| 查找/替换 | `Ctrl+F/H` | 核对搜索范围和匹配 |
| 退出文字编辑/选择 | `Esc` | 一次退出当前层级，随后核对 |
| 下一占位符 | `Ctrl+Enter` | 最后一个占位符可能新建幻灯片，不能当无副作用导航 |

## 文本与对象

| 操作 | 默认键 | 注意 |
| --- | --- | --- |
| 粗体/斜体/下划线 | `Ctrl+B/I/U` | 文字选择或后续输入格式 |
| 字体对话框 | `Ctrl+T` | 与 Excel 建表、Firefox 新标签不同 |
| 左/中/右对齐 | `Ctrl+L/E/R` | 文本段落，不是多个图形对象对齐 |
| 项目符号 | `Ctrl+Shift+L` | 核对当前段落 |
| 段落升/降级 | `Alt+Shift+Left/Right` | 改变列表层级；不适用于任意对象 |
| 段落上/下移动 | `Alt+Shift+Up/Down` | 确认文字编辑状态 |
| 超链接 | `Ctrl+K` | 核对文本、对象与链接目标 |
| 选择性粘贴 | `Ctrl+Alt+V` | 可能选择图片、文本、链接或嵌入对象 |
| 组合/取消组合 | `Ctrl+G` / `Ctrl+Shift+G` | 选中多个适合组合的对象；后续层级变化 |
| 微移选中对象 | 方向键；`Ctrl+方向键` 更小步长 | 先确认无文字光标；实际单位依缩放/网格 |
| 放大/缩小字号 | `Ctrl+Shift+PERIOD/COMMA` | 美式键盘对应 > / <；核对实际字号 |
| 保存/另存为 | `Ctrl+S` / `F12` | 核对 PPTX/PDF/其他格式 |

对象间对齐、分布、置顶、版式、母版、插入图片/图表：优先 Alt+Q 命令搜索或读取 Ribbon KeyTips。不要猜不同语言版本的长菜单序列。

## 放映专用键

| 操作 | 默认键 | 条件 |
| --- | --- | --- |
| 从第一页开始 | `F5` | 会切入放映窗口，重新确认前台 |
| 从当前页开始 | `Shift+F5` | 当前幻灯片已核对 |
| 下一动画/页 | `N` / `Space` / `Right` / `PageDown` | 先推进动画，不一定立即换页 |
| 上一动画/页 | `P` / `Left` / `PageUp` | 核对页号与动画状态 |
| 跳到指定页 | 数字序列后 `Enter` | 例如第 12 页：`sequence=["1","2","ENTER"]`，仅放映中 |
| 黑屏/恢复 | `B` / `PERIOD` | 切换；不是删除幻灯片 |
| 白屏/恢复 | `W` / `COMMA` | 切换；先确认不是编辑态 |
| 结束放映 | `Esc` | 返回编辑器，检查活动文档 |
| 放映快捷键帮助 | `F1` | 读取当前版本帮助；不是编辑器帮助入口的同一结果 |

## 工作流

**修改第 N 页标题**：缩略图/幻灯片导航定位 → 核对页号和标题 → 选择窗格或可访问性找到标题占位符 → 进入文字编辑 → 修改 → 检查溢出、换行和层级 → 保存。

**复制版式并制作新页**：在缩略图选择参考页 → 复制幻灯片 → 确认新增页 → 编辑各占位符 → 核对图片/备注没有误保留 → 查看整页版式。不要在文字光标状态盲按复制对象快捷键。

**演示前检查**：保存 → Shift+F5 → 验证页面/动画/链接 → Esc → 检查最终页码。导出 PDF 或打印后仍需核对分页、备注/讲义选项与字体布局；快捷键不能代替视觉 QA。

来源：Microsoft [Create presentations](https://support.microsoft.com/en-us/accessibility/powerpoint/use-keyboard-shortcuts-to-create-powerpoint-presentations)、[Deliver presentations](https://support.microsoft.com/en-us/accessibility/powerpoint/use-keyboard-shortcuts-to-deliver-powerpoint-presentations)，2026-09-09 查阅 Windows 内容；不使用同页 Mac 键位替代。
