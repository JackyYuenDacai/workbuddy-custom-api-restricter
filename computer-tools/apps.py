"""Bounded installed-app discovery and argv construction; never a shell launcher."""
import os
from pathlib import Path
import shutil
from urllib.parse import urlsplit

APPS = {
    "firefox": ("firefox.exe", "Mozilla Firefox/firefox.exe"),
    "chrome": ("chrome.exe", "Google/Chrome/Application/chrome.exe"),
    "edge": ("msedge.exe", "Microsoft/Edge/Application/msedge.exe"),
    "notepad": ("notepad.exe", None),
}
BROWSERS = {"firefox.exe", "chrome.exe", "msedge.exe"}


def app_spec(app):
    if app not in APPS:
        raise ValueError("Unsupported app. Choose firefox, chrome, edge or notepad.")
    return APPS[app]


def validate_url(url):
    if not isinstance(url, str) or not url or len(url) > 2000 or any(ord(c) <= 32 or ord(c) == 127 for c in url) or "\\" in url:
        raise ValueError("URL must be an HTTP(S) URL without whitespace or control characters (max 2000 characters).")
    try:
        parsed = urlsplit(url)
        if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username is not None or parsed.password is not None:
            raise ValueError()
        parsed.port
    except ValueError:
        raise ValueError("Only HTTP(S) URLs without embedded credentials are supported.") from None
    return url


def find_app(app):
    import winreg
    executable, relative = app_spec(app)
    candidates, checked = [], []
    for hive_name, hive in (("HKCU", winreg.HKEY_CURRENT_USER), ("HKLM", winreg.HKEY_LOCAL_MACHINE)):
        for label, view in (("64", winreg.KEY_WOW64_64KEY), ("32", winreg.KEY_WOW64_32KEY)):
            source = f"{hive_name} App Paths ({label}-bit)"
            checked.append(source)
            try:
                with winreg.OpenKey(hive, rf"Software\Microsoft\Windows\CurrentVersion\App Paths\{executable}", 0, winreg.KEY_READ | view) as key:
                    value, kind = winreg.QueryValueEx(key, None)
                    if kind in (winreg.REG_SZ, winreg.REG_EXPAND_SZ) and isinstance(value, str):
                        candidates.append((os.path.expandvars(value.strip().strip('"')), source))
            except OSError:
                pass
    if relative:
        for variable in ("ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"):
            checked.append(variable)
            if os.environ.get(variable):
                candidates.append((os.path.join(os.environ[variable], relative), variable))
    else:
        checked.append("Windows System32")
        if os.environ.get("SystemRoot"):
            candidates.append((os.path.join(os.environ["SystemRoot"], "System32", executable), "Windows System32"))
    checked.append("PATH")
    on_path = shutil.which(executable)
    if on_path:
        candidates.append((on_path, "PATH"))
    for candidate, source in candidates:
        path = Path(candidate)
        if path.is_absolute() and not str(path).startswith("\\\\") and path.is_file() and path.name.lower() == executable:
            return {"app": app, "found": True, "executable": str(path), "source": source, "on_path": bool(on_path), "checked": checked}
    return {"app": app, "found": False, "executable": None, "on_path": bool(on_path), "checked": checked,
            "note": "Not found in checked locations; this does not prove the app is uninstalled. No installation attempted."}


def launch_argv(app, executable, url=None):
    name, _ = app_spec(app)
    if not Path(executable).is_absolute() or Path(executable).name.lower() != name or str(executable).startswith("\\\\"):
        raise ValueError("Invalid application executable.")
    if app == "notepad":
        if url is not None:
            raise ValueError("Notepad does not accept a URL.")
        return [executable]
    target = validate_url(url) if url is not None else "about:blank"
    return [executable, "-new-window" if app == "firefox" else "--new-window", target]
