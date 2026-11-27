"""Drive a Fractal editor window (AM4-Edit, Axe-Edit) for read-back checks.

The device pushes its state to the editor live, so a check is:
write a value through the MCP tools -> `shot` -> read what the editor shows.

Commands (coordinates are WINDOW-relative pixels, as in the saved PNG):
  editor.py shot [out.png] [--title AM4-Edit]      focus + capture the window
  editor.py ocr  [out.png] [--title AM4-Edit]      capture, then print OCR lines
  editor.py click X Y [--title ...]                left-click inside the window
  editor.py dclick X Y [--title ...]               double-click
  editor.py find TEXT [--title ...]                OCR, print the box of TEXT
  editor.py clicktext TEXT [--title ...]           OCR, click the centre of TEXT

Only Pillow is needed (window capture via ImageGrab, input via user32 SendInput).
Clicks move the real mouse: do not use while the owner is working on the PC.
"""
import ctypes, os, subprocess, sys, time
from ctypes import wintypes
from PIL import ImageGrab

user32 = ctypes.windll.user32
try:
    ctypes.windll.shcore.SetProcessDpiAwareness(2)
except Exception:
    user32.SetProcessDPIAware()

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.environ.get('EDITOR_SHOT_DIR', os.path.join(os.environ.get('TEMP', HERE), 'editor-shots'))


def find_window(title):
    found = []
    @ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)
    def cb(hwnd, _):
        n = user32.GetWindowTextLengthW(hwnd)
        if n and user32.IsWindowVisible(hwnd):
            buf = ctypes.create_unicode_buffer(n + 1)
            user32.GetWindowTextW(hwnd, buf, n + 1)
            if buf.value.startswith(title):
                found.append(hwnd)
        return True
    user32.EnumWindows(cb, 0)
    if not found:
        sys.exit(f'no visible window titled "{title}*"')
    return found[0]


def rect(hwnd):
    r = wintypes.RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(r))
    return r.left, r.top, r.right, r.bottom


def focus(hwnd):
    if user32.IsIconic(hwnd):
        user32.ShowWindow(hwnd, 9)  # SW_RESTORE
    # Alt tap lets SetForegroundWindow succeed from a background process.
    user32.keybd_event(0x12, 0, 0, 0); user32.keybd_event(0x12, 0, 2, 0)
    user32.SetForegroundWindow(hwnd)
    time.sleep(0.25)


def shot(hwnd, out=None):
    # PrintWindow(PW_RENDERFULLCONTENT): the window's own rendering, no focus
    # change, works while covered (not while minimized).
    from PIL import Image
    l, t, r, b = rect(hwnd)
    w, h = r - l, b - t
    gdi32 = ctypes.windll.gdi32
    hdc = user32.GetWindowDC(hwnd); mdc = gdi32.CreateCompatibleDC(hdc)
    bmp = gdi32.CreateCompatibleBitmap(hdc, w, h); gdi32.SelectObject(mdc, bmp)
    user32.PrintWindow(hwnd, mdc, 2)
    buf = ctypes.create_string_buffer(w * h * 4)
    bmi = (ctypes.c_uint32 * 10)(40, w, (-h) & 0xFFFFFFFF, 1 | (32 << 16), 0, 0, 0, 0, 0, 0)
    gdi32.GetDIBits(mdc, bmp, 0, h, buf, bmi, 0)
    img = Image.frombuffer('RGB', (w, h), buf, 'raw', 'BGRX', 0, 1)
    gdi32.DeleteObject(bmp); gdi32.DeleteDC(mdc); user32.ReleaseDC(hwnd, hdc)
    os.makedirs(OUT_DIR, exist_ok=True)
    out = out or os.path.join(OUT_DIR, time.strftime('shot-%H%M%S.png'))
    img.save(out)
    return out


def ocr(png, scale=2):
    # Upscale first: the editor's small slider text OCRs far better at 2x.
    from PIL import Image
    big = png[:-4] + '-x2.png'
    im = Image.open(png).convert('L')
    im = im.resize((im.width * scale, im.height * scale), Image.LANCZOS)
    # Light text on teal / black -> black text on white. The editor draws every
    # value and label light-on-dark, which the OCR engine reads poorly as-is.
    im.point(lambda v: 0 if v > 150 else 255).save(big)
    res = subprocess.run(['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
                          os.path.join(HERE, 'ocr.ps1'), big, str(scale)],
                         capture_output=True, text=True, encoding='utf-8')
    if res.returncode:
        sys.exit(res.stderr)
    lines = []
    for ln in res.stdout.splitlines():
        if '\t' in ln:
            box, text = ln.split('\t', 1)
            lines.append((tuple(int(v) for v in box.split(',')), clean_number(text)))
    return lines


def clean_number(text):
    """Fix OCR digit confusions in value fields ("1 .ooo" -> "1.000", "1 20 BPM")."""
    import re
    head = re.match(r'^[-+]?[0-9oO .,]*[0-9oO][0-9oO .,]*', text)
    if not head or not re.search(r'[0-9]', head.group(0)) and not re.match(r'^[-+]?[.,]?[oO]+$', head.group(0).strip()):
        return text
    num = head.group(0).replace(' ', '').replace('o', '0').replace('O', '0')
    rest = text[head.end():]
    return num + (' ' + rest.strip() if rest.strip() else '')


def click(hwnd, x, y, double=False):
    focus(hwnd)
    l, t, _, _ = rect(hwnd)
    user32.SetCursorPos(l + x, t + y)
    time.sleep(0.05)
    for _ in range(2 if double else 1):
        user32.mouse_event(2, 0, 0, 0, 0); user32.mouse_event(4, 0, 0, 0, 0)
        time.sleep(0.08)
    time.sleep(0.3)


def find_text(lines, text):
    t = text.lower()
    hits = [b for b, s in lines if s.lower() == t] or [b for b, s in lines if t in s.lower()]
    return hits


def main(argv):
    title = 'AM4-Edit'
    if '--title' in argv:
        i = argv.index('--title'); title = argv[i + 1]; del argv[i:i + 2]
    cmd, args = argv[0], argv[1:]
    hwnd = find_window(title)
    if cmd == 'shot':
        print(shot(hwnd, args[0] if args else None))
    elif cmd == 'ocr':
        png = shot(hwnd, args[0] if args else None)
        print(png)
        for (x, y, w, h), s in ocr(png):
            print(f'{x},{y},{w},{h}\t{s}')
    elif cmd in ('click', 'dclick'):
        click(hwnd, int(args[0]), int(args[1]), double=cmd == 'dclick')
    elif cmd in ('find', 'clicktext'):
        text = ' '.join(args)
        hits = find_text(ocr(shot(hwnd)), text)
        if not hits:
            sys.exit(f'"{text}" not found on screen')
        x, y, w, h = hits[0]
        print(f'{x},{y},{w},{h}' + (f' (+{len(hits) - 1} more)' if len(hits) > 1 else ''))
        if cmd == 'clicktext':
            click(hwnd, x + w // 2, y + h // 2)
    else:
        sys.exit(__doc__)


if __name__ == '__main__':
    main(sys.argv[1:] or ['help'])
