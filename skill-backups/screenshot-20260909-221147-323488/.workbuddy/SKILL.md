---
name: windows-multiscreen-screenshot
description: Windows 多显示器截屏。枚举所有屏幕（含副屏、竖屏、不同分辨率/DPI、负坐标布局），逐屏截图 + 可选合并全虚拟屏为一张大图。当用户要求"截屏/截图/截所有屏幕/截某个屏/多屏截图/竖屏截图"且平台是 Windows 时使用。已解决高 DPI 只截到一部分、负坐标副屏/竖屏出黑图两个坑。
agent_created: true
---

# Windows 多屏截屏

在 Windows 上对**所有显示器**逐屏截图，并可合并成一张全虚拟屏大图。兼容副屏、竖屏、跨分辨率、高 DPI、负坐标布局。

## 使用

**必须用 Bash 工具执行，不要用 PowerShell**（Windows 上 PowerShell 工具经 ConPTY 可能弹终端窗口、吞 stdout、或报 `0x800700E8` 启动超时；脚本本身体积小、依赖 GDI，Bash 直接调 python 更稳）。

在技能目录下执行（工作目录不同则用脚本绝对路径，Windows 下 Git Bash 用正斜杠 `/c/Users/...`）：

```bash
"<skill_dir>/scripts/screen_shot.py"
```

实际调用带 venv 的 python 解释器（见下节）：

```bash
"/c/Users/JackyYuen/.workbuddy/binaries/python/envs/screenshot/Scripts/python.exe" \
  "/c/Users/JackyYuen/.workbuddy/skills/windows-multiscreen-screenshot/scripts/screen_shot.py" \
  --out "/c/Users/JackyYuen/WorkBuddy/<workspace>"
```

子命令：

- `screen_shot.py` — 截所有屏，每屏一张 + 一张合并全虚拟屏（默认）
- `screen_shot.py --screen 0` — 只截第 0 屏
- `screen_shot.py --list` — 只列出屏幕布局（位置/尺寸/DPI/是否主屏）
- `screen_shot.py --out <dir>` — 指定输出目录

脚本依赖 **Pillow**。

> ⚠️ **stdout 可能被吞**：若 Bash 工具返回空输出（无 `DONE_FILES=` 行），把输出重定向到文件再读：
> ```bash
> "..."python.exe" "..."screen_shot.py" --out <dir> > /c/Users/.../shot_out.txt 2>&1
> ```
> 再用 Read 工具读 `shot_out.txt` 拿 `DONE_FILES=[...]`。不要据此判定脚本失败——exit 0 即成功。

## Python 运行环境

优先使用已带 Pillow 的 venv：

```
C:\Users\JackyYuen\.workbuddy\binaries\python\envs\screenshot\Scripts\python.exe
```

若该 venv 不存在或无 Pillow，用 managed Python 现场建 venv 并安装（**用 Bash，不用 PowerShell**）：

```bash
"/c/Users/JackyYuen/.workbuddy/binaries/python/versions/3.13.12/python.exe" -m venv \
  "/c/Users/JackyYuen/.workbuddy/binaries/python/envs/screenshot"
"/c/Users/JackyYuen/.workbuddy/binaries/python/envs/screenshot/Scripts/python.exe" -m pip install --quiet pillow
```

## 两个必须已解决的坑（脚本已内置，勿改回）

1. **高 DPI 只截到一部分**：进程未声明 DPI 感知时，Windows 返回缩放后的逻辑坐标（如 3840×2160 屏只截到 3072×1728）。脚本启动时调用 `SetProcessDpiAwareness(PER_MONITOR_DPI_AWARE)` 拿到物理像素坐标。不要删除 `_set_dpi_aware()`。
2. **负坐标副屏/竖屏出黑图**：Pillow 的 `ImageGrab.grab(bbox)` 对负坐标 bbox 会直接出黑图。脚本改用 **GDI 绝对坐标 BitBlt**（`GetDC` + `CreateCompatibleBitmap` + `BitBlt` + `GetDIBits`）按屏幕绝对坐标抓取，负坐标可靠。不要改回 `ImageGrab.grab(bbox)`。

## 验证

截完可用亮度自检确认非黑屏（每张转灰度求平均亮度，<5 视为黑屏）：

```python
from PIL import Image
img = Image.open(path).convert("L")
mean = sum(img.getdata()) / (img.width * img.height)
```

## 输出

PNG 文件，命名 `shot-<时间戳>-<primary|screenN>-<WxH>.png`，合并图为 `shot-<时间戳>-ALL-<WxH>.png`。最后一行输出 `DONE_FILES=["..."]` JSON 数组，可直接解析文件路径用于后续展示（present_files）。

## 边界

- 仅 Windows（依赖 `ctypes.windll` 的 GDI/user32）。
- 截的是当前可见画面；全屏独占/DRM 保护内容可能截不到。
- 若 `--list` 显示的坐标与 Windows 显示设置不符，多为 DPI 缩放，确认脚本未被改动。