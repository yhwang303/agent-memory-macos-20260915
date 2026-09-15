@echo off
chcp 65001 >nul 2>&1
title AI Monitor - 守护进程 (保持此窗口开启)
echo.
echo ===== AI Monitor 守护进程 =====
echo   每30秒检查一次，挂掉自动重启
echo   关闭此窗口即停止守护
echo ================================
echo.

:: 加载 .env
if exist "%~dp0.env" (
    for /f "usebackq delims=" %%L in ("%~dp0.env") do (
        echo %%L | findstr /b "#" >nul || (
            for /f "tokens=1,* delims==" %%A in ("%%L") do set "%%A=%%B"
        )
    )
)

:: 初次启动
wmic process where "commandline like '%%main.py%%'" delete >nul 2>&1
timeout /t 2 /nobreak >nul
start "Capture" cmd /c "cd /d %~dp0 && python src/main.py capture"
timeout /t 3 /nobreak >nul
start "Web" cmd /c "cd /d %~dp0 && python src/main.py web"

:LOOP
timeout /t 30 /nobreak >nul

set capture_ok=0
set web_ok=0

for /f %%i in ('wmic process where "commandline like '%%main.py capture%%'" get processid 2^>nul ^| findstr /r "[0-9]"') do set capture_ok=1
for /f %%i in ('wmic process where "commandline like '%%main.py web%%'" get processid 2^>nul ^| findstr /r "[0-9]"') do set web_ok=1

set HH=%time:~0,2%
set MM=%time:~3,2%
set SS=%time:~6,2%

if "%capture_ok%"=="0" (
    echo [%HH%:%MM%:%SS%] 采集服务挂了！正在重启...
    start "Capture" cmd /c "cd /d %~dp0 && python src/main.py capture"
) else (
    echo [%HH%:%MM%:%SS%] 采集服务 正常
)

if "%web_ok%"=="0" (
    echo [%HH%:%MM%:%SS%] Web服务挂了！正在重启...
    start "Web" cmd /c "cd /d %~dp0 && python src/main.py web"
) else (
    echo [%HH%:%MM%:%SS%] Web服务  正常
)

goto LOOP
