# AgentMemory 快速入门指南

本指南帮助你在 **5 分钟内** 完成 AgentMemory 的配置和使用。

## 前置条件

- Node.js >= 18.0.0
- CodeBuddy Agent 已安装
- API Key（TIMIAI / OpenAI / Anthropic 三选一）

---

## 🚀 快速开始

### 第 1 步：一键安装与配置

为方便快速上手，项目提供了 **一键安装脚本**：

**Windows 用户：**
双击运行项目根目录下的 `install.bat`，或在命令行中执行：
```bat
install.bat
```

**Mac/Linux 用户：**
```bash
chmod +x install.sh
./install.sh
```

该脚本会自动执行：
1. 检查 Node.js 环境
2. 安装所有依赖
3. 编译项目代码
4. 运行交互式配置向导（选择 IDE 后自动配置 Hooks 和 MCP）
5. 生成 `.env.local` 配置文件

### 第 2 步：配置 API Key

打开自动生成的 `.env.local` 文件，填入：

```env
TIMIAI_API_KEY=your_api_key_here
```

### 第 3 步：启动服务

```bash
# Windows
start-worker.bat

# 或者使用 npm 命令
npm run worker:start
```

### 第 4 步：验证

1. 打开浏览器访问：`http://localhost:3847/viewer.html`
2. 正常使用 CodeBuddy，系统会自动记录操作
3. 刷新 Web 页面查看记忆数据

---

## ✅ 完成！

现在你已经完成配置，AgentMemory 会：

1. **自动记录** 你的 Shell 命令、文件编辑、MCP 调用
2. **智能压缩** 操作为结构化记忆
3. **自动注入** 历史记忆到新会话

---

## 📚 下一步

- [完整 README](./README.md) - 了解所有功能和配置
- [MCP 配置](./README.md#步骤三配置-mcp-server可选) - 启用主动搜索记忆
- [Web 查看器](http://localhost:3847/viewer.html) - 查看所有记忆数据

---

## ❓ 遇到问题？

```bash
# 查看服务状态
npm run worker:status

# 开启调试日志
LOG_LEVEL=debug npm run worker:start

# 检查 agent-memory 命令是否可用
which agent-memory
```

更多问题请查看 [README.md 故障排查](./README.md#-故障排查) 部分。
