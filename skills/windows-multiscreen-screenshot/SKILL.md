---
name: windows-multiscreen-screenshot
description: Windows 单屏与多显示器截图，支持负坐标副屏、竖屏和混合高 DPI 布局。需要保存屏幕 PNG、枚举物理屏幕或排查副屏黑图/截不全时使用，以 DPI 感知的 GDI BitBlt 绝对坐标捕获可见桌面。
---

# Windows 多屏截图

使用 [screen_shot.py](scripts/screen_shot.py) 保存当前可见桌面。用户只要副屏时先枚举，再仅截目标屏；不要默认收集所有屏幕。窗口级 computer-use 观察优先用现有工具，以保留窗口身份和截图令牌；独立 PNG 不能代替点击工具的 snapshot_id。

## 推荐路径

Windows 负坐标副屏、竖屏或混合高 DPI 的独立截图，优先使用脚本的 **DPI 感知 + GDI BitBlt 绝对坐标**。不先尝试临时 PowerShell `System.Drawing.Graphics.CopyFromScreen` 代码，不依赖临时 `Add-Type -TypeDefinition` 编译 Win32 包装。

用户报告过 WorkBuddy 的 `Add-Type -AssemblyName System.Drawing` / CopyFromScreen 路径被策略拦截，而现有 Python GDI 路径成功。`-AssemblyName` 是加载程序集，`-TypeDefinition` 才涉及编译；仅凭红色 Failed 无法确定究竟是命令审核、受限语言模式、程序集加载、编译还是截图调用失败。诊断与安全边界见 [实现与排查](references/windows-capture.md)。

## 调用

使用已有、允许执行且安装 Pillow 的 Python。当前 WorkBuddy 常用解释器：

`C:/Users/JackyYuen/.workbuddy/binaries/python/envs/screenshot/Scripts/python.exe`

先确认路径存在，使用实际工具提供的 shell。WorkBuddy 曾有 PowerShell/ConPTY 弹窗、stdout 丢失或启动超时，可优先使用其稳定的 Bash；这不是 Windows 或 GDI 必须使用 Bash 的要求。不要在桌面终端注入命令绕过执行工具权限。

PowerShell 直接调用现有脚本也不需要 Add-Type：

```powershell
& '<python.exe>' '<skill_dir>/scripts/screen_shot.py' --list
& '<python.exe>' '<skill_dir>/scripts/screen_shot.py' --screen 0 --out '<output_dir>'
```

Git Bash 示例（将路径换成当前安装位置）：

```bash
"/c/Users/JackyYuen/.workbuddy/binaries/python/envs/screenshot/Scripts/python.exe" \
  "/c/Users/JackyYuen/.workbuddy/skills/windows-multiscreen-screenshot/scripts/screen_shot.py" \
  --screen 0 --out "<output_dir>"
```

- `--list`：仅列屏幕索引、主屏标记、物理像素矩形与 DPI 信息，不截图。
- `--screen N`：只截指定索引；索引按位置排序，0 不保证是主屏，也不等于 Windows 设置中的显示器编号。每次布局变化重新枚举。
- 不传 `--screen`：截所有屏；多屏时额外输出虚拟桌面合并图。仅在用户要求所有屏幕时使用。
- `--out`：明确输出目录。默认是脚本旁 `outputs`；不要把私人截图作为技能资源同步或提交。

解释器缺失时先找已有的 Pillow 环境；确需安装依赖才按当前环境权限处理，不因一次截图失败自动安装/升级系统环境。

## 坐标、方向与输出验证

1. **先设置 DPI 感知，再枚举/截图**。独立进程优先 Per Monitor V2，回退 `SetProcessDpiAwareness(2)`；检查返回值。不能静默把 system-aware 回退宣称为混合 DPI 的可靠物理坐标。
2. 保留显示器原始矩形 `(left, top, right, bottom)`，包括负值；BitBlt 的源为桌面 DC 的 `(left, top)`，目标为 `(0,0)`，宽高分别是右减左、下减上。不把负值截成 0，也不再乘一次 DPI 缩放。
3. 读取 DIB 使用负 `biHeight` 表示 top-down。正高度的 bottom-up 像素若直接当正向图显示，会出现垂直倒置；不要把此现象归因于副屏位置。只有确认用户需要旋转时才做后处理。
4. 检查 API 成功、PNG 存在且可解码、尺寸与目标屏物理矩形相符，再检查实际画面/方向。`DONE_FILES=[...]` 是成功保存列表；退出码 0 或空 stdout 单独都不足以证明截图内容正确。
5. 暗度/纯色检测只能作提示：暗主题、黑壁纸、锁屏、显示器空白都可导致低亮度。不能用平均亮度 <5 就断言捕获失败，更不能把它作为扩大捕获范围的理由。

stdout 缺失时，可将同一受允许命令的 stdout/stderr 写到工作目录日志，读取退出状态与 DONE_FILES，并验证文件。不要因没有文本输出反复截屏；先检查是否已有结果。

## 边界

GDI 捕获当前可见桌面，不保证遮挡/最小化窗口、GPU 独占、HDR 色彩、DRM 或受保护内容正确。独立截图与 Windows.Graphics.Capture 窗口工具各有用途，不替换所有后端。锁屏、UAC、安全桌面或明确截图权限拒绝时停止并说明原因；不能切换 API、shell 或编码方式规避限制。

本次用户经验用于选择兼容的已允许实现，不代表已定位原策略拒绝的确切来源，也不保证所有 Pillow 版本都会出现负坐标黑图。
