#!/bin/bash
echo "======================================="
echo "   AgentMemory 一键安装与配置工具"
echo "======================================="
echo

echo "[1/4] 检查 Node.js 环境..."
if ! command -v node &> /dev/null; then
    echo "[错误] 未检测到 Node.js，请先安装 Node.js (>=18.0.0)"
    echo "下载地址: https://nodejs.org/"
    exit 1
fi

echo
echo "[2/4] 安装项目依赖..."
npm install
if [ $? -ne 0 ]; then
    echo "[错误] 依赖安装失败！"
    exit 1
fi

echo
echo "[3/4] 编译项目..."
npm run build
if [ $? -ne 0 ]; then
    echo "[错误] 项目编译失败！"
    exit 1
fi

echo
echo "[4/4] 运行配置向导..."
npm run setup

echo
echo "======================================="
echo "🎉 安装与配置全部完成！"
echo
echo "接下来请执行以下操作："
echo "1. 打开 .env.local 文件，填入你的大模型 API_KEY"
echo "2. 运行 npm run worker:start (或 start-worker.bat) 启动后台服务"
echo "3. 完全重启你的编辑器 (Cursor / CodeBuddy)"
echo "======================================="
