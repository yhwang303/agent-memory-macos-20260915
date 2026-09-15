@echo off
setlocal enabledelayedexpansion
REM hooks-executor.cmd - A wrapper that reads .sh file and executes its content
REM Usage: hooks-executor.cmd /c "path\to\script.sh"
REM This mimics cmd.exe behavior but reads .sh content and executes it

set "SCRIPT_PATH="
set "SKIP_NEXT=0"

:parse_args
if "%~1"=="" goto :execute
if /i "%~1"=="/c" (
    set "SCRIPT_PATH=%~2"
    goto :execute
)
shift
goto :parse_args

:execute
if "%SCRIPT_PATH%"=="" (
    echo ERROR: No script path provided
    exit /b 1
)

REM Read the first line of the script and execute it
set /p CMD_LINE=<"%SCRIPT_PATH%"
%CMD_LINE%
