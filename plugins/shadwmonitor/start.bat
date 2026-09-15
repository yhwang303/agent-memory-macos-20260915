@echo off
chcp 65001 >nul 2>&1
title AI Monitor

echo ================================================
echo          AI Monitor - 屏幕活动感知系统
echo ================================================
echo.

:: 加载 .env 文件（如果存在）
if exist .env (
    echo [INFO] 正在加载 .env 配置...
    for /f "usebackq tokens=1,* delims==" %%A in (".env") do (
        set "line=%%A"
        if not "!line:~0,1!"=="#" (
            set "%%A=%%B"
        )
    )
    echo [INFO] .env 加载完成
) else (
    echo [WARN] 未找到 .env 文件，请确保已设置环境变量
    echo [WARN] 参考 .env.example 创建 .env 文件
    echo.
)

:: 检查环境变量
if "%AI_MONITOR_API_KEY%"=="" (
    echo [ERROR] 未设置 AI_MONITOR_API_KEY 环境变量
    echo [ERROR] 请创建 .env 文件或设置系统环境变量
    echo.
    pause
    exit /b 1
)

echo [INFO] 正在启动采集服务...
start "AI Monitor - Capture" cmd /k "cd /d %~dp0 && python src/main.py capture"

timeout /t 2 /nobreak >nul

echo [INFO] 正在启动 Web 服务...
start "AI Monitor - Web" cmd /k "cd /d %~dp0 && python src/main.py web"

timeout /t 3 /nobreak >nul

echo.
echo ================================================
echo   采集服务已启动（后台运行）
echo   Web  界面已启动: http://127.0.0.1:8080
echo ================================================
echo.
echo 浏览器打开 http://127.0.0.1:8080 查看界面
echo 关闭两个黑色窗口即可停止服务
echo.
pause
