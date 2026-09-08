"""One-shot Win32 desktop bridge. JSON on stdin/stdout; no arbitrary shell actions."""
import base64
import ctypes as C
from ctypes import wintypes as W
import io
import json
import os
import sys
import time
import subprocess
from pathlib import Path
from apps import BROWSERS, find_app, launch_argv, validate_url

if sys.platform != "win32":
    raise SystemExit("Windows interactive desktop required")

user = C.WinDLL("user32", use_last_error=True)
kernel = C.WinDLL("kernel32", use_last_error=True)
dwm = C.WinDLL("dwmapi", use_last_error=True)
dwm.DwmGetWindowAttribute.argtypes = [W.HWND, W.DWORD, C.c_void_p, W.DWORD]
try:
    user.SetProcessDpiAwarenessContext.argtypes = [C.c_void_p]
    user.SetProcessDpiAwarenessContext(C.c_void_p(-4))
except AttributeError:
    user.SetProcessDPIAware()

class Rect(C.Structure):
    _fields_ = [("left", W.LONG), ("top", W.LONG), ("right", W.LONG), ("bottom", W.LONG)]

class Point(C.Structure):
    _fields_ = [("x", W.LONG), ("y", W.LONG)]

class MouseInput(C.Structure):
    _fields_ = [("dx", W.LONG), ("dy", W.LONG), ("mouseData", W.DWORD), ("dwFlags", W.DWORD), ("time", W.DWORD), ("dwExtraInfo", C.c_size_t)]

class KeyInput(C.Structure):
    _fields_ = [("wVk", W.WORD), ("wScan", W.WORD), ("dwFlags", W.DWORD), ("time", W.DWORD), ("dwExtraInfo", C.c_size_t)]

class InputUnion(C.Union):
    _fields_ = [("mi", MouseInput), ("ki", KeyInput)]

class Input(C.Structure):
    _fields_ = [("type", W.DWORD), ("value", InputUnion)]

user.GetForegroundWindow.restype = W.HWND
user.GetWindowRect.argtypes = [W.HWND, C.POINTER(Rect)]
user.IsWindow.argtypes = [W.HWND]
user.IsWindowVisible.argtypes = [W.HWND]
user.IsIconic.argtypes = [W.HWND]
user.GetWindowTextW.argtypes = [W.HWND, W.LPWSTR, C.c_int]
user.GetWindowThreadProcessId.argtypes = [W.HWND, C.POINTER(W.DWORD)]
user.SetForegroundWindow.argtypes = [W.HWND]
user.ShowWindow.argtypes = [W.HWND, C.c_int]
user.GetCursorPos.argtypes = [C.POINTER(Point)]
user.SetCursorPos.argtypes = [C.c_int, C.c_int]
user.SetCursorPos.restype = W.BOOL
user.WindowFromPoint.argtypes = [Point]
user.WindowFromPoint.restype = W.HWND
user.GetAncestor.argtypes = [W.HWND, W.UINT]
user.GetAncestor.restype = W.HWND
user.SendInput.argtypes = [W.UINT, C.POINTER(Input), C.c_int]
user.SendInput.restype = W.UINT
kernel.OpenProcess.argtypes = [W.DWORD, W.BOOL, W.DWORD]
kernel.OpenProcess.restype = W.HANDLE
kernel.QueryFullProcessImageNameW.argtypes = [W.HANDLE, W.DWORD, W.LPWSTR, C.POINTER(W.DWORD)]
kernel.CloseHandle.argtypes = [W.HANDLE]
user.keybd_event.argtypes = [W.BYTE, W.BYTE, W.DWORD, C.c_ulong]
user.AttachThreadInput.argtypes = [W.DWORD, W.DWORD, W.BOOL]
kernel.GetCurrentThreadId.restype = W.DWORD

BLOCKED = {"cmd.exe", "powershell.exe", "pwsh.exe", "windowsterminal.exe", "openconsole.exe", "conhost.exe", "bash.exe", "wsl.exe", "mintty.exe", "wezterm-gui.exe"}
KEYS = {"ENTER":13, "TAB":9, "ESC":27, "BACKSPACE":8, "DELETE":46, "UP":38, "DOWN":40, "LEFT":37, "RIGHT":39,
        "HOME":36, "END":35, "PAGEUP":33, "PAGEDOWN":34, "CTRL":17, "SHIFT":16, "A":65, "F":70, "L":76, "S":83, "Z":90, "Y":89}
ALLOWED_KEYS = {"ENTER", "TAB", "ESC", "BACKSPACE", "DELETE", "UP", "DOWN", "LEFT", "RIGHT", "HOME", "END", "PAGEUP", "PAGEDOWN",
                "CTRL+A", "CTRL+F", "CTRL+L", "CTRL+S", "CTRL+Z", "CTRL+Y", "SHIFT+TAB"}

def window_info(window_id):
    hwnd = int(window_id)
    if hwnd <= 0 or not user.IsWindow(hwnd) or not user.IsWindowVisible(hwnd):
        raise ValueError("Window is unavailable or not visible.")
    rect = Rect()
    if not user.GetWindowRect(hwnd, C.byref(rect)):
        raise ValueError("Cannot read window bounds.")
    visible_rect = Rect()
    if dwm.DwmGetWindowAttribute(hwnd, 9, C.byref(visible_rect), C.sizeof(visible_rect)) == 0:
        rect = visible_rect
    title = C.create_unicode_buffer(512)
    user.GetWindowTextW(hwnd, title, 512)
    pid = W.DWORD()
    user.GetWindowThreadProcessId(hwnd, C.byref(pid))
    process_name = "unknown"
    handle = kernel.OpenProcess(0x1000, False, pid.value)
    if handle:
        try:
            image = C.create_unicode_buffer(32768)
            size = W.DWORD(len(image))
            if kernel.QueryFullProcessImageNameW(handle, 0, image, C.byref(size)):
                process_name = os.path.basename(image.value)
        finally:
            kernel.CloseHandle(handle)
    return {"window_id": str(hwnd), "title": title.value, "process": process_name, "pid": pid.value,
            "foreground": hwnd == user.GetForegroundWindow(), "minimized": bool(user.IsIconic(hwnd)),
            "rect": {key: getattr(rect, key) for key in ("left", "top", "right", "bottom")}}

def list_windows():
    windows = []
    callback_type = C.WINFUNCTYPE(W.BOOL, W.HWND, W.LPARAM)
    def collect(hwnd, _):
        if len(windows) >= 100:
            return False
        try:
            info = window_info(hwnd)
            if info["title"]:
                windows.append(info)
        except ValueError:
            pass
        return True
    callback = callback_type(collect)
    user.EnumWindows(callback, 0)
    return {"windows": windows}

def screen_bounds():
    left, top = user.GetSystemMetrics(76), user.GetSystemMetrics(77)
    return (left, top, left + user.GetSystemMetrics(78), top + user.GetSystemMetrics(79))

def corner_guard(x, y):
    left, top, right, bottom = screen_bounds()
    if (x, y) in {(left, top), (right - 1, top), (left, bottom - 1), (right - 1, bottom - 1), (0, 0)}:
        raise ValueError("Emergency stop: pointer is in a screen corner. Move it away manually to resume.")

def ensure_target(request, mutation=False):
    info = window_info(request["window_id"])
    if not info["foreground"] or info["minimized"]:
        raise ValueError("Target is not the visible foreground window. Focus it and obtain a new screenshot.")
    if request.get("expected_rect") is not None and info["rect"] != request["expected_rect"]:
        raise ValueError("Window bounds changed. Obtain a new screenshot.")
    if request.get("expected_pid") is not None and info["pid"] != request["expected_pid"]:
        raise ValueError("Window process changed. Obtain a new screenshot.")
    if mutation:
        if info["process"].lower() in BLOCKED or "devtools" in info["title"].lower() or "developer tools" in info["title"].lower():
            raise ValueError("Terminal and developer-console input is not supported. Use approved coding tools instead.")
        cursor = Point()
        user.GetCursorPos(C.byref(cursor))
        corner_guard(cursor.x, cursor.y)
    return info

def send_inputs(items):
    values = (Input * len(items))(*items)
    if user.SendInput(len(items), values, C.sizeof(Input)) != len(items):
        raise ValueError("Input was rejected, possibly by application privilege level. Do not bypass elevation boundaries.")

def key_input(vk=0, scan=0, flags=0):
    item = Input()
    item.type = 1
    item.value.ki = KeyInput(vk, scan, flags, 0, 0)
    return item

def focus_window(window_id):
    """Activate a window from a non-foreground helper process.

    A fresh `windowsHide` child process is not the foreground process and has
    no pending user input, so a bare SetForegroundWindow is denied by Windows.
    Use the standard activation recipe (restore, AttachThreadInput to the
    foreground thread, and a synthetic Alt press) to legitimately gain the
    right to set the foreground window. This does not bypass UAC or elevation.
    """
    hwnd = int(window_id)
    info = window_info(window_id)
    if info["minimized"]:
        user.ShowWindow(hwnd, 9)  # SW_RESTORE
    else:
        user.ShowWindow(hwnd, 5)  # SW_SHOW
    fg = user.GetForegroundWindow()
    fg_thread = user.GetWindowThreadProcessId(fg, None) if fg else 0
    cur_thread = kernel.GetCurrentThreadId()
    attached = False
    if fg and fg_thread and fg_thread != cur_thread:
        attached = bool(user.AttachThreadInput(cur_thread, fg_thread, True))
    try:
        for _ in range(3):
            user.keybd_event(0x12, 0, 0, 0)          # Alt down
            user.keybd_event(0x12, 0, 2, 0)          # Alt up
            user.SetForegroundWindow(hwnd)
            time.sleep(0.15)
            if user.GetForegroundWindow() == hwnd:
                break
    finally:
        if attached:
            user.AttachThreadInput(cur_thread, fg_thread, False)
    focused = window_info(window_id)
    if not focused["foreground"]:
        raise ValueError("Windows denied focus. Ask the user to activate this window manually.")
    return focused

def dispatch(request):
    action = request.get("action")
    if action in {"launch", "focus", "click", "type", "key", "scroll"} and Path(__file__).with_name("STOP").exists():
        raise ValueError("Computer input is paused by the STOP file. Ask the user to remove it manually.")
    if action == "find_app":
        return find_app(request["app"])
    if action == "launch":
        app = find_app(request["app"])
        if not app["found"]:
            return {**app, "process_started": False, "window_observed": False, "page_verified": False}
        argv = launch_argv(request["app"], app["executable"], request.get("url"))
        previous = {w["window_id"] for w in list_windows()["windows"]}
        child = subprocess.Popen(argv, shell=False, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        deadline = time.monotonic() + 5
        windows = []
        while time.monotonic() < deadline:
            windows = [w for w in list_windows()["windows"] if w["window_id"] not in previous and w["process"].lower() == Path(app["executable"]).name.lower()]
            if windows:
                break
            time.sleep(0.2)
        return {**app, "process_started": True, "launcher_pid": child.pid, "window_observed": bool(windows),
                "windows": windows, "page_verified": False,
                "next_step": "Do not relaunch automatically. Inspect the new window and browser state; process start alone does not verify page load."}
    if action == "browser_state":
        info = window_info(request["window_id"])
        if info["process"].lower() not in BROWSERS:
            raise ValueError("Target is not a supported browser window.")
        state = {"url": None, "url_source": None, "address_bar_text": None, "note": "Address bar unavailable; verify a fresh screenshot."}
        powershell = Path(os.environ["SystemRoot"]) / "System32/WindowsPowerShell/v1.0/powershell.exe"
        script = Path(__file__).with_name("browser_status.ps1").read_text(encoding="utf-8")
        try:
            result = subprocess.run([str(powershell), "-NoProfile", "-NonInteractive", "-Command", "& {\n" + script + "\n} " + str(int(info["window_id"]))],
                                    capture_output=True, encoding="utf-8", errors="replace", timeout=5, creationflags=subprocess.CREATE_NO_WINDOW)
            if result.returncode == 0:
                candidate = json.loads(result.stdout)
                if candidate.get("url") is not None:
                    validate_url(candidate["url"])
                state = candidate
        except (subprocess.TimeoutExpired, ValueError, OSError):
            pass
        latest = window_info(info["window_id"])
        if latest["pid"] != info["pid"] or latest["title"] != info["title"]:
            state = {"url": None, "url_source": None, "address_bar_text": None, "note": "Browser changed during observation. Read state again."}
        return {**latest, **state, "page_verified": False}
    if action == "windows":
        return list_windows()
    if action == "focus":
        return focus_window(request["window_id"])
    if action == "observe":
        from PIL import ImageGrab
        info = ensure_target(request)
        rect = info["rect"]
        width, height = rect["right"]-rect["left"], rect["bottom"]-rect["top"]
        if width < 1 or height < 1 or width * height > 40_000_000:
            raise ValueError("Unsupported window size.")
        screen = (user.GetSystemMetrics(76), user.GetSystemMetrics(77))
        if rect["left"] < screen[0] or rect["top"] < screen[1] or rect["right"] > screen[0]+user.GetSystemMetrics(78) or rect["bottom"] > screen[1]+user.GetSystemMetrics(79):
            raise ValueError("Window is partially outside the desktop. Move it fully on screen first.")
        image = ImageGrab.grab(bbox=(rect["left"], rect["top"], rect["right"], rect["bottom"]), all_screens=True)
        ensure_target({"window_id": info["window_id"], "expected_rect": rect})
        image.thumbnail((1600, 1200))
        output = io.BytesIO()
        image.save(output, format="PNG")
        return {**info, "image_width": image.width, "image_height": image.height, "png_base64": base64.b64encode(output.getvalue()).decode("ascii")}
    if action == "screen_observe":
        from PIL import ImageGrab
        left, top, right, bottom = screen_bounds()
        if right - left < 1 or bottom - top < 1 or (right - left) * (bottom - top) > 40_000_000:
            raise ValueError("Unsupported screen size.")
        image = ImageGrab.grab(bbox=(left, top, right, bottom), all_screens=True)
        image.thumbnail((1600, 1200))
        output = io.BytesIO()
        image.save(output, format="PNG")
        return {"source": "screen", "width": image.width, "height": image.height,
                "screen_left": left, "screen_top": top, "screen_right": right, "screen_bottom": bottom,
                "coordinates": "image pixels, origin at top-left of the whole screen; map to absolute screen_x/screen_y for raw_click",
                "png_base64": base64.b64encode(output.getvalue()).decode("ascii")}
    if action == "raw_click":
        if Path(__file__).with_name("STOP").exists():
            raise ValueError("Computer input is paused by the STOP file. Ask the user to remove it manually.")
        x, y = request["screen_x"], request["screen_y"]
        left, top, right, bottom = screen_bounds()
        if not (isinstance(x, int) and isinstance(y, int) and left <= x < right and top <= y < bottom):
            raise ValueError("Raw click is outside the screen bounds.")
        user.SetCursorPos(x, y)
        corner_guard(x, y)
        down, up = (0x0002, 0x0004) if request.get("button", "left") == "left" else (0x0008, 0x0010)
        count = request.get("count", 1)
        if count not in (1, 2):
            raise ValueError("Invalid click count.")
        for _ in range(count):
            send_inputs([Input(0, InputUnion(mi=MouseInput(0, 0, 0, down, 0, 0))), Input(0, InputUnion(mi=MouseInput(0, 0, 0, up, 0, 0)))])
            if count == 2:
                time.sleep(0.07)
        return {"action": action, "performed": True, "screen_x": x, "screen_y": y,
                "button": request.get("button", "left"), "count": count,
                "next_step": "Observe the screen again to see the result (menus/flyouts are transient)."}
    info = ensure_target(request, mutation=True)
    if action == "click":
        x, y = request["screen_x"], request["screen_y"]
        r = info["rect"]
        if not (isinstance(x, int) and isinstance(y, int) and r["left"] <= x < r["right"] and r["top"] <= y < r["bottom"]):
            raise ValueError("Click is outside target window.")
        user.SetCursorPos(x, y)
        ensure_target(request, mutation=True)
        down, up = (0x0002, 0x0004) if request.get("button", "left") == "left" else (0x0008, 0x0010)
        count = request.get("count", 1)
        if count not in (1, 2):
            raise ValueError("Invalid click count.")
        for _ in range(count):
            send_inputs([Input(0, InputUnion(mi=MouseInput(0, 0, 0, down, 0, 0))), Input(0, InputUnion(mi=MouseInput(0, 0, 0, up, 0, 0)))])
            if count == 2:
                time.sleep(0.07)
    elif action == "type":
        text = request["text"]
        if not isinstance(text, str) or len(text) > 2000 or any(ord(c) < 32 or ord(c) == 127 for c in text):
            raise ValueError("Type text must be at most 2000 characters without newlines, tabs or control characters. Submit keys separately.")
        encoded = text.encode("utf-16-le")
        for offset in range(0, len(encoded), 128):
            ensure_target(request, mutation=True)
            chunk = encoded[offset:offset+128]
            keys = []
            for index in range(0, len(chunk), 2):
                code = chunk[index] | (chunk[index+1] << 8)
                keys += [key_input(scan=code, flags=4), key_input(scan=code, flags=6)]
            send_inputs(keys)
    elif action == "key":
        name = request["key"]
        if name not in ALLOWED_KEYS:
            raise ValueError("Unsupported shortcut.")
        if name == "CTRL+L" and info["process"].lower() not in BROWSERS:
            raise ValueError("Ctrl+L is restricted to supported browser windows.")
        codes = [KEYS[part] for part in name.split("+")]
        send_inputs([key_input(vk=code) for code in codes] + [key_input(vk=code, flags=2) for code in reversed(codes)])
    elif action == "scroll":
        amount = request["amount"]
        if type(amount) is not int or not 1 <= abs(amount) <= 5:
            raise ValueError("Scroll must be between -5 and 5, excluding zero.")
        x, y = request.get("screen_x"), request.get("screen_y")
        r = info["rect"]
        if not (type(x) is int and type(y) is int and r["left"] <= x < r["right"] and r["top"] <= y < r["bottom"]):
            raise ValueError("Scroll coordinates are missing or outside the target window. Observe again and supply x,y inside the scrollable content.")
        if not user.SetCursorPos(x, y):
            raise ValueError("Could not move the pointer to the scroll area. Obtain a new screenshot.")
        # Allow hover routing to settle, then recheck before delivering any wheel input.
        time.sleep(0.05)
        ensure_target(request, mutation=True)
        cursor = Point()
        if not user.GetCursorPos(C.byref(cursor)) or (cursor.x, cursor.y) != (x, y):
            raise ValueError("Pointer moved before scrolling. Obtain a new screenshot.")
        hovered = user.WindowFromPoint(cursor)
        if not hovered or user.GetAncestor(hovered, 2) != int(info["window_id"]):
            raise ValueError("Scroll area is covered by another window. Obtain a new screenshot.")
        send_inputs([Input(0, InputUnion(mi=MouseInput(0, 0, (amount * 120) & 0xffffffff, 0x0800, 0, 0)))])
        return {"action": action, "window_id": info["window_id"], "performed": True,
                "screen_x": x, "screen_y": y, "amount": amount, "content_movement_verified": False,
                "next_step": "Observe again and compare the content position. If unchanged, check the scroll area or end of content; do not repeat blindly."}
    else:
        raise ValueError("Unsupported desktop action.")
    return {"action": action, "window_id": info["window_id"], "performed": True, "next_step": "Take a new screenshot before another action."}

if __name__ == "__main__":
    try:
        raw = sys.stdin.buffer.read(32769)
        if len(raw) > 32768:
            raise ValueError("Request too large.")
        result = dispatch(json.loads(raw.decode("utf-8")))
        sys.stdout.write(json.dumps({"ok": True, "result": result}, ensure_ascii=True))
    except Exception as error:
        message = str(error) if isinstance(error, (ValueError, KeyError)) else "Desktop operation failed (" + type(error).__name__ + ")."
        sys.stdout.write(json.dumps({"ok": False, "error": message}, ensure_ascii=True))
        sys.exit(1)
