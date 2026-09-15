@echo off
chcp 65001 >nul 2>&1
echo.
echo ===== AI Monitor 服务状态 =====
echo.

set capture_running=0
set web_running=0

for /f "tokens=1" %%i in ('wmic process where "commandline like '%%main.py capture%%'" get processid 2^>nul ^| findstr /r "[0-9]"') do (
    set capture_pid=%%i
    set capture_running=1
)

for /f "tokens=1" %%i in ('wmic process where "commandline like '%%main.py web%%'" get processid 2^>nul ^| findstr /r "[0-9]"') do (
    set web_pid=%%i
    set web_running=1
)

if "%capture_running%"=="1" (
    echo [正常] 采集服务 运行中 (PID: %capture_pid%)
) else (
    echo [停止] 采集服务 已停止 !!
)

if "%web_running%"=="1" (
    echo [正常] Web 服务  运行中 (PID: %web_pid%)
    echo        访问地址: http://127.0.0.1:8080
) else (
    echo [停止] Web 服务  已停止 !!
)

echo.
if "%capture_running%%web_running%"=="11" (
    echo 所有服务运行正常
) else (
    echo 有服务已停止！请运行 restart.bat 重启
)
echo.
pause
