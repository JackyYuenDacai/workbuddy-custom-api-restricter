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
            with patch.object(Path, "exists", return_value=False), patch.object(backend, "ensure_target", return_value={"window_id": "1", "process": process}), patch.object(backend, "ensure_keyboard_target"), patch.object(backend, "send_inputs") as send:
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
        self.user.SetPhysicalCursorPos.return_value = True
        self.user.WindowFromPoint.return_value = 456
        self.user.GetAncestor.return_value = 123
        self.user.GetPhysicalCursorPos.side_effect = self.cursor_at_target
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
                self.user.SetPhysicalCursorPos.assert_called_with(-600, 200)
                item = self.send.call_args.args[0][0]
                self.assertEqual(item.value.mi.dwFlags, 0x0800)
                self.assertEqual(item.value.mi.mouseData, (amount * 120) & 0xffffffff)
                self.assertFalse(result["content_movement_verified"])

    def test_invalid_arguments_never_move_or_scroll(self):
        for changes in [{"screen_x": None}, {"screen_x": -801}, {"screen_x": 800}, {"screen_y": 1300},
                        {"screen_y": True}, {"amount": True}, {"amount": 0}, {"amount": 6}]:
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                backend.dispatch({**self.request, **changes})
        self.user.SetPhysicalCursorPos.assert_not_called()
        self.send.assert_not_called()

    def test_pointer_move_failure_never_sends_wheel(self):
        self.user.SetPhysicalCursorPos.return_value = False
        with self.assertRaisesRegex(ValueError, "Could not move"):
            backend.dispatch(self.request)
        self.send.assert_not_called()

    def test_failed_pointer_read_is_not_reported_as_movement(self):
        self.user.GetPhysicalCursorPos.side_effect = None
        self.user.GetPhysicalCursorPos.return_value = False
        with self.assertRaisesRegex(ValueError, "Cannot read"):
            backend.dispatch(self.request)
        self.send.assert_not_called()

    def test_small_jitter_on_same_control_still_scrolls(self):
        def jitter(pointer):
            pointer._obj.x, pointer._obj.y = -599, 201
            return True
        self.user.GetPhysicalCursorPos.side_effect = jitter
        result = backend.dispatch(self.request)
        self.assertTrue(result["pointer_moved_by_tool"])
        self.assertEqual(result["actual_screen_x"], -599)
        self.send.assert_called_once()

    def test_small_jitter_onto_another_control_does_not_scroll(self):
        self.user.WindowFromPoint.side_effect = [456, 457]
        with self.assertRaisesRegex(ValueError, "different control"):
            backend.dispatch(self.request)
        self.send.assert_not_called()

    def test_pointer_change_after_tool_move_does_not_scroll(self):
        def moved_after_wait(_):
            def moved(pointer):
                pointer._obj.x, pointer._obj.y = -570, 200
                return True
            self.user.GetPhysicalCursorPos.side_effect = moved
        backend.time.sleep.side_effect = moved_after_wait
        with self.assertRaisesRegex(ValueError, "Pointer changed"):
            backend.dispatch(self.request)
        self.send.assert_not_called()

    def test_constrained_pointer_is_not_reported_as_user_movement(self):
        def constrained(pointer):
            pointer._obj.x, pointer._obj.y = -300, 200
            return True
        self.user.GetPhysicalCursorPos.side_effect = constrained
        with self.assertRaisesRegex(ValueError, "did not reach"):
            backend.dispatch(self.request)
        self.send.assert_not_called()

    def test_stop_created_during_preparation_prevents_scroll(self):
        with patch.object(Path, "exists", side_effect=[False, False, True]):
            with self.assertRaisesRegex(ValueError, "paused"):
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
        self.user.SetPhysicalCursorPos.assert_not_called()
        self.send.assert_not_called()


class ScreenClickTests(unittest.TestCase):
    def setUp(self):
        self.user = MagicMock()
        self.user.SetPhysicalCursorPos.return_value = True
        self.user.WindowFromPoint.return_value = 456
        self.user.GetAncestor.return_value = 789
        self.positions = [(-100, 50), (-1680, 40), (-1680, 40)]

        def cursor(point):
            x, y = self.positions.pop(0)
            point._obj.x, point._obj.y = x, y
            return True

        self.user.GetPhysicalCursorPos.side_effect = cursor
        self.request = {"action": "screen_click", "expected_screen": {"left": -1920, "top": -200, "right": 1920, "bottom": 1080},
                        "screen_x": -1680, "screen_y": 40, "button": "left", "count": 1}

    def test_negative_monitor_click_is_checked_and_sent_once(self):
        target = {"process": "explorer.exe", "title": "", "window_id": "789"}
        with patch.object(Path, "exists", return_value=False), patch.object(backend, "screen_bounds", return_value=(-1920, -200, 1920, 1080)), \
                patch.object(backend, "user", self.user), patch.object(backend, "window_info", return_value=target), \
                patch.object(backend, "send_inputs") as send, patch.object(backend.time, "sleep"):
            result = backend.dispatch(self.request)
        self.user.SetPhysicalCursorPos.assert_called_once_with(-1680, 40)
        send.assert_called_once()
        self.assertTrue(result["performed"])

    def test_changed_desktop_bounds_reject_before_pointer_movement(self):
        with patch.object(Path, "exists", return_value=False), patch.object(backend, "screen_bounds", return_value=(0, 0, 1920, 1080)), \
                patch.object(backend, "user", self.user), patch.object(backend, "send_inputs") as send:
            with self.assertRaisesRegex(ValueError, "bounds changed"):
                backend.dispatch(self.request)
        self.user.SetPhysicalCursorPos.assert_not_called()
        send.assert_not_called()

    def test_terminal_target_is_rejected_without_click(self):
        target = {"process": "windowsterminal.exe", "title": "Terminal", "window_id": "789"}
        with patch.object(Path, "exists", return_value=False), patch.object(backend, "screen_bounds", return_value=(-1920, -200, 1920, 1080)), \
                patch.object(backend, "user", self.user), patch.object(backend, "window_info", return_value=target), \
                patch.object(backend, "send_inputs") as send, patch.object(backend.time, "sleep"):
            with self.assertRaisesRegex(ValueError, "Terminal"):
                backend.dispatch(self.request)
        send.assert_not_called()


class TrayTests(unittest.TestCase):
    def setUp(self):
        self.taskbar = {"window_id": "100", "pid": 10, "process": "explorer.exe"}
        self.overflow = {"window_id": "200", "pid": 10, "process": "explorer.exe"}
        self.user = MagicMock()
        for patcher in [patch.object(Path, "exists", return_value=False),
                        patch.object(backend, "user", self.user), patch.object(backend.time, "sleep")]:
            patcher.start()
            self.addCleanup(patcher.stop)
        self.guard = self.mock("input_guard")
        self.shell = self.mock("shell_window", return_value=self.taskbar)
        self.popup = self.mock("tray_overflow", side_effect=[None, self.overflow])
        self.focus_query = backend.tray_chevron_focused
        self.focused = self.mock("tray_chevron_focused", return_value=True)
        self.ensure = self.mock("ensure_target", return_value=self.taskbar)
        self.send = self.mock("send_inputs")

    def mock(self, name, **kwargs):
        patcher = patch.object(backend, name, **kwargs)
        value = patcher.start()
        self.addCleanup(patcher.stop)
        return value

    def test_opens_verified_chevron_without_mouse_movement(self):
        result = backend.dispatch({"action": "open_tray"})
        self.assertTrue(result["opened"])
        self.assertFalse(result["pointer_moved_by_tool"])
        self.assertEqual(result["window_id"], "200")
        codes = [[item.value.ki.wVk for item in call.args[0]] for call in self.send.call_args_list]
        self.assertEqual(codes, [[0x5B, 0x42, 0x42, 0x5B], [13, 13]])
        self.ensure.assert_called_once_with({"window_id": "100", "expected_pid": 10}, mutation=True)
        self.user.SetPhysicalCursorPos.assert_not_called()

    def test_already_open_tray_is_not_toggled_closed(self):
        self.popup.side_effect = None
        self.popup.return_value = self.overflow
        result = backend.dispatch({"action": "open_tray"})
        self.assertTrue(result["opened"])
        self.assertTrue(result["already_open"])
        self.send.assert_not_called()

    def test_unknown_focused_icon_never_receives_enter(self):
        self.focused.return_value = False
        result = backend.dispatch({"action": "open_tray"})
        self.assertFalse(result["opened"])
        self.send.assert_called_once()
        self.assertIn("desktop_screen_observe", result["next_step"])

    def test_missing_taskbar_sends_no_input(self):
        self.shell.return_value = None
        result = backend.dispatch({"action": "open_tray"})
        self.assertFalse(result["performed"])
        self.send.assert_not_called()

    def test_focus_switch_before_enter_does_not_type_into_another_app(self):
        self.ensure.side_effect = ValueError("Target is not the visible foreground window")
        with self.assertRaisesRegex(ValueError, "foreground"):
            backend.dispatch({"action": "open_tray"})
        self.send.assert_called_once()

    def test_stop_and_corner_pause_prevent_shortcut(self):
        with patch.object(Path, "exists", return_value=True):
            with self.assertRaisesRegex(ValueError, "paused"):
                backend.dispatch({"action": "open_tray"})
        self.guard.side_effect = ValueError("Emergency stop")
        with self.assertRaisesRegex(ValueError, "Emergency stop"):
            backend.dispatch({"action": "open_tray"})
        self.send.assert_not_called()

    def test_input_delivery_does_not_prove_tray_opened(self):
        self.popup.side_effect = None
        self.popup.return_value = None
        result = backend.dispatch({"action": "open_tray"})
        self.assertTrue(result["performed"])
        self.assertFalse(result["opened"])
        self.assertEqual(self.send.call_count, 2)

    def test_uia_timeout_is_unknown_not_permission_to_press_enter(self):
        # Exercise the real helper instead of the open_tray fixture's mock.
        with patch.object(backend.subprocess, "run", side_effect=subprocess.TimeoutExpired("powershell", 3)):
            self.assertFalse(self.focus_query("100"))


class WindowClickTests(unittest.TestCase):
    enter_patch = ScrollTests.enter_patch
    cursor_at_target = ScrollTests.cursor_at_target

    def setUp(self):
        ScrollTests.setUp(self)
        self.request = {"action": "click", "window_id": "123", "screen_x": -600, "screen_y": 200}

    # Only share fixture setup, not the scroll-specific test cases.
    def test_click_rejects_failed_move_and_occlusion(self):
        self.user.SetPhysicalCursorPos.return_value = False
        with self.assertRaisesRegex(ValueError, "Could not move"):
            backend.dispatch(self.request)
        self.user.SetPhysicalCursorPos.return_value = True
        self.user.GetAncestor.return_value = 789
        with self.assertRaisesRegex(ValueError, "covered"):
            backend.dispatch(self.request)
        self.send.assert_not_called()

    def test_invalid_click_options_never_move_pointer(self):
        for options in [{"button": "middle"}, {"count": True}, {"count": 0}, {"count": 3}]:
            with self.subTest(options=options), self.assertRaises(ValueError):
                backend.dispatch({**self.request, **options})
        self.user.SetPhysicalCursorPos.assert_not_called()
        self.send.assert_not_called()

    def test_double_click_is_one_input_batch(self):
        result = backend.dispatch({**self.request, "button": "right", "count": 2})
        self.assertTrue(result["pointer_moved_by_tool"])
        self.send.assert_called_once()
        self.assertEqual([item.value.mi.dwFlags for item in self.send.call_args.args[0]], [8, 16, 8, 16])


class FocusTests(unittest.TestCase):
    def test_visible_owned_popup_is_activated_instead_of_blocked_parent(self):
        requested = {"window_id": "100", "minimized": False, "foreground": False}
        popup = {"window_id": "200", "minimized": False, "foreground": False}
        focused = {"window_id": "200", "minimized": False, "foreground": True}
        win32 = MagicMock()
        win32.GetLastActivePopup.return_value = 200
        win32.IsWindowVisible.return_value = True
        win32.GetForegroundWindow.side_effect = [300, 200]
        win32.GetWindowThreadProcessId.return_value = 7
        thread = MagicMock()
        thread.GetCurrentThreadId.return_value = 8
        with patch.object(backend, "user", win32), patch.object(backend, "kernel", thread), \
                patch.object(backend, "window_info", side_effect=[requested, popup, focused]), patch.object(backend.time, "sleep"):
            result = backend.focus_window("100")
        self.assertTrue(result["focused"])
        self.assertTrue(result["popup_redirected"])
        self.assertEqual(result["requested_window_id"], "100")
        self.assertEqual(result["activated_window_id"], "200")
        win32.SetForegroundWindow.assert_called_with(200)

    def test_focus_denial_returns_recovery_evidence(self):
        requested = {"window_id": "100", "minimized": True, "foreground": False}
        still_unfocused = {"window_id": "100", "minimized": False, "foreground": False}
        win32 = MagicMock()
        win32.GetLastActivePopup.return_value = 100
        win32.GetForegroundWindow.return_value = 300
        win32.GetWindowThreadProcessId.return_value = 7
        thread = MagicMock()
        thread.GetCurrentThreadId.return_value = 8
        with patch.object(backend, "user", win32), patch.object(backend, "kernel", thread), \
                patch.object(backend, "window_info", side_effect=[requested, still_unfocused]), patch.object(backend.time, "sleep"):
            result = backend.focus_window("100")
        self.assertTrue(result["restored"])
        self.assertFalse(result["focused"])
        self.assertIn("whole desktop", result["next_step"])


if __name__ == "__main__":
    unittest.main()
