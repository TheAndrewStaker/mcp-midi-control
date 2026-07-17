@echo off
REM BK-054: find indirect (non-CALL-type) references to the AxeEdit III
REM fn-byte emit wrappers that DecodeAxeEditIIINewFnBytes.java reported as
REM having "no callers" (fn=0x08 x4, fn=0x43 x1), plus decompile the two
REM un-mined fn=0x00 emit sites, plus a control check against the known
REM fn=0x77 builder.
REM
REM Output: samples\captured\decoded\ghidra-axe-edit-iii-indirect-fn-callers.txt

setlocal
for %%I in ("%~dp0..\..\..\..") do set "PROJECT_ROOT=%%~fI"

if "%GHIDRA_INSTALL_DIR%"=="" set GHIDRA_INSTALL_DIR=C:\tools\ghidra_12.0.4_PUBLIC

set HEADLESS=%GHIDRA_INSTALL_DIR%\support\analyzeHeadless.bat
if not exist "%HEADLESS%" (
    echo ERROR: analyzeHeadless.bat not found at "%HEADLESS%".
    exit /b 1
)

set PROJECT_DIR=%USERPROFILE%
set PROJECT_NAME=ghidra-axe-edit-3
set SCRIPT_DIR=%PROJECT_ROOT%\packages\fractal-midi\scripts\ghidra
set OUT_DIR=%PROJECT_ROOT%\packages\fractal-midi\samples\captured\decoded

if not exist "%OUT_DIR%" mkdir "%OUT_DIR%"

"%HEADLESS%" "%PROJECT_DIR%" "%PROJECT_NAME%" ^
    -process "Axe-Edit III.exe" ^
    -noanalysis ^
    -readOnly ^
    -scriptPath "%SCRIPT_DIR%" ^
    -postScript FindAxeEditIIIIndirectFnByteCallers.java

if errorlevel 1 (
    echo Ghidra headless exited with errors.
    exit /b 1
)

echo Done. Output: %OUT_DIR%\ghidra-axe-edit-iii-indirect-fn-callers.txt
endlocal
