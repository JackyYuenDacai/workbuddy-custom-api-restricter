# -*- coding: utf-8 -*-
"""
多屏截屏工具（Windows）
枚举所有显示器（含副屏/不同分辨率/DPI），逐屏截图 + 可选合并全虚拟屏。
用法：
  python screen_shot.py              # 截所有屏 -> outputs/ 每屏一张 + 一张合并
  python screen_shot.py --screen 0   # 只截第 0 屏
  python screen_shot.py --list       # 只列出屏幕布局
  python screen_shot.py --out <dir>  # 指定输出目录
"""
import ctypes, os, sys, json, argparse
from ctypes import wintypes
from datetime import datetime
from PIL import Image, ImageGrab

user32 = ctypes.windll.user32
gdi32 = ctypes.windll.gdi32
MONITORINFOF_PRIMARY = 1
SRCCOPY = 0x00CC0020

def _set_dpi_aware():
    """声明 per-monitor DPI 感知，确保枚举到物理像素坐标（否则高 DPI 下只截到缩放后的部分区域）"""
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)  # PROCESS_PER_MONITOR_DPI_AWARE
    except Exception:
        try:
            user32.SetProcessDPIAware()
        except Exception:
            pass

_set_dpi_aware()

class _BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [("biSize", wintypes.DWORD), ("biWidth", wintypes.LONG),
                ("biHeight", wintypes.LONG), ("biPlanes", wintypes.WORD),
                ("biBitCount", wintypes.WORD), ("biCompression", wintypes.DWORD),
                ("biSizeImage", wintypes.DWORD), ("biXPelsPerMeter", wintypes.LONG),
                ("biYPelsPerMeter", wintypes.LONG), ("biClrUsed", wintypes.DWORD),
                ("biClrImportant", wintypes.DWORD)]

def _grab_gdi(x, y, w, h):
    """GDI 逐屏绝对坐标 BitBlt，对负坐标副屏/竖屏也可靠（Pillow 直接 grab 负坐标 bbox 会出黑图）"""
    hscreen = user32.GetDC(0)
    hdc = gdi32.CreateCompatibleDC(hscreen)
    bm = gdi32.CreateCompatibleBitmap(hscreen, w, h)
    old = gdi32.SelectObject(hdc, bm)
    gdi32.BitBlt(hdc, 0, 0, w, h, hscreen, x, y, SRCCOPY)
    bmi = _BITMAPINFOHEADER()
    bmi.biSize = ctypes.sizeof(_BITMAPINFOHEADER)
    bmi.biWidth = w
    bmi.biHeight = -h  # top-down
    bmi.biPlanes = 1
    bmi.biBitCount = 32
    bmi.biCompression = 0
    buf = (ctypes.c_ubyte * (w * h * 4))()
    gdi32.GetDIBits(hdc, bm, 0, h, buf, ctypes.byref(bmi), 0)
    gdi32.SelectObject(hdc, old)
    gdi32.DeleteObject(bm)
    gdi32.DeleteDC(hdc)
    user32.ReleaseDC(0, hscreen)
    img = Image.frombuffer("RGBA", (w, h), bytes(buf), "raw", "BGRA", 0, 1)
    return img.convert("RGB")

class MONITORINFO(ctypes.Structure):
    _fields_ = [("cbSize", wintypes.DWORD),
                ("rcMonitor", wintypes.RECT),
                ("rcWork", wintypes.RECT),
                ("dwFlags", wintypes.DWORD)]

def _RECT_as_tuple(r):
    return (r.left, r.top, r.right, r.bottom)

def enum_monitors():
    """返回 [(index, is_primary, x, y, w, h, dpi_scale)]"""
    result = []
    MONITOR_DEFAULTTOPYARN = 0
    def cb(hMonitor, hdc, lprect, data):
        info = MONITORINFO()
        info.cbSize = ctypes.sizeof(MONITORINFO)
        user32.GetMonitorInfoW(hMonitor, ctypes.byref(info))
        r = _RECT_as_tuple(info.rcMonitor)
        is_primary = bool(info.dwFlags & MONITORINFOF_PRIMARY)
        # DPI（每屏可不同）
        try:
            dpi = user32.GetDpiForMonitor(hMonitor, 0, ctypes.byref(ctypes.c_ulong(0)))
        except Exception:
            dpi = 96
        result.append((is_primary, r[0], r[1], r[2]-r[0], r[3]-r[1], dpi))
        return True
    cbf = ctypes.CFUNCTYPE(wintypes.BOOL, wintypes.HANDLE, wintypes.HANDLE,
                           ctypes.POINTER(wintypes.RECT), wintypes.LPARAM)
    user32.EnumDisplayMonitors(None, None, cbf(cb), 0)
    # 按物理位置排序（先 x 后 y），重新编号
    result.sort(key=lambda m: (m[1], m[2]))
    return [(i, m[0], m[1], m[2], m[3], m[4], m[5]) for i, m in enumerate(result)]

def grab_monitor(monitors, x, y, w, h):
    """GDI 绝对坐标 BitBlt 抓单屏（负坐标副屏/竖屏可靠，不依赖 Pillow bbox）"""
    return _grab_gdi(x, y, w, h)

def merge_all(monitors):
    """GDI 绝对坐标抓整个虚拟屏（含所有屏，负坐标也正确）"""
    xs = [m[2] for m in monitors]
    ys = [m[3] for m in monitors]
    minx, miny = min(xs), min(ys)
    maxx = max(m[2] + m[4] for m in monitors)
    maxy = max(m[3] + m[5] for m in monitors)
    return _grab_gdi(minx, miny, maxx - minx, maxy - miny)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--screen", type=int, default=None, help="只截第 N 屏")
    ap.add_argument("--list", action="store_true", help="只列出屏幕布局")
    ap.add_argument("--out", default=None, help="输出目录")
    args = ap.parse_args()

    monitors = enum_monitors()
    if args.list:
        for m in monitors:
            print(f"screen{m[0]}: primary={m[1]} x={m[2]} y={m[3]} {m[4]}x{m[5]} dpi={m[6]}")
        return

    out = args.out or os.path.join(os.path.dirname(os.path.abspath(__file__)), "outputs")
    os.makedirs(out, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    files = []

    targets = [monitors[args.screen]] if args.screen is not None else monitors
    for m in targets:
        idx, primary, x, y, w, h, dpi = m
        img = grab_monitor(monitors, x, y, w, h)
        tag = "primary" if primary else f"screen{idx}"
        path = os.path.join(out, f"shot-{stamp}-{tag}-{w}x{h}.png")
        img.save(path)
        files.append(path)
        print(f"saved {path} ({w}x{h} dpi={dpi})")

    # 多屏时额外合并一张
    if len(monitors) > 1 and args.screen is None:
        merged = merge_all(monitors)
        mpath = os.path.join(out, f"shot-{stamp}-ALL-{merged.size[0]}x{merged.size[1]}.png")
        merged.save(mpath)
        files.append(mpath)
        print(f"saved {mpath} (merged {merged.size[0]}x{merged.size[1]})")

    print("DONE_FILES=" + json.dumps(files, ensure_ascii=False))

if __name__ == "__main__":
    main()