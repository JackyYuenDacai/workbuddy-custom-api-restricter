"""No real GUI input/launch in these tests. Run with Windows Python."""
import subprocess
import unittest
from pathlib import Path
from unittest.mock import patch, MagicMock
import apps
import windows_backend as backend


class AppTests(unittest.TestCase):
    def test_url_validation(self):
        for url in ("javascript:alert(1)", "file:///C:/test", "data:text/plain,hello", "--help", "https://user:secret@example.com", "https://example.com/\n", "https://example.com/ a", "https://example.com:bad", "https:///", "https://example.com\\test"):
            with self.subTest(url=url), self.assertRaises(ValueError):
                apps.validate_url(url)
        self.assertEqual(apps.validate_url("https://www.google.com/search?q=Astra%20AI"), "https://www.google.com/search?q=Astra%20AI")

    def test_fixed_browser_args_and_no_shell_app(self):
        exe = "C:/Program Files/Mozilla Firefox/firefox.exe"
        self.assertEqual(apps.launch_argv("firefox", exe, "https://www.google.com/search?q=Astra"), [exe, "-new-window", "https://www.google.com/search?q=Astra"])
        self.assertEqual(apps.launch_argv("firefox", exe)[-1], "about:blank")
        for app, path, url in (("powershell", "C:/Windows/powershell.exe", None), ("firefox", "firefox.exe", None), ("firefox", "C:/cmd.exe", None), ("notepad", "C:/Windows/notepad.exe", "https://example.com")):
            with self.subTest(app=app, path=path), self.assertRaises(ValueError):
                apps.launch_argv(app, path, url)

    def test_registry_discovery_without_path(self):
        import winreg
        with patch.object(winreg, "OpenKey", return_value=MagicMock()), patch.object(winreg, "QueryValueEx", return_value=('"C:/Program Files/Mozilla Firefox/firefox.exe"', winreg.REG_SZ)), patch.object(apps.shutil, "which", return_value=None), patch.object(Path, "is_file", return_value=True):
            found = apps.find_app("firefox")
        self.assertTrue(found["found"])
        self.assertFalse(found["on_path"])
        self.assertIn("App Paths", found["source"])

    def test_missing_discovery_is_not_installation_claim(self):
        import winreg
        with patch.object(winreg, "OpenKey", side_effect=FileNotFoundError), patch.object(apps.shutil, "which", return_value=None), patch.object(Path, "is_file", return_value=False):
            found = apps.find_app("firefox")
        self.assertFalse(found["found"])
        self.assertIn("does not prove", found["note"])

    def test_launch_only_reports_new_matching_windows(self):
        existing = {"window_id": "1", "process": "firefox.exe"}
        new = {"window_id": "2", "process": "firefox.exe"}
        app = {"found": True, "executable": "C:/Apps/firefox.exe"}
        with patch.object(Path, "exists", return_value=False), patch.object(backend, "find_app", return_value=app), patch.object(backend, "list_windows", side_effect=[{"windows": [existing]}, {"windows": [existing, new]}]), patch.object(backend.subprocess, "Popen") as launch:
            result = backend.dispatch({"action": "launch", "app": "firefox"})
        self.assertEqual(result["windows"], [new])
        self.assertFalse(result["page_verified"])
        self.assertFalse(launch.call_args.kwargs["shell"])

    def test_backend_stop_blocks_launch(self):
        with patch.object(Path, "exists", return_value=True), patch.object(backend.subprocess, "Popen") as launch:
            with self.assertRaisesRegex(ValueError, "paused"):
                backend.dispatch({"action": "launch", "app": "firefox"})
            launch.assert_not_called()

    def test_ctrl_l_only_in_browser_and_no_input_on_rejection(self):
        for process in ("notepad.exe", "firefox.exe"):
            with patch.object(Path, "exists", return_value=False), patch.object(backend, "ensure_target", return_value={"window_id": "1", "process": process}), patch.object(backend, "send_inputs") as send:
                if process == "notepad.exe":
                    with self.assertRaisesRegex(ValueError, "restricted"):
                        backend.dispatch({"action": "key", "key": "CTRL+L"})
                    send.assert_not_called()
                else:
                    backend.dispatch({"action": "key", "key": "CTRL+L"})
                    send.assert_called_once()

    def test_browser_state_null_when_uia_times_out(self):
        with patch.object(backend, "window_info", return_value={"process": "firefox.exe", "window_id": "1", "pid": 22, "title": "Test"}), patch.object(backend.subprocess, "run", side_effect=subprocess.TimeoutExpired("powershell", 5)):
            result = backend.dispatch({"action": "browser_state", "window_id": "1"})
        self.assertIsNone(result["url"])
        self.assertFalse(result["page_verified"])


class ScrollTests(unittest.TestCase):
    def setUp(self):
        self.info = {"window_id": "123", "rect": {"left": -800, "top": 100, "right": 800, "bottom": 1300}}
        self.request = {"action": "scroll", "window_id": "123", "screen_x": -600, "screen_y": 200, "amount": -3}
        self.user = MagicMock()
        self.user.SetCursorPos.return_value = True
        self.user.WindowFromPoint.return_value = 456
        self.user.GetAncestor.return_value = 123
        self.user.GetCursorPos.side_effect = self.cursor_at_target
        for target, kwargs in [(backend, {"user": self.user})]:
            patcher = patch.multiple(target, **kwargs)
            patcher.start()
            self.addCleanup(patcher.stop)
        for patcher in [patch.object(Path, "exists", return_value=False), patch.object(backend.time, "sleep")]:
            patcher.start()
            self.addCleanup(patcher.stop)
        self.ensure = self.enter_patch(patch.object(backend, "ensure_target", return_value=self.info))
        self.send = self.enter_patch(patch.object(backend, "send_inputs"))

    def enter_patch(self, patcher):
        value = patcher.start()
        self.addCleanup(patcher.stop)
        return value

    def cursor_at_target(self, pointer):
        pointer._obj.x, pointer._obj.y = -600, 200
        return True

    def test_targets_pane_without_clicking_and_preserves_wheel_direction(self):
        for amount in [-5, -1, 1, 5]:
            with self.subTest(amount=amount):
                result = backend.dispatch({**self.request, "amount": amount})
                self.user.SetCursorPos.assert_called_with(-600, 200)
                item = self.send.call_args.args[0][0]
                self.assertEqual(item.value.mi.dwFlags, 0x0800)
                self.assertEqual(item.value.mi.mouseData, (amount * 120) & 0xffffffff)
                self.assertFalse(result["content_movement_verified"])

    def test_invalid_arguments_never_move_or_scroll(self):
        for changes in [{"screen_x": None}, {"screen_x": -801}, {"screen_x": 800}, {"screen_y": 1300},
                        {"screen_y": True}, {"amount": True}, {"amount": 0}, {"amount": 6}]:
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                backend.dispatch({**self.request, **changes})
        self.user.SetCursorPos.assert_not_called()
        self.send.assert_not_called()

    def test_pointer_move_failure_never_sends_wheel(self):
        self.user.SetCursorPos.return_value = False
        with self.assertRaisesRegex(ValueError, "Could not move"):
            backend.dispatch(self.request)
        self.send.assert_not_called()

    def test_user_pointer_movement_never_sends_wheel(self):
        self.user.GetCursorPos.side_effect = None
        with self.assertRaisesRegex(ValueError, "Pointer moved"):
            backend.dispatch(self.request)
        self.send.assert_not_called()

    def test_overlay_never_receives_wheel(self):
        self.user.GetAncestor.return_value = 789
        with self.assertRaisesRegex(ValueError, "covered"):
            backend.dispatch(self.request)
        self.send.assert_not_called()

    def test_foreground_changed_after_pointer_move_never_receives_wheel(self):
        self.ensure.side_effect = [self.info, ValueError("Target is not the visible foreground window")]
        with self.assertRaisesRegex(ValueError, "foreground"):
            backend.dispatch(self.request)
        self.send.assert_not_called()

    def test_emergency_stop_checked_before_moving_pointer(self):
        self.ensure.side_effect = ValueError("Emergency stop")
        with self.assertRaisesRegex(ValueError, "Emergency stop"):
            backend.dispatch(self.request)
        self.user.SetCursorPos.assert_not_called()
        self.send.assert_not_called()


if __name__ == "__main__":
    unittest.main()
