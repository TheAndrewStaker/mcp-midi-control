"""Click inside a JUCE editor window by posting mouse messages: no focus change,
no real cursor movement. The window is restored BEHIND other windows if minimized.
  postclick.py <title> <screenX> <screenY>     (screen coords as UI Automation reports them)"""
import ctypes, sys, time
from ctypes import wintypes
u = ctypes.windll.user32
try: ctypes.windll.shcore.SetProcessDpiAwareness(2)
except Exception: pass

def find(title):
    out = []
    @ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)
    def cb(h, _):
        n = u.GetWindowTextLengthW(h)
        if n:
            b = ctypes.create_unicode_buffer(n + 1); u.GetWindowTextW(h, b, n + 1)
            if b.value == title and u.IsWindowVisible(h): out.append(h)
        return True
    u.EnumWindows(cb, 0)
    return out[0]

def ensure_shown(h):
    if u.IsIconic(h):
        u.ShowWindow(h, 4)  # SW_SHOWNOACTIVATE
        u.SetWindowPos(h, 1, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010)  # HWND_BOTTOM, NOSIZE|NOMOVE|NOACTIVATE
        time.sleep(0.5)

def click(h, sx, sy):
    pt = wintypes.POINT(sx, sy); u.ScreenToClient(h, ctypes.byref(pt))
    lp = (pt.y << 16) | (pt.x & 0xFFFF)
    u.PostMessageW(h, 0x0200, 0, lp); time.sleep(0.03)
    u.PostMessageW(h, 0x0201, 1, lp); time.sleep(0.06)
    u.PostMessageW(h, 0x0202, 0, lp); time.sleep(0.3)

if __name__ == '__main__':
    h = find(sys.argv[1]); ensure_shown(h); click(h, int(sys.argv[2]), int(sys.argv[3]))
