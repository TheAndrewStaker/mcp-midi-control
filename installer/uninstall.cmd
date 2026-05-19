@echo off
rem UTF-8 console so non-ASCII glyphs render correctly. Without this,
rem cmd.exe interprets UTF-8 multi-byte sequences via the legacy code
rem page (CP437/CP1252) and produces mojibake for any multi-byte char.
chcp 65001 >nul
setlocal

rem MCP MIDI Control -uninstall script.
rem
rem Removes the mcp-midi-control entry from Claude Desktop's config.
rem Leaves any other MCP servers you have configured intact. After
rem running this, delete this folder to remove the rest.

echo.
echo MCP MIDI Control -unregister from Claude Desktop
echo.

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install\unmerge-mcp-config.ps1"
if errorlevel 1 (
    echo.
    echo Unregister failed. See messages above.
    pause
    exit /b 1
)

echo.
echo Done. To finish removal, close this window and delete the folder:
echo   %~dp0
echo.
pause
