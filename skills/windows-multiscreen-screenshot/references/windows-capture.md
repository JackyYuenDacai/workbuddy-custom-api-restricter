# Windows 捕获实现与排查

## DPI 与虚拟桌面

在独立截图进程的最早阶段设置 DPI awareness。优先 `SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2)`；系统不支持时用 shcore `SetProcessDpiAwareness(PROCESS_PER_MONITOR_DPI_AWARE=2)`。若进程已设置，检查当前上下文是否 per-monitor-aware；无法确认时报告错误，不悄悄继续输出被虚拟化的坐标。

不要在已创建 GUI/已设置 DPI 的宿主里随意更改进程全局状态。此脚本应作为独立进程运行。枚举失败或 DPI 设置失败要暴露错误，不能吞掉所有异常并假设成功。

`GetDpiForMonitor` 属于 **shcore.dll**，需要 dpiX/dpiY 两个输出指针，返回的是 HRESULT；不是 user32 的同名函数，也不是直接返回 DPI。该 API 的数值受进程感知模式影响，在 per-monitor-aware 上下文仅作诊断，不能用来再次缩放已取得的屏幕矩形。查询不可用时显示 unknown，不能伪造 96 DPI。

例如左侧竖屏矩形 `(-2160,-600,0,3240)`：BitBlt 源起点是 `(-2160,-600)`，输出尺寸 `2160×3840`，与主屏是否位于 `(0,0)` 无关。虚拟屏外框用所有屏幕的最小 left/top 与最大 right/bottom；显示器间空隙没有实际屏幕内容。若将各屏图贴入合并画布，目标位置应减去虚拟屏最小 left/top；BitBlt 源绝对坐标不能作同样偏移。

## GDI 实现约束

- Python ctypes 声明所有 Win32 函数的 `argtypes/restype`，特别是 HDC/HBITMAP/HGDIOBJ 等指针大小句柄。64 位进程用默认 c_int 返回类型可能截断句柄。
- `GetDC(NULL)` 取得桌面 DC；目标使用兼容内存 DC 和位图。`BitBlt(dst,0,0,w,h,screen,left,top,SRCCOPY | CAPTUREBLT)`，CAPTUREBLT 有助于包含分层窗口，但不是受保护内容的绕过方式。
- 检查 DC、位图、SelectObject、BitBlt 和 GetDIBits 返回值；GetDIBits 应返回请求行数。
- 在 GetDIBits 前把位图从内存 DC 取消选择，恢复旧对象。GetDIBits 要求待取位图未被选入 DC。
- 32 位 BI_RGB、负高度读取 top-down，按 BGRX 解码 RGB，不把未定义的 alpha 当作可靠透明度。
- 使用 try/finally，恢复旧对象、DeleteObject 位图、DeleteDC 内存 DC、ReleaseDC 桌面 DC；失败路径也释放，不 DeleteDC 桌面 DC。
- 保存文件用微秒时间戳避免同秒覆盖；仅打印成功保存路径。输入屏号必须非负且在当前枚举范围内。

## PowerShell / Add-Type 拒绝怎么区分

| 证据 | 含义与处理 |
| --- | --- |
| `Add-Type -AssemblyName System.Drawing` | 加载已有程序集，不等同于动态编译；保留完整错误判断程序集/语言模式/审核问题 |
| `Add-Type -TypeDefinition ...` | 动态编译包装代码，可能受 Constrained Language、WDAC/AppLocker 或工具规则影响 |
| 命令工具明确禁止截图或拒绝此访问 | 停止相同访问，不改用 ctypes、Bash、编码命令等绕过；报告明确拒绝原因 |
| 仅此实现不兼容，截图访问本身允许 | 使用现有的获允许 Python GDI 脚本，避免临时编译 .NET |
| API 报错/输出全黑 | 检查返回值、会话状态、矩形、DPI、目标是否受保护；不能仅凭结果推断安全策略 |

不要关闭安全产品、改变执行策略或请求管理员权限来掩盖尚未定位的错误。该技能不会自行重复失败命令来“探测”策略。

## Pillow 与黑图

旧脚本或部分环境的 `ImageGrab.grab(bbox=...)` 可能默认只抓主屏，之后按负坐标裁剪产生黑边/黑图。支持的 Pillow 版本在 Windows 使用 `all_screens=True` 可正确处理虚拟桌面，负坐标本身不是 ImageGrab 必然失败的原因。

为统一此用户的负坐标/混合 DPI 独立截图流程，本技能固定选择 GDI BitBlt；这不要求撤销现有可正常工作的窗口捕获工具。反复黑图时不要一直换 API：先判断是否锁屏、RDP 会话断开、应用保护或硬件呈现限制。

参考：Microsoft 的 [DPI awareness context](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setprocessdpiawarenesscontext)、[GetDpiForMonitor](https://learn.microsoft.com/en-us/windows/win32/api/shellscalingapi/nf-shellscalingapi-getdpiformonitor)、[BitBlt](https://learn.microsoft.com/en-us/windows/win32/api/wingdi/nf-wingdi-bitblt)、[GetDIBits](https://learn.microsoft.com/en-us/windows/win32/api/wingdi/nf-wingdi-getdibits)，以及 [Pillow ImageGrab](https://pillow.readthedocs.io/en/stable/reference/ImageGrab.html)。这些是后续查阅入口；用户提供的失败截图不是它们的验证记录。
