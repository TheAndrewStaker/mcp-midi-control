@echo off
rem UTF-8 console so non-ASCII glyphs render correctly. Without this,
rem cmd.exe interprets UTF-8 multi-byte sequences via the legacy code
rem page (CP437/CP1252) and produces mojibake for any multi-byte char.
chcp 65001 >nul
setlocal

rem MCP MIDI Control v0.1.0 -post-install MIDI device check.
rem
rem Asks the OS what MIDI devices it can see and reports whether the
rem AM4, Axe-Fx II, Axe-Fx III, or Hydrasynth is visible. Bypasses
rem Claude Desktop entirely, so if the tools "don't appear" in Claude
rem you can use this to confirm whether the device is reachable at all.
rem
rem Run after setup.cmd, before opening Claude Desktop.

set "INSTALL_DIR=%~dp0"
if "%INSTALL_DIR:~-1%"=="\" set "INSTALL_DIR=%INSTALL_DIR:~0,-1%"

rem Three layouts are supported (try in order):
rem   1. Installer ZIP (v0.1.x post-workspace-split):
rem      %INSTALL_DIR%\node_modules\@mcp-midi-control\server-all\dist\cli\verify-midi.js
rem   2. Source install (developer running `npm run build` in checkout):
rem      %INSTALL_DIR%\packages\server-all\dist\cli\verify-midi.js
rem   3. Legacy v0.1.0 ZIP (pre-workspace-split):
rem      %INSTALL_DIR%\dist\cli\verify-midi.js

set "ENTRY=%INSTALL_DIR%\node_modules\@mcp-midi-control\server-all\dist\cli\verify-midi.js"
if not exist "%ENTRY%" set "ENTRY=%INSTALL_DIR%\packages\server-all\dist\cli\verify-midi.js"
if not exist "%ENTRY%" set "ENTRY=%INSTALL_DIR%\dist\cli\verify-midi.js"

if not exist "%ENTRY%" (
    echo.
    echo verify-midi.js not found in any of the expected locations:
    echo   %INSTALL_DIR%\node_modules\@mcp-midi-control\server-all\dist\cli\verify-midi.js
    echo   %INSTALL_DIR%\packages\server-all\dist\cli\verify-midi.js
    echo   %INSTALL_DIR%\dist\cli\verify-midi.js
    echo.
    echo The install bundle looks incomplete. Re-extract the ZIP and
    echo try again.
    echo.
    pause
    exit /b 1
)

rem Prefer the bundled node.exe (v0.1.0 ZIP layout); fall back to the
rem system `node` on PATH if the bundle isn't present (e.g. a developer
rem source-install).
set "NODE_EXE=%INSTALL_DIR%\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node"

"%NODE_EXE%" "%ENTRY%"
set "RC=%ERRORLEVEL%"

echo.
pause
exit /b %RC%
