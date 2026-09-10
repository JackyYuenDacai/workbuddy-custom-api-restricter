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
from keyboard import parse_request

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
user.IsWindowEnabled.argtypes = [W.HWND]
user.GetLastActivePopup.argtypes = [W.HWND]
user.GetLastActivePopup.restype = W.HWND
user.GetWindowTextW.argtypes = [W.HWND, W.LPWSTR, C.c_int]
user.GetWindowThreadProcessId.argtypes = [W.HWND, C.POINTER(W.DWORD)]
user.GetWindow.argtypes = [W.HWND, W.UINT]
user.GetWindow.restype = W.HWND
user.SetForegroundWindow.argtypes = [W.HWND]
user.ShowWindow.argtypes = [W.HWND, C.c_int]
user.ShowWindowAsync.argtypes = [W.HWND, C.c_int]
user.BringWindowToTop.argtypes = [W.HWND]
user.GetCursorPos.argtypes = [C.POINTER(Point)]
user.SetCursorPos.argtypes = [C.c_int, C.c_int]
user.SetCursorPos.restype = W.BOOL
user.GetPhysicalCursorPos.argtypes = [C.POINTER(Point)]
user.GetPhysicalCursorPos.restype = W.BOOL
user.SetPhysicalCursorPos.argtypes = [C.c_int, C.c_int]
user.SetPhysicalCursorPos.restype = W.BOOL
user.FindWindowW.argtypes = [W.LPCWSTR, W.LPCWSTR]
user.FindWindowW.restype = W.HWND
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
    owner = user.GetWindow(hwnd, 4)  # GW_OWNER; useful for modal/popup recovery.
    return {"window_id": str(hwnd), "title": title.value, "process": process_name, "pid": pid.value,
            "owner_window_id": str(owner) if owner else None, "enabled": bool(user.IsWindowEnabled(hwnd)),
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
    for z_order, info in enumerate(windows):
        info["z_order"] = z_order
    return {"windows": windows}

def screen_bounds():
    left, top = user.GetSystemMetrics(76), user.GetSystemMetrics(77)
    return (left, top, left + user.GetSystemMetrics(78), top + user.GetSystemMetrics(79))

def corner_guard(x, y):
    left, top, right, bottom = screen_bounds()
    if (x, y) in {(left, top), (right - 1, top), (left, bottom - 1), (right - 1, bottom - 1), (0, 0)}:
        raise ValueError("Emergency stop: pointer is in a screen corner. Move it away manually to resume.")

def read_pointer():
    point = Point()
    if not user.GetPhysicalCursorPos(C.byref(point)):
        raise ValueError("Cannot read the physical pointer position. No input sent; check the interactive desktop session.")
    return point


def input_guard():
    if Path(__file__).with_name("STOP").exists():
        raise ValueError("Computer input is paused by the STOP file. Ask the user to remove it manually.")
    point = read_pointer()
    corner_guard(point.x, point.y)
    return point


def move_pointer(x, y):
    input_guard()
    corner_guard(x, y)
    if not user.SetPhysicalCursorPos(x, y):
        raise ValueError("Could not move the pointer to the target. No click or scroll sent; obtain a new screenshot.")
    point = read_pointer()
    # Physical coordinates avoid DPI virtualization. Small device jitter is only
    # accepted if the actual point still hits the same native control (below).
    if max(abs(point.x - x), abs(point.y - y)) > 2:
        raise ValueError(f"Pointer did not reach the target (requested {x},{y}; actual {point.x},{point.y}). "
                         "No click or scroll sent; the pointer may be constrained by the app or desktop. Observe again.")
    return point


def pointer_target(x, y, settled):
    point = input_guard()
    if max(abs(point.x - x), abs(point.y - y), abs(point.x - settled.x), abs(point.y - settled.y)) > 2:
        raise ValueError(f"Pointer changed during input preparation (target {x},{y}; actual {point.x},{point.y}). "
                         "No click or scroll sent. Observe again; this alone does not identify who moved it.")
    hovered = user.WindowFromPoint(point)
    intended = user.WindowFromPoint(Point(x, y))
    if not hovered or hovered != intended:
        raise ValueError("Pointer is over a different control. No click or scroll sent; observe again.")
    return point, user.GetAncestor(hovered, 2)


def click_options(request):
    button, count = request.get("button", "left"), request.get("count", 1)
    if button not in ("left", "right") or type(count) is not int or count not in (1, 2):
        raise ValueError("Invalid click button or count.")
    return button, count


def click_inputs(button, count):
    down, up = (0x0002, 0x0004) if button == "left" else (0x0008, 0x0010)
    # One SendInput batch keeps a double-click from racing a second pointer move.
    send_inputs([Input(0, InputUnion(mi=MouseInput(0, 0, 0, flag, 0, 0)))
                 for _ in range(count) for flag in (down, up)])


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
        input_guard()
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

def focused_control(window_id):
    powershell = Path(os.environ['SystemRoot']) / 'System32/WindowsPowerShell/v1.0/powershell.exe'
    script = Path(__file__).with_name('focus_state.ps1').read_text(encoding='utf-8')
    try:
        result = subprocess.run([str(powershell), '-NoProfile', '-NonInteractive', '-Command',
                                 '& {\n' + script + '\n} ' + str(int(window_id))],
                                capture_output=True, encoding='utf-8', errors='replace', timeout=3,
                                creationflags=subprocess.CREATE_NO_WINDOW)
        if result.returncode == 0:
            state = json.loads(result.stdout)
            if state.get('available') is True and state.get('runtime_id'):
                return state
    except (subprocess.TimeoutExpired, ValueError, OSError):
        pass
    return {'available': False, 'note': 'Focused control unavailable through UI Automation.'}

def ensure_keyboard_target(request, info, check_snapshot_focus=True):
    current = focused_control(info['window_id'])
    expected = request.get('expected_focus') or {}
    if current.get('available'):
        if not current.get('within_target') or not current.get('keyboard_focus'):
            raise ValueError('Keyboard focus is outside the target. Observe again.')
        if current.get('is_password') or current.get('terminal'):
            raise ValueError('Password, terminal or developer-console control is focused. No keyboard input sent.')
    if check_snapshot_focus and expected.get('available'):
        if not current.get('available') or any(current.get(k) != expected.get(k) for k in ('runtime_id', 'process_id', 'control_type')):
            raise ValueError('Focused control changed since the screenshot. Observe again before typing or pressing keys.')
    elif (not current.get('available') or (check_snapshot_focus and not expected.get('available'))) and info.get('process', '').lower() in {'code.exe', 'code - insiders.exe', 'vscodium.exe'}:
        raise ValueError('Editor keyboard target was not identified in the screenshot. Observe again; do not guess between chat and terminal.')
    # UI Automation may take time. Check the foreground again immediately before input.
    ensure_target(request, mutation=True)

def focus_window(window_id):
    """Activate a window from a non-foreground helper process.

    A fresh `windowsHide` child process is not the foreground process and has
    no pending user input, so a bare SetForegroundWindow is denied by Windows.
    Use the standard activation recipe (restore, AttachThreadInput to the
    foreground thread, and a synthetic Alt press) to legitimately gain the
    right to set the foreground window. This does not bypass UAC or elevation.
    """
    requested_hwnd = int(window_id)
    info = window_info(window_id)
    popup_hwnd = user.GetLastActivePopup(requested_hwnd)
    hwnd = popup_hwnd if popup_hwnd and popup_hwnd != requested_hwnd and user.IsWindowVisible(popup_hwnd) else requested_hwnd
    target_info = window_info(str(hwnd)) if hwnd != requested_hwnd else info
    was_minimized = target_info["minimized"]
    user.ShowWindowAsync(hwnd, 9 if was_minimized else 5)  # SW_RESTORE / SW_SHOW
    raised = bool(user.BringWindowToTop(hwnd))
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
    focused = window_info(str(hwnd))
    return {**focused, "was_minimized": was_minimized, "restored": not focused["minimized"],
            "raised": raised, "focused": focused["foreground"],
            "requested_window_id": str(requested_hwnd), "activated_window_id": str(hwnd),
            "popup_redirected": hwnd != requested_hwnd,
            "next_step": ("Observe this window before input." if focused["foreground"] else
                          "The window was restored/raised but Windows denied keyboard focus. Observe the whole desktop and click the visible window, or ask the user to activate it manually.")}

def shell_window(class_name):
    hwnd = user.FindWindowW(class_name, None)
    if not hwnd or not user.IsWindowVisible(hwnd):
        return None
    try:
        info = window_info(hwnd)
        return info if info["process"].lower() == "explorer.exe" else None
    except ValueError:
        return None


def tray_overflow():
    return shell_window("TopLevelWindowForOverflowXamlIsland") or shell_window("NotifyIconOverflowWindow")


def tray_chevron_focused(window_id):
    powershell = Path(os.environ["SystemRoot"]) / "System32/WindowsPowerShell/v1.0/powershell.exe"
    script = Path(__file__).with_name("tray_focus.ps1").read_text(encoding="utf-8")
    try:
        result = subprocess.run([str(powershell), "-NoProfile", "-NonInteractive", "-Command",
                                 "& {\n" + script + "\n} " + str(int(window_id))],
                                capture_output=True, encoding="utf-8", errors="replace", timeout=3,
                                creationflags=subprocess.CREATE_NO_WINDOW)
        return result.returncode == 0 and json.loads(result.stdout).get("chevron_focused") is True
    except (subprocess.TimeoutExpired, ValueError, OSError):
        return False


def open_tray():
    input_guard()
    overflow = tray_overflow()
    if overflow:
        return {"action": "open_tray", "performed": False, "already_open": True,
                "opened": True, "window_id": overflow["window_id"], "pointer_moved_by_tool": False,
                "next_step": "The hidden-icons tray is already open. Observe the screen before choosing an icon."}
    taskbar = shell_window("Shell_TrayWnd")
    if not taskbar:
        return {"action": "open_tray", "performed": False, "opened": False,
                "pointer_moved_by_tool": False,
                "next_step": "Windows Explorer taskbar unavailable. Observe the screen to locate the notification area."}
    input_guard()
    # Win+B targets the notification area even when the taskbar is auto-hidden.
    send_inputs([key_input(vk=0x5B), key_input(vk=0x42), key_input(vk=0x42, flags=2), key_input(vk=0x5B, flags=2)])
    time.sleep(0.15)
    expected = {"window_id": taskbar["window_id"], "expected_pid": taskbar["pid"]}
    if not tray_chevron_focused(taskbar["window_id"]):
        return {"action": "open_tray", "performed": True, "opened": False,
                "method": "WIN+B", "pointer_moved_by_tool": False,
                "next_step": "Notification-area shortcut sent, but the hidden-icons button was not identified. "
                             "Use desktop_screen_observe and click the visible chevron if present; do not send Enter blindly."}
    # The read-only UIA query may take time. Recheck foreground identity and
    # pauses immediately before Enter, never send it to the original app.
    ensure_target(expected, mutation=True)
    send_inputs([key_input(vk=13), key_input(vk=13, flags=2)])
    for _ in range(10):
        time.sleep(0.05)
        overflow = tray_overflow()
        if overflow:
            break
    return {"action": "open_tray", "performed": True, "opened": bool(overflow),
            "method": "WIN+B, verified chevron, ENTER", "pointer_moved_by_tool": False,
            "window_id": overflow["window_id"] if overflow else None,
            "next_step": "Observe the screen to verify the tray and choose an icon. Do not repeat the shortcut without observing."}


def dispatch(request):
    action = request.get("action")
    if action in {"launch", "focus", "open_tray", "screen_click", "click", "type", "key", "scroll"} and Path(__file__).with_name("STOP").exists():
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
    if action == "open_tray":
        return open_tray()
    if action == "cursor":
        point = read_pointer()
        foreground = user.GetForegroundWindow()
        info = window_info(str(int(foreground))) if foreground else None
        return {"screen_x": point.x, "screen_y": point.y, "coordinates": "physical screen pixels",
                "foreground_window": info,
                "note": "Diagnostic only; obtain a fresh screenshot before any input."}
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
        focus = focused_control(info['window_id'])
        image = ImageGrab.grab(bbox=(rect["left"], rect["top"], rect["right"], rect["bottom"]), all_screens=True)
        ensure_target({"window_id": info["window_id"], "expected_rect": rect, "expected_pid": info['pid']})
        image.thumbnail((1600, 1200))
        output = io.BytesIO()
        image.save(output, format="PNG")
        return {**info, "focused_control": focus, "image_width": image.width, "image_height": image.height, "png_base64": base64.b64encode(output.getvalue()).decode("ascii")}
    if action == "screen_observe":
        from PIL import ImageGrab
        left, top, right, bottom = screen_bounds()
        if right - left < 1 or bottom - top < 1 or (right - left) * (bottom - top) > 40_000_000:
            raise ValueError("Unsupported screen size.")
        image = ImageGrab.grab(bbox=(left, top, right, bottom), all_screens=True)
        image.thumbnail((1600, 1200))
        output = io.BytesIO()
        image.save(output, format="PNG")
        return {"source": "screen", "image_width": image.width, "image_height": image.height,
                "screen_left": left, "screen_top": top, "screen_right": right, "screen_bottom": bottom,
                "png_base64": base64.b64encode(output.getvalue()).decode("ascii")}
    if action == "screen_click":
        button, count = click_options(request)
        x, y = request["screen_x"], request["screen_y"]
        left, top, right, bottom = screen_bounds()
        expected = request.get("expected_screen")
        current = {"left": left, "top": top, "right": right, "bottom": bottom}
        if expected != current:
            raise ValueError("Desktop bounds changed. Obtain a new whole-desktop screenshot.")
        if not (type(x) is int and type(y) is int and left <= x < right and top <= y < bottom):
            raise ValueError("Screen click is outside the desktop bounds.")
        settled = move_pointer(x, y)
        time.sleep(0.02)
        cursor, root = pointer_target(x, y, settled)
        if root:
            target = window_info(root)
            if target["process"].lower() in BLOCKED or "devtools" in target["title"].lower() or "developer tools" in target["title"].lower():
                raise ValueError("Terminal and developer-console input is not supported. Use approved coding tools instead.")
        click_inputs(button, count)
        return {"action": action, "performed": True, "screen_x": x, "screen_y": y,
                "button": button, "count": count, "pointer_moved_by_tool": True,
                "actual_screen_x": cursor.x, "actual_screen_y": cursor.y,
                "next_step": "Observe the screen again to see the result (menus/flyouts are transient)."}
    info = ensure_target(request, mutation=True)
    if action == "click":
        button, count = click_options(request)
        x, y = request["screen_x"], request["screen_y"]
        r = info["rect"]
        if not (type(x) is int and type(y) is int and r["left"] <= x < r["right"] and r["top"] <= y < r["bottom"]):
            raise ValueError("Click is outside target window.")
        settled = move_pointer(x, y)
        ensure_target(request, mutation=True)
        cursor, root = pointer_target(x, y, settled)
        if root != int(info["window_id"]):
            raise ValueError("Click target is covered by another window. Obtain a new screenshot.")
        click_inputs(button, count)
        return {"action": action, "window_id": info["window_id"], "performed": True,
                "screen_x": x, "screen_y": y, "actual_screen_x": cursor.x, "actual_screen_y": cursor.y,
                "pointer_moved_by_tool": True, "next_step": "Take a new screenshot before another action."}
    elif action == "type":
        text = request["text"]
        if not isinstance(text, str) or len(text) > 2000 or any(ord(c) < 32 or ord(c) == 127 for c in text):
            raise ValueError("Type text must be at most 2000 characters without newlines, tabs or control characters. Submit keys separately.")
        ensure_keyboard_target(request, info)
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
        strokes = parse_request(request)  # Validate every stroke before any input.
        completed = 0
        try:
            for index, codes in enumerate(strokes):
                info = ensure_target(request, mutation=True)
                ensure_keyboard_target(request, info, check_snapshot_focus=(index == 0))
                # Balanced events in one SendInput batch per stroke. If Windows
                # accepts only part of the batch, release every possibly held key.
                releases = [key_input(vk=code, flags=2 | int(extended)) for code, extended in reversed(codes)]
                try:
                    send_inputs([key_input(vk=code, flags=int(extended)) for code, extended in codes] + releases)
                except Exception:
                    try:
                        send_inputs(releases)
                    except Exception:
                        pass
                    raise
                completed += 1
                if index + 1 < len(strokes):
                    time.sleep(0.06)
        except Exception as exc:
            raise ValueError(f'Keyboard sequence stopped after {completed} completed stroke(s); current stroke may be partial. Observe before retrying. {exc}') from exc
        return {"action": action, "window_id": info["window_id"], "performed": True,
                "completed_strokes": completed, "result_verified": False,
                "next_step": "Observe again. System shortcuts may have changed the foreground window."}
    elif action == "scroll":
        amount = request["amount"]
        if type(amount) is not int or not 1 <= abs(amount) <= 5:
            raise ValueError("Scroll must be between -5 and 5, excluding zero.")
        x, y = request.get("screen_x"), request.get("screen_y")
        r = info["rect"]
        if not (type(x) is int and type(y) is int and r["left"] <= x < r["right"] and r["top"] <= y < r["bottom"]):
            raise ValueError("Scroll coordinates are missing or outside the target window. Observe again and supply x,y inside the scrollable content.")
        settled = move_pointer(x, y)
        # Allow hover routing to settle, then recheck before delivering any wheel input.
        time.sleep(0.05)
        ensure_target(request, mutation=True)
        cursor, root = pointer_target(x, y, settled)
        if root != int(info["window_id"]):
            raise ValueError("Scroll area is covered by another window. Obtain a new screenshot.")
        send_inputs([Input(0, InputUnion(mi=MouseInput(0, 0, (amount * 120) & 0xffffffff, 0x0800, 0, 0)))])
        return {"action": action, "window_id": info["window_id"], "performed": True,
                "screen_x": x, "screen_y": y, "amount": amount, "content_movement_verified": False,
                "actual_screen_x": cursor.x, "actual_screen_y": cursor.y, "pointer_moved_by_tool": True,
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
