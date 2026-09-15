@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

:: 默认端口
set "PORT=3847"

:: 如果有参数，使用参数作为端口号
if not "%~1"=="" set "PORT=%~1"

echo ========================================
echo   关闭端口 %PORT% 占用的进程
echo ========================================
echo.

:: 查找占用端口的进程
echo 正在查找占用端口 %PORT% 的进程...
echo.

for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%PORT% " ^| findstr "LISTENING"') do (
    set "PID=%%a"
    if not "!PID!"=="0" (
        echo 找到进程 PID: !PID!
        
        :: 获取进程名称
        for /f "tokens=1" %%b in ('tasklist /fi "PID eq !PID!" /fo csv /nh 2^>nul') do (
            set "PNAME=%%~b"
            echo 进程名称: !PNAME!
        )
        
        echo.
        echo 正在终止进程 !PID!...
        taskkill /F /PID !PID! >nul 2>&1
        
        if !errorlevel! equ 0 (
            echo [成功] 进程 !PID! 已被终止
        ) else (
            echo [失败] 无法终止进程 !PID!，可能需要管理员权限
        )
        echo.
    )
)

:: 检查是否找到进程
netstat -ano | findstr ":%PORT% " | findstr "LISTENING" >nul 2>&1
if %errorlevel% neq 0 (
    echo [完成] 端口 %PORT% 现在已释放
) else (
    echo [警告] 端口 %PORT% 可能仍被占用，请尝试以管理员身份运行此脚本
)

echo.
echo ========================================
pause
