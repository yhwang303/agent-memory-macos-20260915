@echo off
setlocal EnableDelayedExpansion

:: Get the hook name from the first argument
set "HOOK_NAME=%~1"
set "LOG_FILE=D:\GitHub\agent-memory\hook-debug.log"

:: Log timestamp and hook name
echo [%date% %time%] Hook called: %HOOK_NAME% >> "%LOG_FILE%"

:: If no argument provided, exit with error
if "%HOOK_NAME%"=="" (
    echo {"error": "No hook name provided"} >&2
    echo [%date% %time%] ERROR: No hook name provided >> "%LOG_FILE%"
    exit /b 1
)

:: Log that we're about to run node
echo [%date% %time%] Running: node "D:\GitHub\agent-memory\dist\hooks-cli.js" %HOOK_NAME% >> "%LOG_FILE%"

:: Run the node hook script
node "D:\GitHub\agent-memory\dist\hooks-cli.js" %HOOK_NAME%

:: Log exit code
echo [%date% %time%] Exit code: %ERRORLEVEL% >> "%LOG_FILE%"
