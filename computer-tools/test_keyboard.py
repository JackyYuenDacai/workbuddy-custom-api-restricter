"""Keyboard parsing and event-delivery checks; no real input is sent."""
import unittest
from unittest.mock import patch
from keyboard import parse_chord, parse_request, KEYS
import windows_backend as backend


class KeyboardTests(unittest.TestCase):
    def test_application_shortcuts_and_aliases(self):
        for name in ['CTRL+SHIFT+P', 'Ctrl+K', 'CTRL+ENTER', 'SHIFT+F1', 'WIN+B',
                     'CTRL+ALT+Z', 'ALT+LEFT', 'CTRL+PGDN', 'P', 'W', '2', '3',
                     'CTRL+/', 'CTRL+`', 'CTRL++', 'NUMPAD_ENTER', 'RCTRL+F24',
                     'MEDIA_PLAY_PAUSE', 'VK_0xE2']:
            self.assertTrue(parse_chord(name), name)
        self.assertEqual(parse_chord('CTRL++'), [(16, False), (17, False), (187, False)])
        self.assertEqual(parse_chord('CTRL+PLUS'), parse_chord('CTRL++'))
        self.assertEqual(parse_chord('NUMPAD_ENTER'), [(13, True)])
        self.assertEqual(parse_chord('RCTRL+LEFT'), [(163, True), (37, True)])
        for name in KEYS:
            self.assertTrue(parse_chord(name), name)

    def test_invalid_sequences_rejected_before_input(self):
        for req in [{'key': 'A+B'}, {'key': 'CTRL+BOGUS'}, {'key': 'CTRL+CTRL+A'},
                    {'key': 'CTRL+P\nENTER'}, {'key': 'VK_0x01'}, {'sequence': []},
                    {'sequence': ['A'] * 9}, {'key': 'A', 'sequence': ['B']}, {},
                    {'sequence': ['CTRL+K', 'invalid']}, {'sequence': 'CTRL+K'}]:
            with self.subTest(req=req), self.assertRaises(ValueError):
                parse_request(req)

    def dispatch(self, request):
        return backend.dispatch({'action': 'key', 'window_id': '1', **request})

    def test_balanced_events_and_sequence_progress(self):
        info = {'window_id': '1', 'process': 'code.exe'}
        with patch.object(backend.Path, 'exists', return_value=False), \
                patch.object(backend, 'ensure_target', return_value=info), \
                patch.object(backend, 'ensure_keyboard_target') as focus, \
                patch.object(backend.time, 'sleep'), patch.object(backend, 'send_inputs') as send:
            result = self.dispatch({'sequence': ['CTRL+K', 'CTRL+S']})
            self.assertEqual(result['completed_strokes'], 2)
            self.assertEqual(send.call_count, 2)
            events = send.call_args_list[0].args[0]
            self.assertEqual([(x.value.ki.wVk, x.value.ki.dwFlags) for x in events],
                             [(17, 0), (75, 0), (75, 2), (17, 2)])
            self.assertTrue(focus.call_args_list[0].kwargs['check_snapshot_focus'])
            self.assertFalse(focus.call_args_list[1].kwargs['check_snapshot_focus'])

    def test_focus_change_stops_sequence_after_first_stroke(self):
        info = {'window_id': '1', 'process': 'code.exe'}
        with patch.object(backend.Path, 'exists', return_value=False), \
                patch.object(backend, 'ensure_target', side_effect=[info, info, ValueError('focus changed')]), \
                patch.object(backend, 'ensure_keyboard_target'), patch.object(backend.time, 'sleep'), \
                patch.object(backend, 'send_inputs') as send:
            with self.assertRaisesRegex(ValueError, 'after 1 completed stroke'):
                self.dispatch({'sequence': ['CTRL+K', 'CTRL+S']})
            send.assert_called_once()

    def test_partial_send_releases_keys_and_does_not_continue(self):
        with patch.object(backend.Path, 'exists', return_value=False), \
                patch.object(backend, 'ensure_target', return_value={'window_id': '1'}), \
                patch.object(backend, 'ensure_keyboard_target'), \
                patch.object(backend, 'send_inputs', side_effect=[ValueError('partial'), None]) as send:
            with self.assertRaisesRegex(ValueError, 'after 0 completed stroke'):
                self.dispatch({'sequence': ['RCTRL+LEFT', 'A']})
            self.assertEqual(send.call_count, 2)
            self.assertEqual([(e.value.ki.wVk, e.value.ki.dwFlags) for e in send.call_args.args[0]],
                             [(37, 3), (163, 3)])


if __name__ == '__main__':
    unittest.main()
