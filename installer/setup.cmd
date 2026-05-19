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
