@echo off
rem UTF-8 console so non-ASCII glyphs render correctly.
chcp 65001 >nul
setlocal

rem MCP MIDI Control - Axe-Fx III WRITE-VERIFY probe (SAFE: never saves).
rem
rem Connects to a plugged-in Axe-Fx III over USB MIDI and runs each shipped
rem write op (set a knob, set a model, place a block, switch scene, bypass)
rem against the LOADED preset, reading each one back to confirm the device
rem applied it. It NEVER saves, and it RELOADS your preset at the end to discard
rem every change, so your Axe-Fx III ends exactly where it started. Quit AxeEdit
rem III first so it isn't holding the MIDI port.
rem
rem Hand the resulting JSON file back to the maintainer.

set "INSTALL_DIR=%~dp0"
if "%INSTALL_DIR:~-1%"=="\" set "INSTALL_DIR=%INSTALL_DIR:~0,-1%"

set "ENTRY=%INSTALL_DIR%\node_modules\@mcp-midi-control\server-all\dist\cli\gen3-verify-probe.js"
if not exist "%ENTRY%" set "ENTRY=%INSTALL_DIR%\packages\server-all\dist\cli\gen3-verify-probe.js"
if not exist "%ENTRY%" set "ENTRY=%INSTALL_DIR%\..\packages\server-all\dist\cli\gen3-verify-probe.js"
if not exist "%ENTRY%" set "ENTRY=%INSTALL_DIR%\dist\cli\gen3-verify-probe.js"

if not exist "%ENTRY%" (
    echo.
    echo gen3-verify-probe.js not found. The install bundle looks incomplete.
    echo Re-extract the ZIP and try again.
    echo.
    pause
    exit /b 1
)

set "NODE_EXE=%INSTALL_DIR%\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node"

set "OUT=%USERPROFILE%\Desktop\axefx3-verify-output.json"

echo.
echo Running the Axe-Fx III WRITE-VERIFY probe.
echo SAFE: it never saves, and it reloads your preset at the end to discard changes.
echo Make sure your Axe-Fx III is connected and AxeEdit III is closed.
echo.

"%NODE_EXE%" "%ENTRY%" axe-fx-iii "%OUT%"
set "RC=%ERRORLEVEL%"

echo.
if "%RC%"=="0" (
    echo Done. Please attach this file to a new GitHub issue:
    echo   %OUT%
) else (
    echo The probe could not reach the Axe-Fx III. See the messages above.
)
echo.
pause
exit /b %RC%
