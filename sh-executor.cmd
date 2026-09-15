@echo off
REM sh-executor.cmd - Executor that handles .sh files on Windows
REM Reads the first line of .sh file and executes it as a Windows command
REM Stdin is preserved and passed through to the executed command

set "SCRIPT=%~1"
if /i "%~1"=="/c" set "SCRIPT=%~2"
if /i "%~1"=="-c" set "SCRIPT=%~2"

REM Read first line of script file using a temp redirect trick
REM This avoids consuming stdin
for /f "usebackq tokens=*" %%a in (`type "%SCRIPT%"`) do (
    %%a
    exit /b %errorlevel%
)
