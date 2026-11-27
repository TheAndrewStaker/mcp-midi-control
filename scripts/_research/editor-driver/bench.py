"""Run programs on a hidden Win32 desktop so they can never take the owner's focus.

A Win32 desktop (CreateDesktop) is not a Task View virtual desktop: only the
desktop that owns input can be in the foreground, so a JUCE editor that
activates itself on every UI Automation action stays out of the owner's way.
The driver (uia.ps1) must run on the same desktop to see the editor.

  bench.py launch <exe> [args...]     start a program on the bench desktop
  bench.py run <command line>         run a console command there, print its output
  bench.py uia "<uia.ps1 script>"     shortcut: run uia.ps1 on the bench desktop
  bench.py show / hide                switch the screen to the bench desktop and back
"""
import ctypes, os, subprocess, sys, tempfile, time
from ctypes import wintypes

DESKTOP = 'mcp-bench'
HERE = os.path.dirname(os.path.abspath(__file__))
user32, kernel32 = ctypes.windll.user32, ctypes.windll.kernel32
kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
GENERIC_ALL = 0x10000000


class STARTUPINFO(ctypes.Structure):
    _fields_ = [('cb', wintypes.DWORD), ('lpReserved', wintypes.LPWSTR), ('lpDesktop', wintypes.LPWSTR),
                ('lpTitle', wintypes.LPWSTR), ('dwX', wintypes.DWORD), ('dwY', wintypes.DWORD),
                ('dwXSize', wintypes.DWORD), ('dwYSize', wintypes.DWORD), ('dwXCountChars', wintypes.DWORD),
                ('dwYCountChars', wintypes.DWORD), ('dwFillAttribute', wintypes.DWORD), ('dwFlags', wintypes.DWORD),
                ('wShowWindow', wintypes.WORD), ('cbReserved2', wintypes.WORD), ('lpReserved2', ctypes.c_void_p),
                ('hStdInput', wintypes.HANDLE), ('hStdOutput', wintypes.HANDLE), ('hStdError', wintypes.HANDLE)]


class PROCESS_INFORMATION(ctypes.Structure):
    _fields_ = [('hProcess', wintypes.HANDLE), ('hThread', wintypes.HANDLE),
                ('dwProcessId', wintypes.DWORD), ('dwThreadId', wintypes.DWORD)]


def ensure_desktop():
    user32.CreateDesktopW.restype = wintypes.HANDLE
    h = user32.CreateDesktopW(DESKTOP, None, None, 0, GENERIC_ALL, None)
    if not h:
        raise OSError(f'CreateDesktop failed: {ctypes.GetLastError()}')
    return h  # keep open for the life of this process; the desktop persists while any process uses it


def spawn(cmdline, wait=False, stdout_path=None):
    ensure_desktop()
    si = STARTUPINFO(); si.cb = ctypes.sizeof(si); si.lpDesktop = f'WinSta0\\{DESKTOP}'
    handles = []
    if stdout_path:
        sa = (ctypes.c_ulong * 3)(12, 0, 1)  # SECURITY_ATTRIBUTES with bInheritHandle = TRUE
        kernel32.CreateFileW.restype = wintypes.HANDLE
        fh = kernel32.CreateFileW(stdout_path, 0x40000000, 3, ctypes.byref(sa), 2, 0x80, None)
        si.dwFlags |= 0x100  # STARTF_USESTDHANDLES
        si.hStdOutput = si.hStdError = fh
        handles.append(fh)
    pi = PROCESS_INFORMATION()
    flags = 0x08000000  # CREATE_NO_WINDOW for console tools
    ok = kernel32.CreateProcessW(None, ctypes.create_unicode_buffer(cmdline), None, None, bool(stdout_path),
                                 flags if stdout_path else 0, None, None, ctypes.byref(si), ctypes.byref(pi))
    if not ok:
        raise OSError(f'CreateProcess failed: {ctypes.GetLastError()}')
    if wait:
        kernel32.WaitForSingleObject(pi.hProcess, 0xFFFFFFFF)
    for h in handles + [pi.hThread, pi.hProcess]:
        kernel32.CloseHandle(h)
    return pi.dwProcessId


def run(cmdline):
    fd, path = tempfile.mkstemp(suffix='.txt'); os.close(fd)
    try:
        spawn(cmdline, wait=True, stdout_path=path)
        with open(path, 'rb') as f:
            return f.read().decode('utf-8', 'replace')
    finally:
        os.remove(path)


def switch(name):
    user32.OpenDesktopW.restype = wintypes.HANDLE
    h = user32.OpenDesktopW(name, 0, False, GENERIC_ALL)
    if not h or not user32.SwitchDesktop(h):
        raise OSError(f'SwitchDesktop({name}) failed: {ctypes.GetLastError()}')


def main(argv):
    cmd, rest = argv[0], argv[1:]
    if cmd == 'launch':
        print(spawn(subprocess.list2cmdline(rest)))
    elif cmd == 'run':
        sys.stdout.write(run(' '.join(rest)))
    elif cmd == 'uia':
        ps = f'powershell -NoProfile -ExecutionPolicy Bypass -File "{os.path.join(HERE, "uia.ps1")}" ' + subprocess.list2cmdline(rest)
        sys.stdout.write(run(ps))
    elif cmd == 'show':
        switch(DESKTOP)
    elif cmd == 'hide':
        switch('Default')
    else:
        sys.exit(__doc__)


if __name__ == '__main__':
    main(sys.argv[1:] or ['help'])
