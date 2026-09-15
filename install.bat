@echo off
chcp 65001 >nul 2>&1
echo =======================================
echo    AgentMemory 一键安装与配置工具
echo =======================================

echo.
echo [1/4] 检查 Node.js 环境...
node -v >nul 2>&1
if %errorlevel% neq 0 (
    echo [错误] 未检测到 Node.js，请先安装 Node.js ^(>=18.0.0^)
    echo 下载地址: https://nodejs.org/
    pause
    exit /b 1
)

echo.
echo [2/4] 安装项目依赖...
call npm install
if %errorlevel% neq 0 (
    echo [错误] 依赖安装失败！
    pause
    exit /b 1
)

echo.
echo [3/4] 编译项目...
call npm run build
if %errorlevel% neq 0 (
    echo [错误] 项目编译失败！
    pause
    exit /b 1
)

echo.
echo [4/4] 运行配置向导...
call npm run setup

echo.
echo =======================================
echo 🎉 安装与配置全部完成！
echo.
echo 接下来请执行以下操作：
echo 1. 打开 .env.local 文件，填入你的大模型 API_KEY
echo 2. 运行 start-worker.bat (或 npm run worker:start) 启动后台服务
echo 3. 完全重启你的编辑器 (Cursor / CodeBuddy)
echo =======================================
pause
