"""Parse ordinary Windows keys/chords into balanced virtual-key events.

No UI, shell syntax, arbitrary text or persistent key-down state.
"""
import re

MODIFIERS = {'CTRL': 0x11, 'SHIFT': 0x10, 'ALT': 0x12, 'WIN': 0x5B,
             'LCTRL': 0xA2, 'RCTRL': 0xA3, 'LSHIFT': 0xA0, 'RSHIFT': 0xA1,
             'LALT': 0xA4, 'RALT': 0xA5, 'LWIN': 0x5B, 'RWIN': 0x5C}
KEYS = {**MODIFIERS, **{chr(n): n for n in range(65, 91)},
        **{str(n): 48 + n for n in range(10)}, **{f'F{n}': 0x6F + n for n in range(1, 25)},
        **{f'NUMPAD{n}': 0x60 + n for n in range(10)},
        'BACKSPACE': 8, 'TAB': 9, 'CLEAR': 12, 'ENTER': 13, 'PAUSE': 19, 'CAPSLOCK': 20,
        'ESC': 27, 'SPACE': 32, 'PAGEUP': 33, 'PAGEDOWN': 34, 'END': 35, 'HOME': 36,
        'LEFT': 37, 'UP': 38, 'RIGHT': 39, 'DOWN': 40, 'PRINTSCREEN': 44,
        'INSERT': 45, 'DELETE': 46, 'APPS': 93, 'SLEEP': 95,
        'MULTIPLY': 106, 'ADD': 107, 'SEPARATOR': 108, 'SUBTRACT': 109,
        'DECIMAL': 110, 'DIVIDE': 111, 'NUMLOCK': 144, 'SCROLLLOCK': 145,
        'BROWSER_BACK': 166, 'BROWSER_FORWARD': 167, 'BROWSER_REFRESH': 168,
        'BROWSER_STOP': 169, 'BROWSER_SEARCH': 170, 'BROWSER_FAVORITES': 171, 'BROWSER_HOME': 172,
        'VOLUME_MUTE': 173, 'VOLUME_DOWN': 174, 'VOLUME_UP': 175,
        'MEDIA_NEXT': 176, 'MEDIA_PREVIOUS': 177, 'MEDIA_STOP': 178, 'MEDIA_PLAY_PAUSE': 179,
        'LAUNCH_MAIL': 180, 'LAUNCH_MEDIA': 181, 'LAUNCH_APP1': 182, 'LAUNCH_APP2': 183,
        'SEMICOLON': 186, 'EQUAL': 187, 'COMMA': 188, 'MINUS': 189, 'PERIOD': 190,
        'SLASH': 191, 'BACKTICK': 192, 'LBRACKET': 219, 'BACKSLASH': 220,
        'RBRACKET': 221, 'QUOTE': 222, 'OEM102': 226,
        'KANA': 21, 'HANGUL': 21, 'JUNJA': 23, 'FINAL': 24, 'HANJA': 25,
        'KANJI': 25, 'CONVERT': 28, 'NONCONVERT': 29, 'ACCEPT': 30, 'MODECHANGE': 31}
ALIASES = {'CONTROL': 'CTRL', 'OPTION': 'ALT', 'WINDOWS': 'WIN', 'META': 'WIN',
           'ESCAPE': 'ESC', 'RETURN': 'ENTER', 'DEL': 'DELETE', 'INS': 'INSERT',
           'PGUP': 'PAGEUP', 'PGDN': 'PAGEDOWN', 'PAGEDN': 'PAGEDOWN',
           'SPACEBAR': 'SPACE', 'CONTEXTMENU': 'APPS', 'MENU': 'APPS', 'PRTSC': 'PRINTSCREEN',
           'NUMPAD_ADD': 'ADD', 'NUMPAD_SUBTRACT': 'SUBTRACT', 'NUMPAD_MULTIPLY': 'MULTIPLY',
           'NUMPAD_DIVIDE': 'DIVIDE', 'NUMPAD_DECIMAL': 'DECIMAL',
           ';': 'SEMICOLON', '=': 'EQUAL', ',': 'COMMA', '-': 'MINUS', '.': 'PERIOD',
           '/': 'SLASH', '`': 'BACKTICK', '[': 'LBRACKET', '\\': 'BACKSLASH', ']': 'RBRACKET', "'": 'QUOTE'}
EXTENDED = {0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2C, 0x2D, 0x2E,
            0x5B, 0x5C, 0x5D, 0x6F, 0x90, 0xA3, 0xA5, *range(0xA6, 0xB8)}


def parse_chord(value):
    if not isinstance(value, str) or not value.strip() or len(value) > 120 or any(ord(c) < 32 for c in value):
        raise ValueError('Use a key or chord such as CTRL+SHIFT+P; sequences use the sequence field.')
    value = value.strip().upper()
    if value == '+':
        value = 'PLUS'
    elif value.endswith('++'):
        value = value[:-1] + 'PLUS'
    names = [ALIASES.get(p.strip(), p.strip()) for p in value.split('+')]
    # PLUS is the shifted OEM plus/equal key, unlike the numpad ADD key.
    if names[-1] == 'PLUS':
        names[-1] = 'EQUAL'
        if not any(n in {'SHIFT', 'LSHIFT', 'RSHIFT'} for n in names[:-1]):
            names.insert(0, 'SHIFT')
    if not names or any(n not in MODIFIERS for n in names[:-1]):
        raise ValueError('A chord consists of modifiers followed by one key; use sequence for multiple strokes.')
    codes = []
    for name in names:
        if name == 'NUMPAD_ENTER':
            code, extended = 13, True
        elif name in KEYS:
            code = KEYS[name]
            extended = code in EXTENDED
        elif re.fullmatch(r'VK_0X[0-9A-F]{2}', name):
            code = int(name[5:], 16)
            if not 8 <= code <= 254:
                raise ValueError('VK_0xNN must be a keyboard virtual key from 0x08 through 0xFE.')
            extended = code in EXTENDED
        else:
            raise ValueError(f'Unknown key {name!r}. Use a named key or documented Windows VK_0xNN.')
        if any(old[0] == code for old in codes):
            raise ValueError('Do not repeat the same key in one chord.')
        codes.append((code, extended))
    return codes


def parse_request(request):
    if ('key' in request) == ('sequence' in request):
        raise ValueError('Supply exactly one of key or sequence.')
    values = [request['key']] if 'key' in request else request['sequence']
    if not isinstance(values, list) or not 1 <= len(values) <= 8:
        raise ValueError('sequence must contain 1 to 8 shortcut strokes, not a general macro.')
    return [parse_chord(value) for value in values]
