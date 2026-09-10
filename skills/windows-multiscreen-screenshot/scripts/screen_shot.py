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
from PIL import Image

user32 = ctypes.WinDLL('user32', use_last_error=True)
gdi32 = ctypes.WinDLL('gdi32', use_last_error=True)
shcore = ctypes.WinDLL('shcore', use_last_error=True)
MONITORINFOF_PRIMARY = 1
SRCCOPY = 0x00CC0020
CAPTUREBLT = 0x40000000

def _bind(lib, name, restype, *argtypes):
    fn = getattr(lib, name)
    fn.restype, fn.argtypes = restype, argtypes
    return fn

_bind(user32, 'GetDC', wintypes.HDC, wintypes.HWND)
_bind(user32, 'ReleaseDC', ctypes.c_int, wintypes.HWND, wintypes.HDC)
_bind(gdi32, 'CreateCompatibleDC', wintypes.HDC, wintypes.HDC)
_bind(gdi32, 'CreateCompatibleBitmap', wintypes.HBITMAP, wintypes.HDC, ctypes.c_int, ctypes.c_int)
_bind(gdi32, 'SelectObject', wintypes.HANDLE, wintypes.HDC, wintypes.HANDLE)
_bind(gdi32, 'DeleteObject', wintypes.BOOL, wintypes.HANDLE)
_bind(gdi32, 'DeleteDC', wintypes.BOOL, wintypes.HDC)
_bind(gdi32, 'BitBlt', wintypes.BOOL, wintypes.HDC, ctypes.c_int, ctypes.c_int,
      ctypes.c_int, ctypes.c_int, wintypes.HDC, ctypes.c_int, ctypes.c_int, wintypes.DWORD)
_bind(gdi32, 'GetDIBits', ctypes.c_int, wintypes.HDC, wintypes.HBITMAP,
      wintypes.UINT, wintypes.UINT, ctypes.c_void_p, ctypes.c_void_p, wintypes.UINT)
_bind(shcore, 'GetDpiForMonitor', ctypes.c_long, wintypes.HANDLE, ctypes.c_int,
      ctypes.POINTER(wintypes.UINT), ctypes.POINTER(wintypes.UINT))

def _set_dpi_aware():
    """声明 per-monitor DPI 感知，确保枚举到物理像素坐标（否则高 DPI 下只截到缩放后的部分区域）"""
    try:
        set_context = _bind(user32, 'SetProcessDpiAwarenessContext', wintypes.BOOL, ctypes.c_void_p)
        if set_context(ctypes.c_void_p(-4)):  # PER_MONITOR_AWARE_V2
            return 'per-monitor-v2'
    except AttributeError:
        pass
    set_awareness = _bind(shcore, 'SetProcessDpiAwareness', ctypes.c_long, ctypes.c_int)
    if set_awareness(2) == 0:
        return 'per-monitor'
    # A manifest or host may already have established the process awareness.
    current = ctypes.c_int()
    get_awareness = _bind(shcore, 'GetProcessDpiAwareness', ctypes.c_long,
                          wintypes.HANDLE, ctypes.POINTER(ctypes.c_int))
    if get_awareness(None, ctypes.byref(current)) == 0 and current.value == 2:
        return 'per-monitor-existing'
    raise RuntimeError('Cannot establish per-monitor DPI awareness; refusing virtualized coordinates')

DPI_MODE = _set_dpi_aware()

class _BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [("biSize", wintypes.DWORD), ("biWidth", wintypes.LONG),
                ("biHeight", wintypes.LONG), ("biPlanes", wintypes.WORD),
                ("biBitCount", wintypes.WORD), ("biCompression", wintypes.DWORD),
                ("biSizeImage", wintypes.DWORD), ("biXPelsPerMeter", wintypes.LONG),
                ("biYPelsPerMeter", wintypes.LONG), ("biClrUsed", wintypes.DWORD),
                ("biClrImportant", wintypes.DWORD)]

def _grab_gdi(x, y, w, h):
    """Capture a physical desktop rectangle, preserving negative source coordinates."""
    if w <= 0 or h <= 0:
        raise ValueError('Capture width and height must be positive')
    hscreen = hdc = bm = old = None
    selected = False
    try:
        hscreen = user32.GetDC(None)
        if not hscreen:
            raise ctypes.WinError(ctypes.get_last_error())
        hdc = gdi32.CreateCompatibleDC(hscreen)
        if not hdc:
            raise ctypes.WinError(ctypes.get_last_error())
        bm = gdi32.CreateCompatibleBitmap(hscreen, w, h)
        if not bm:
            raise ctypes.WinError(ctypes.get_last_error())
        old = gdi32.SelectObject(hdc, bm)
        if not old or old == ctypes.c_void_p(-1).value:
            raise RuntimeError('SelectObject failed')
        selected = True
        if not gdi32.BitBlt(hdc, 0, 0, w, h, hscreen, x, y, SRCCOPY | CAPTUREBLT):
            raise ctypes.WinError(ctypes.get_last_error())
        restored = gdi32.SelectObject(hdc, old)
        if not restored or restored == ctypes.c_void_p(-1).value:
            raise RuntimeError('Could not deselect bitmap before GetDIBits')
        selected = False
        bmi = _BITMAPINFOHEADER()
        bmi.biSize = ctypes.sizeof(_BITMAPINFOHEADER)
        bmi.biWidth, bmi.biHeight = w, -h  # top-down; no vertical mirroring
        bmi.biPlanes, bmi.biBitCount, bmi.biCompression = 1, 32, 0
        buf = (ctypes.c_ubyte * (w * h * 4))()
        rows = gdi32.GetDIBits(hdc, bm, 0, h, buf, ctypes.byref(bmi), 0)
        if rows != h:
            raise RuntimeError(f'GetDIBits returned {rows}/{h} rows')
        return Image.frombytes('RGB', (w, h), bytes(buf), 'raw', 'BGRX', 0, 1)
    finally:
        if selected and hdc and old:
            gdi32.SelectObject(hdc, old)
        # Deleting the memory DC first also releases any still-selected bitmap.
        if hdc:
            gdi32.DeleteDC(hdc)
        if bm:
            gdi32.DeleteObject(bm)
        if hscreen:
            user32.ReleaseDC(None, hscreen)

class MONITORINFO(ctypes.Structure):
    _fields_ = [("cbSize", wintypes.DWORD),
                ("rcMonitor", wintypes.RECT),
                ("rcWork", wintypes.RECT),
                ("dwFlags", wintypes.DWORD)]

MONITORENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HANDLE, wintypes.HDC,
                                    ctypes.POINTER(wintypes.RECT), wintypes.LPARAM)
_bind(user32, 'GetMonitorInfoW', wintypes.BOOL, wintypes.HANDLE, ctypes.POINTER(MONITORINFO))
_bind(user32, 'EnumDisplayMonitors', wintypes.BOOL, wintypes.HDC,
      ctypes.POINTER(wintypes.RECT), MONITORENUMPROC, wintypes.LPARAM)

def _RECT_as_tuple(r):
    return (r.left, r.top, r.right, r.bottom)

def enum_monitors():
    """返回 [(index, is_primary, x, y, w, h, dpi_scale)]"""
    result = []
    errors = []
    def cb(hMonitor, hdc, lprect, data):
        info = MONITORINFO()
        info.cbSize = ctypes.sizeof(MONITORINFO)
        if not user32.GetMonitorInfoW(hMonitor, ctypes.byref(info)):
            errors.append(ctypes.get_last_error())
            return False
        r = _RECT_as_tuple(info.rcMonitor)
        is_primary = bool(info.dwFlags & MONITORINFOF_PRIMARY)
        # DPI（每屏可不同）
        dx, dy = wintypes.UINT(), wintypes.UINT()
        hr = shcore.GetDpiForMonitor(hMonitor, 0, ctypes.byref(dx), ctypes.byref(dy))
        dpi = f'{dx.value}x{dy.value}' if hr == 0 else 'unknown'
        result.append((is_primary, r[0], r[1], r[2]-r[0], r[3]-r[1], dpi))
        return True
    if not user32.EnumDisplayMonitors(None, None, MONITORENUMPROC(cb), 0):
        raise ctypes.WinError(errors[0] if errors else ctypes.get_last_error())
    if not result:
        raise RuntimeError('No visible monitors enumerated')
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
    if args.screen is not None and not 0 <= args.screen < len(monitors):
        ap.error(f'--screen must be between 0 and {len(monitors)-1}')
    if args.list:
        print(f'dpi_awareness={DPI_MODE}')
        for m in monitors:
            print(f"screen{m[0]}: primary={m[1]} x={m[2]} y={m[3]} {m[4]}x{m[5]} dpi={m[6]}")
        return

    out = args.out or os.path.join(os.path.dirname(os.path.abspath(__file__)), "outputs")
    os.makedirs(out, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")
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
