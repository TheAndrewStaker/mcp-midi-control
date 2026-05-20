@echo off
REM Headless run of TraceAxeEditIIStateBuilders.java against Axe-Edit.exe
REM (II generation, model byte 0x07).
REM
REM Locates fn 0x0E / 0x18 / 0x47 working-buffer state envelope builders
REM and parsers, plus traces their callers. Unblocks BK-070 get_preset
REM by revealing the wire shape of AxeEdit's "Read from Axe-Fx" sync
REM flow without needing 21 controlled-diff captures.
REM
REM Prereq: scripts\ghidra\run-axeedit2-full-analyze.cmd has been run
REM at least once. This script is read-only against the analyzed image.
REM
REM Wall time: ~5-10 min on a typical laptop. Idempotent.
REM
REM Output:
REM   C:\dev\mcp-midi-tools\samples\captured\decoded\ghidra-axeedit2-state-builders.txt

setlocal

if "%GHIDRA_INSTALL_DIR%"=="" set GHIDRA_INSTALL_DIR=C:\tools\ghidra_12.0.4_PUBLIC

set HEADLESS=%GHIDRA_INSTALL_DIR%\support\analyzeHeadless.bat
if not exist "%HEADLESS%" (
    echo ERROR: analyzeHeadless.bat not found at "%HEADLESS%".
    echo If Ghidra is installed elsewhere, set GHIDRA_INSTALL_DIR before running.
    exit /b 1
)

set PROJECT_DIR=C:\Users\Steph
set PROJECT_NAME=ghidra-axe-edit
set SCRIPT_DIR=C:\dev\mcp-midi-tools\scripts\ghidra
set OUT_DIR=C:\dev\mcp-midi-tools\samples\captured\decoded

if not exist "%OUT_DIR%" mkdir "%OUT_DIR%"

"%HEADLESS%" "%PROJECT_DIR%" "%PROJECT_NAME%" ^
    -process "Axe-Edit.exe" ^
    -noanalysis ^
    -readOnly ^
    -scriptPath "%SCRIPT_DIR%" ^
    -postScript TraceAxeEditIIStateBuilders.java

if errorlevel 1 (
    echo Ghidra headless exited with errors.
    exit /b 1
)

echo Done. Output: %OUT_DIR%\ghidra-axeedit2-state-builders.txt
endlocal
