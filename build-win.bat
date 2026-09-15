@echo off
chcp 65001 >nul 2>&1
setlocal

echo =======================================
echo   AgentMemory - Windows 一键打包
echo =======================================
echo.

:: ============ 1. 环境检查 ============
echo [1/6] 检查 Node.js 环境...
node -v >nul 2>&1
if %errorlevel% neq 0 (
    echo [错误] 未检测到 Node.js，请先安装 Node.js ^(>=18.0.0^)
    echo 下载地址: https://nodejs.org/
    pause
    exit /b 1
)
for /f "tokens=*" %%i in ('node -v') do echo [OK] Node.js %%i
for /f "tokens=*" %%i in ('npm -v') do echo [OK] npm %%i

:: ============ 2. 安装主项目依赖 ============
echo.
echo [2/6] 安装主项目依赖...
call npm install
if %errorlevel% neq 0 (
    echo [错误] 主项目依赖安装失败！
    pause
    exit /b 1
)
echo [OK] 主项目依赖安装完成

:: ============ 3. 编译主项目 (Worker) ============
echo.
echo [3/6] 编译主项目 (Worker)...
call npm run build
if %errorlevel% neq 0 (
    echo [错误] Worker 编译失败！
    pause
    exit /b 1
)
echo [OK] Worker 编译完成

:: ============ 4. 安装桌面应用依赖 ============
echo.
echo [4/6] 安装桌面应用依赖...
cd desktop
call npm install
if %errorlevel% neq 0 (
    echo [错误] 桌面应用依赖安装失败！
    cd ..
    pause
    exit /b 1
)

echo [INFO] 重编译 native 模块 (better-sqlite3)...
call npx electron-rebuild -f -w better-sqlite3
echo [OK] 桌面应用依赖安装完成

:: ============ 5. 编译 & Bundle ============
echo.
echo [5/6] 编译桌面应用 ^& 打包 Node.js 运行时...
call npm run build:ts
if %errorlevel% neq 0 (
    echo [错误] TypeScript 编译失败！
    cd ..
    pause
    exit /b 1
)

call npm run bundle-node
echo [OK] 编译与打包准备完成

:: ============ 6. 构建 NSIS 安装包 ============
echo.
echo [6/6] 构建 Windows NSIS 安装包...
call npx electron-builder --win
if %errorlevel% neq 0 (
    echo [错误] 打包失败！
    cd ..
    pause
    exit /b 1
)

cd ..

echo.
echo =======================================
echo [完成] Windows 安装包打包成功！
echo.
echo 安装包位置: desktop\release\
echo.
echo 生成的文件:
if exist "desktop\release\*.exe" (
    dir /b desktop\release\*.exe
) else (
    echo   ^(未找到 .exe 文件^)
)
echo.
echo 使用说明:
echo   1. 双击 .exe 安装文件
echo   2. 按照安装向导完成安装
echo   3. 安装后会自动在系统托盘启动
echo =======================================
pause
