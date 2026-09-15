@echo off
chcp 65001 >nul 2>&1
title AI Monitor - 重启
echo.
echo ===== AI Monitor 重启 =====
echo.

:: 加载 .env
if exist .env (
    echo [INFO] 加载 .env 配置...
    for /f "usebackq delims=" %%L in (".env") do (
        set "line=%%L"
        if not "%%L"=="" (
            echo %%L | findstr /b "#" >nul || (
                for /f "tokens=1,* delims==" %%A in ("%%L") do set "%%A=%%B"
            )
        )
    )
    echo [INFO] .env 加载完成
) else (
    echo [WARN] 未找到 .env 文件！
)

:: 停止旧进程
echo [INFO] 停止旧进程...
wmic process where "commandline like '%%main.py%%'" delete >nul 2>&1
timeout /t 2 /nobreak >nul

:: 启动采集服务
echo [INFO] 启动采集服务...
start "AI Monitor - Capture" cmd /c "cd /d %~dp0 && python src/main.py capture"
timeout /t 3 /nobreak >nul

:: 启动 Web 服务
echo [INFO] 启动 Web 服务...
start "AI Monitor - Web" cmd /c "cd /d %~dp0 && python src/main.py web"
timeout /t 3 /nobreak >nul

echo.
echo ===================================
echo   重启完成！
echo   Web 界面: http://127.0.0.1:8080
echo ===================================
echo.
:: 显示当前状态
call "%~dp0status.bat"
