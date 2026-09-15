#!/bin/bash
set -e

echo "======================================="
echo "  AgentMemory - macOS 一键打包"
echo "======================================="
echo ""

# 颜色定义
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# 检测架构
ARCH=$(uname -m)
echo -e "${GREEN}[INFO]${NC} 当前系统架构: $ARCH"

# ============ 1. 环境检查 ============
echo ""
echo "[1/6] 检查 Node.js 环境..."
if ! command -v node &> /dev/null; then
    echo -e "${RED}[错误]${NC} 未检测到 Node.js，请先安装 Node.js (>=18.0.0)"
    echo "  - brew install node"
    echo "  - 或 https://nodejs.org/"
    exit 1
fi

NODE_VERSION=$(node -v)
echo -e "${GREEN}[OK]${NC} Node.js $NODE_VERSION"

if ! command -v npm &> /dev/null; then
    echo -e "${RED}[错误]${NC} 未检测到 npm"
    exit 1
fi
echo -e "${GREEN}[OK]${NC} npm $(npm -v)"

# ============ 2. 安装主项目依赖 ============
echo ""
echo "[2/6] 安装主项目依赖..."
npm install
echo -e "${GREEN}[OK]${NC} 主项目依赖安装完成"

# ============ 3. 编译主项目 (Worker) ============
echo ""
echo "[3/6] 编译主项目 (Worker)..."
npm run build
echo -e "${GREEN}[OK]${NC} Worker 编译完成"

# ============ 4. 安装桌面应用依赖 ============
echo ""
echo "[4/6] 安装桌面应用依赖..."
cd desktop

# 先安装依赖
npm install

# electron-rebuild 重编译 better-sqlite3 (native module)
echo -e "${YELLOW}[INFO]${NC} 重编译 native 模块 (better-sqlite3)..."
npx electron-rebuild -f -w better-sqlite3 2>&1 || {
    echo -e "${YELLOW}[WARN]${NC} electron-rebuild 失败，尝试继续..."
}

echo -e "${GREEN}[OK]${NC} 桌面应用依赖安装完成"

# 解析命令行参数
BUILD_ARCH=""
TARGET_ARCH_VALUE=""
IS_UNIVERSAL=false
if [ "$1" == "--arm64" ]; then
    BUILD_ARCH="--arm64"
    TARGET_ARCH_VALUE="arm64"
    echo -e "${GREEN}[INFO]${NC} 指定构建 ARM64 (Apple Silicon) 版本"
elif [ "$1" == "--x64" ]; then
    BUILD_ARCH="--x64"
    TARGET_ARCH_VALUE="x64"
    echo -e "${GREEN}[INFO]${NC} 指定构建 x64 (Intel) 版本"
elif [ "$1" == "--universal" ]; then
    IS_UNIVERSAL=true
    echo -e "${GREEN}[INFO]${NC} 构建 Universal (x64 + arm64) 版本"
else
    # 根据当前架构自动选择
    if [ "$ARCH" == "arm64" ]; then
        BUILD_ARCH="--arm64"
        TARGET_ARCH_VALUE="arm64"
        echo -e "${GREEN}[INFO]${NC} 自动选择 ARM64 (Apple Silicon) 版本"
    else
        BUILD_ARCH="--x64"
        TARGET_ARCH_VALUE="x64"
        echo -e "${GREEN}[INFO]${NC} 自动选择 x64 (Intel) 版本"
    fi
fi

# ============ 5. 编译 & Bundle ============
echo ""
echo "[5/6] 编译桌面应用 & 准备打包运行时..."

if [ "$IS_UNIVERSAL" = true ]; then
    echo -e "${YELLOW}[INFO]${NC} Universal 模式会分别准备 ARM64 和 x64 运行时"
else
    TARGET_ARCH="$TARGET_ARCH_VALUE" npm run prepare:bundle
fi

echo -e "${GREEN}[OK]${NC} 编译与打包准备完成"

# ============ 6. 构建 DMG ============
echo ""
echo "[6/6] 构建 macOS DMG 安装包..."

if [ "$IS_UNIVERSAL" = true ]; then
    for TARGET in arm64 x64; do
        echo -e "${GREEN}[INFO]${NC} 准备并构建 ${TARGET} 版本..."
        TARGET_ARCH="$TARGET" npm run prepare:bundle
        npx electron-builder --mac --"$TARGET"
    done
else
    npx electron-builder --mac $BUILD_ARCH
fi

cd ..

echo ""
echo "======================================="
echo -e "${GREEN}[完成]${NC} macOS DMG 打包成功！"
echo ""
echo "安装包位置: desktop/release/"
echo ""

# 列出生成的文件
if [ -d "desktop/release" ]; then
    echo "生成的文件:"
    ls -lh desktop/release/*.dmg 2>/dev/null || echo "  (未找到 .dmg 文件)"
    ls -lh desktop/release/*.zip 2>/dev/null || true
fi

echo ""
echo "使用说明:"
echo "  1. 双击 .dmg 文件打开"
echo "  2. 将 AgentMemory 拖入 Applications 文件夹"
echo "  3. 首次打开可能需要: 系统设置 > 安全性 > 仍要打开"
echo "======================================="
