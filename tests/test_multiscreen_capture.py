"""Exercise GDI capture contracts without reading the user's desktop pixels."""
import ctypes
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

SCRIPT = Path(__file__).resolve().parents[1] / 'skills/windows-multiscreen-screenshot/scripts/screen_shot.py'
spec = importlib.util.spec_from_file_location('multiscreen_capture', SCRIPT)
capture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(capture)


class CaptureTests(unittest.TestCase):
    def setup_api(self, bitblt=True, rows=2):
        # Values exceed 32 bits so a future c_int declaration is detectable.
        screen, dc, bitmap, previous = (0x100000001, 0x100000002, 0x100000003, 0x100000004)
        selected = {'value': False}
        def select(hdc, obj):
            self.assertEqual(hdc, dc)
            selected['value'] = obj == bitmap
            return previous if selected['value'] else bitmap
        def dibits(hdc, bm, start, count, buf, header, usage):
            self.assertFalse(selected['value'], 'GetDIBits requires a deselected bitmap')
            info = ctypes.cast(header, ctypes.POINTER(capture._BITMAPINFOHEADER)).contents
            self.assertEqual((info.biWidth, info.biHeight), (2, -2))
            # Top row red/green; bottom blue/white. Alpha intentionally zero.
            pixels = bytes([0,0,255,0, 0,255,0,0, 255,0,0,0, 255,255,255,0])
            ctypes.memmove(buf, pixels, len(pixels))
            return rows
        user = SimpleNamespace(GetDC=Mock(return_value=screen), ReleaseDC=Mock(return_value=1))
        gdi = SimpleNamespace(CreateCompatibleDC=Mock(return_value=dc),
                              CreateCompatibleBitmap=Mock(return_value=bitmap),
                              SelectObject=Mock(side_effect=select), BitBlt=Mock(return_value=bitblt),
                              GetDIBits=Mock(side_effect=dibits), DeleteObject=Mock(return_value=1),
                              DeleteDC=Mock(return_value=1))
        return user, gdi, (screen,dc,bitmap)

    def test_negative_origin_orientation_and_cleanup(self):
        self.assertIs(capture.gdi32.CreateCompatibleBitmap.restype, ctypes.wintypes.HBITMAP)
        user, gdi, (screen,dc,bm) = self.setup_api()
        with patch.object(capture, 'user32', user), patch.object(capture, 'gdi32', gdi):
            img = capture._grab_gdi(-2160, -954, 2, 2)
        gdi.BitBlt.assert_called_once_with(dc,0,0,2,2,screen,-2160,-954,capture.SRCCOPY|capture.CAPTUREBLT)
        self.assertEqual([img.getpixel((x,y)) for y in range(2) for x in range(2)],
                         [(255,0,0),(0,255,0),(0,0,255),(255,255,255)])
        user.ReleaseDC.assert_called_once_with(None,screen)
        gdi.DeleteDC.assert_called_once_with(dc)
        gdi.DeleteObject.assert_called_once_with(bm)

    def test_failed_copy_and_short_read_release_resources(self):
        for blt, rows in [(False,2),(True,1)]:
            with self.subTest(bitblt=blt,rows=rows):
                user,gdi,(screen,dc,bm)=self.setup_api(blt,rows)
                with patch.object(capture,'user32',user),patch.object(capture,'gdi32',gdi):
                    with self.assertRaises((OSError,RuntimeError)):
                        capture._grab_gdi(-5,-9,2,2)
                gdi.DeleteObject.assert_called_once_with(bm)
                gdi.DeleteDC.assert_called_once_with(dc)
                user.ReleaseDC.assert_called_once_with(None,screen)
                if not blt:gdi.GetDIBits.assert_not_called()

    def test_invalid_size_does_not_allocate(self):
        with patch.object(capture.user32,'GetDC') as getdc:
            with self.assertRaises(ValueError):capture._grab_gdi(-1,-1,0,10)
            getdc.assert_not_called()

    def test_virtual_desktop_bounds(self):
        monitors=[(0,False,-2160,-954,2160,3840,'120x120'),(1,True,0,0,3840,2160,'120x120')]
        with patch.object(capture,'_grab_gdi') as grab:
            capture.merge_all(monitors)
            grab.assert_called_once_with(-2160,-954,6000,3840)

if __name__ == '__main__':
    unittest.main()
