@echo off
echo Restarting AgentMemory Service...
echo.

cd /d %~dp0

echo Stopping worker...
call npm run worker:stop

timeout /t 2 /nobreak >nul

echo Starting worker...
call npm run worker:start

echo.
echo Done!
pause
