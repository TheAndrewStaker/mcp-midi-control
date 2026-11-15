@echo off
rem UTF-8 console so non-ASCII glyphs render correctly. Without this,
rem cmd.exe interprets UTF-8 multi-byte sequences via the legacy code
rem page (CP437/CP1252) and produces mojibake for any multi-byte char.
chcp 65001 >nul
setlocal

rem MCP MIDI Control -FM9 read-back probe (READ-ONLY).
rem
rem Connects to a plugged-in FM9 over USB MIDI, runs a few read-only
rem queries plus a per-block parameter read, and writes a JSON report to
rem the Desktop. It never writes, saves, or changes any preset -it only
rem reads. Quit FM9-Edit first so it isn't holding the MIDI port.
rem
rem Hand the resulting JSON back to the maintainer.

set "INSTALL_DIR=%~dp0"
if "%INSTALL_DIR:~-1%"=="\" set "INSTALL_DIR=%INSTALL_DIR:~0,-1%"

rem Three layouts are supported (try in order):
rem   1. Installer ZIP:    %INSTALL_DIR%\node_modules\@mcp-midi-control\server-all\dist\cli\gen3-readback-probe.js
rem   2. Source install:   %INSTALL_DIR%\packages\server-all\dist\cli\gen3-readback-probe.js
rem   3. Legacy ZIP:       %INSTALL_DIR%\dist\cli\gen3-readback-probe.js

set "ENTRY=%INSTALL_DIR%\node_modules\@mcp-midi-control\server-all\dist\cli\gen3-readback-probe.js"
if not exist "%ENTRY%" set "ENTRY=%INSTALL_DIR%\packages\server-all\dist\cli\gen3-readback-probe.js"
if not exist "%ENTRY%" set "ENTRY=%INSTALL_DIR%\dist\cli\gen3-readback-probe.js"

if not exist "%ENTRY%" (
    echo.
    echo gen3-readback-probe.js not found. The install bundle looks
    echo incomplete -re-extract the ZIP and try again.
    echo.
    pause
    exit /b 1
)

rem Prefer the bundled node.exe; fall back to the system node on PATH.
set "NODE_EXE=%INSTALL_DIR%\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node"

set "OUT=%USERPROFILE%\Desktop\fm9-probe-output.json"

echo.
echo Running the FM9 read-back probe (READ-ONLY)...
echo Make sure your FM9 is connected and FM9-Edit is closed.
echo.

"%NODE_EXE%" "%ENTRY%" fm9 "%OUT%"
set "RC=%ERRORLEVEL%"

echo.
if "%RC%"=="0" (
    echo Done. Please attach this file to a new GitHub issue:
    echo   %OUT%
) else (
    echo The probe could not reach the FM9. See the messages above.
)
echo.
pause
exit /b %RC%
