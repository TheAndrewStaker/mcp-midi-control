@echo off
rem UTF-8 console so non-ASCII glyphs render correctly. Without this,
rem cmd.exe interprets UTF-8 multi-byte sequences via the legacy code
rem page (CP437/CP1252) and produces mojibake for any multi-byte char.
chcp 65001 >nul
setlocal

rem MCP MIDI Control v0.1.0 -setup script.
rem
rem Run this once after extracting the ZIP. It writes an entry into
rem Claude Desktop's claude_desktop_config.json so the tools appear in
rem your next chat session. Idempotent -safe to run repeatedly.

set "INSTALL_DIR=%~dp0"
if "%INSTALL_DIR:~-1%"=="\" set "INSTALL_DIR=%INSTALL_DIR:~0,-1%"

echo.
echo MCP MIDI Control v0.1.0 -setup
echo Install location: %INSTALL_DIR%
echo.

rem Fast-fail diagnostic: if the helper PS1 isn't where we expect, the
rem extraction is broken and the user needs to know BEFORE PowerShell
rem prints its own less-friendly "file not found" error. The most common
rem cause is a nested folder created by Windows Explorer when the ZIP's
rem top-level dir name matches the chosen extract destination.
if not exist "%INSTALL_DIR%\install\merge-mcp-config.ps1" (
    echo SETUP FAILED -installer helper script not found.
    echo.
    echo Expected:
    echo   %INSTALL_DIR%\install\merge-mcp-config.ps1
    echo.
    echo This usually means your ZIP tool extracted into a nested folder.
    echo Check whether there is a "mcp-midi-control-v0.1.0" folder INSIDE
    echo your install directory. If so, either:
    echo   - move its contents up one level, or
    echo   - re-run setup.cmd from inside that nested folder.
    echo.
    pause
    exit /b 1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%INSTALL_DIR%\install\merge-mcp-config.ps1" -InstallDir "%INSTALL_DIR%"
if errorlevel 1 (
    echo.
    echo Setup failed. See messages above.
    pause
    exit /b 1
)

echo.
echo Setup complete.
echo.
echo Next:
echo   1. If Claude Desktop is running, fully quit it (system tray right-click then Quit).
echo   2. Reopen Claude Desktop. The MCP MIDI Control server appears in the connector panel.
echo   3. Make sure your AM4 USB driver is installed: https://www.fractalaudio.com/am4-downloads/
echo.
pause
