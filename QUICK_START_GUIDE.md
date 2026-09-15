# 🧠 Agent Memory 

> Agent Memory 为 Agent 提供**持久化记忆**能力。每次问答自动记录，AI 不再"失忆"。同时提供 Web 界面查看记忆、MCP 工具搜索记忆。

---

## 🚀 快速上手

### 1. 克隆并安装

```bash
git clone https://git.woa.com/ziyadyao/agent-memory.git
cd agent-memory
```

!17 **让Agent读取项目自行完成安装。**!

---

### 2. 获取 TIMI API Key

记忆系统需要调用大模型来智能压缩和总结记忆内容，因此需要一个 API Key。

**获取步骤：**

1. 打开 TIMI AI 平台：**http://api.timiai.woa.com**
2. 登录后进入控制台，找到 **「应用组」**，申请加入一个应用组（或联系已有应用组管理员拉你进组）
3. 进入应用组后，点击 **「创建 API Key」**，生成你的个人 API Key
4. 确保你的 API Key 有使用模型的调用权限，如没有请更换模型


**填入 Key：**

打开项目根目录下的 `.env.local` 文件（安装脚本已自动生成），填入：

```env
TIMIAI_API_KEY=你的API_Key
```

---

### 3. 配置 Hooks

Hooks 是 Agent Memory 的核心——在 AI 操作的各个时机自动触发脚本，实现记忆的采集和注入。

#### 第一步：在 CodeBuddy 设置中配置 Hooks 执行器

1. 打开 CodeBuddy 设置，找到 **Hooks** 区域，打开开关
2. 展开 **Advanced Settings**，在 **Custom Hooks Executor Path** 中配置执行器路径

你可以选择 **bash** 或 **cmd** 作为执行器，但**必须与后续 Hook 脚本中的写法一致**：

| 执行器 | 路径示例 |
|--------|---------|
| **bash**（推荐） | `C:\Users\你的用户名\AppData\Local\UGit\app-x.xx.x\resources\app\git\bin\bash.exe` |
| **cmd** | `C:\Windows\System32\cmd.exe` |

3. 点击 **Save** 保存

#### 第二步：在 Knot 网页上配置 Hook 内容

点击 CodeBuddy Hooks 设置区域中的 **Manage Hooks**，或直接访问：

👉 **https://knot.woa.com/hooks/list**

点击右上角 **「+ 新建 Hook」**，逐个添加以下 10 个 Hook。每个 Hook 需要选择对应的**触发类型**，并填入脚本内容。

> 💡 如果 Hook 脚本保存在项目目录内，推荐直接使用相对路径 `./hooks-entry.js`，这样团队成员都能直接复用。

**需要添加的 Hook 列表：**

| Hook 名称 | 触发类型 | 事件名 |
|-----------|---------|--------|
| beforeSubmitPrompt | 提交提示问前 | `beforeSubmitPrompt` |
| beforeShellExecution | Shell执行前 | `beforeShellExecution` |
| beforeMCPExecution | MCP执行前 | `beforeMCPExecution` |
| afterFileEdit | 文件编辑后 | `afterFileEdit` |
| afterSearchReplaceFileEdit | 搜索替换文件编辑后 | `afterSearchReplaceFileEdit` |
| afterShellExecution | Shell执行后 | `afterShellExecution` |
| afterMCPExecution | MCP执行后 | `afterMCPExecution` |
| afterAgentResponse | Agent响应后 | `afterAgentResponse` |
| afterAgentThought | Agent思考后 | `afterAgentThought` |
| stop | 停止 | `stop` |

---

**🐧 bash 执行器写法**（每个 Hook 两行）：

```bash
#!/bin/bash
node "./hooks-entry.js" 事件名
```

示例 — `beforeSubmitPrompt`（提交提示问前）：

```bash
#!/bin/bash
node "./hooks-entry.js" beforeSubmitPrompt
```

> bash 执行器也可以直接使用相对路径。

---

**🪟 cmd 执行器写法**（每个 Hook 仅一行）：

```
node ".\hooks-entry.js" 事件名
```

示例 — `beforeSubmitPrompt`（提交提示问前）：

```
node ".\hooks-entry.js" beforeSubmitPrompt
```

> cmd 执行器推荐使用 `.\hooks-entry.js` 这种项目相对路径。

---

其余 Hook 以此类推，只需替换最后的**事件名**即可。

#### 第三步：配置 MCP（可选，推荐）

编辑文件 `~/.codebuddy/mcp.json`，添加：

```json
{
  "mcpServers": {
    "agent-memory": {
      "command": "node",
      "args": ["D:/你的路径/agent-memory/dist/servers/mcp-server.js"],
      "env": {}
    }
  }
}
```

---

### 4. 启动服务 & 重启编辑器

```bash
# 启动 Worker 后台服务
start-worker.bat   # 或 npm run worker:start
```

然后**完全重启** CodeBuddy（退出再打开，不是重新加载窗口），Hooks 和 MCP 即可生效。

---

### ✅ 验证

打开浏览器访问 **http://localhost:3847/viewer.html** ，正常使用编辑器对话后刷新页面，即可看到记忆数据。