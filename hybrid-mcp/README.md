# agentmem-hybrid-mcp

> 给已安装 **AgentMemory（AgentMemory）桌面端**的同事，零代码改动地获得 hybrid 记忆检索能力。
>
> 同事侧只做一件事：**全局装一次包 + 在 IDE 的 `mcpServers` 配置里加一段 JSON**，重启 IDE。剩下的全部由这个 MCP 自己消化。

---

## 0. 这是什么

| | AgentMemory 自带 MCP | agentmem-hybrid-mcp |
|---|---|---|
| 进程能起来 | ❌ 启动崩（缺 `zod`） | ✅ |
| 工具可用 | 0 个 | **11 个** |
| 检索质量 | — | **hybrid**（SQLite FTS5 + 本地向量 BGE-zh + RRF 融合） |

效果对比（跑在 11000+ obs 真实数据集上）：

| 指标 | AgentMemory sqlite 基线 | agentmem-hybrid-mcp |
|---|---|---|
| Recall@10 | 18.47% | **26.91%** (+45.7%) |
| MRR | 0.128 | **0.424** (+232%) |
| paraphrase MRR | 0 | **0.432**（纯关键词永远做不到） |

完整评测见 `REPORT.md`。

---

## 1. 五分钟上手

### 1.1 前置

- Node.js ≥ 18 + npm
- AgentMemory 桌面端在跑（`curl http://localhost:3847/health` 通）

### 1.2 安装

```bash
npm i -g ./agentmem-hybrid-mcp-<version>.tgz
```

验证命令到位：

```bash
where agentmem-hybrid-mcp        # Windows
which agentmem-hybrid-mcp        # Mac/Linux
```

### 1.3 配 IDE

在 IDE 的 `mcpServers` 里加：

```json
{
  "mcpServers": {
    "cbm-hybrid": {
      "command": "agentmem-hybrid-mcp"
    }
  }
}
```

CodeBuddy: `~/.codebuddy/mcp.json`
Claude Code: `~/.claude.json`

**完全退出 IDE 再重开**。

### 1.4 第一次自检

让 agent 跑：

> "看看记忆索引现在的状态"

第一次会下载 ~100 MB 模型（hf-mirror）。如果 `vectorIndex.totalDocs` 是 0，跑：

> "把记忆向量库重建一下，不用等结果"

约 19 分钟。建好之后增量同步守护进程会自己维护。

### 1.5 试一下

随便问一句"之前那次 X 的笔记找一下"，agent 应该自动调 `search`。

详细测试题在 `TEST_CASES_AI_IDE_LANGFUSE.md`，详细使用指南在 `USER_TEST.md`。

---

## 2. 暴露的 11 个工具

| 工具 | 功能 |
|---|---|
| `__WORKFLOW` | 教 agent 三层检索套路：search → timeline → get_observations |
| `search` | **主检索入口**（默认 hybrid 模式：SQLite FTS + 本地向量 + RRF） |
| `search_sqlite` | 强制纯 SQLite FTS（调试 / 评测用） |
| `search_vector` | 强制纯向量 ANN（调试用） |
| `timeline` | 给定 obs ID 拿前后上下文 |
| `get_observations` | 批量按 ID 拉完整内容 |
| `get_summaries` | 批量按 ID 拉会话总结 |
| `list_projects` | 列出所有项目及条数 |
| `list_sessions` | 列会话（可按项目过滤、分页） |
| `index_status` | 自检 MCP 状态 + AgentMemory Worker 健康 |
| `reindex` | 触发本地向量库重建（首次装包用一次） |

---

## 3. 数据布局

```
~/.agentmem-hybrid-mcp/                      ← 这个 MCP 的数据
├── models/                             ← BGE-zh ONNX 模型（~100 MB，第一次自动下载）
├── vec.db                              ← sqlite-vec 向量库（~30 MB）
└── log/                                ← 可选日志

~/.agent-memory/                       ← AgentMemory 自己的目录（我们只读）
└── agent-memory.db
```

升级新版本不动用户数据。

---

## 4. 配置（环境变量，可选）

所有默认值已在评测里跑过最优，**不建议乱改**。完整列表见 `M6_DISTRIBUTE.md` §7。常用：

| env | 默认 | 说明 |
|---|---|---|
| `AGENTMEM_BASE_URL` | `http://127.0.0.1:3847` | AgentMemory Worker 地址 |
| `AGENTMEM_HYBRID_LOG_FILE` | （仅 stderr） | 写日志到文件 |
| `AGENTMEM_HYBRID_DEBUG` | `0` | 设 `1` 打开 DEBUG 日志 |
| `AGENTMEM_HYBRID_HF_ENDPOINT` | `https://hf-mirror.com` | 模型下载镜像 |

在 IDE mcp.json 里设 env：

```json
{
  "cbm-hybrid": {
    "command": "agentmem-hybrid-mcp",
    "env": {
      "AGENTMEM_HYBRID_LOG_FILE": "<你想要的日志路径>",
      "AGENTMEM_HYBRID_DEBUG": "1"
    }
  }
}
```

---

## 5. 故障排查

### 5.1 `agentmem-hybrid-mcp` 命令找不到

`npm config get prefix` 看 npm 全局根目录，把它的 bin 目录加 PATH。

### 5.2 IDE 看不到工具

终端跑 `agentmem-hybrid-mcp`，能看到 `connected via stdio` 说明命令本身没问题。问题在 IDE 没完全重启。

### 5.3 "Failed to reach AgentMemory Worker"

AgentMemory 桌面端没起。`curl http://localhost:3847/health` 验证。

### 5.4 想看完整日志

设 `AGENTMEM_HYBRID_LOG_FILE` + `AGENTMEM_HYBRID_DEBUG=1`，重启 IDE。

更详细的排错见 `M6_DISTRIBUTE.md` §6 和 `USER_TEST.md` §6。

---

## 6. 升级 / 卸载

升级：

```bash
npm i -g ./agentmem-hybrid-mcp-<new-version>.tgz
```

会覆盖装。模型缓存和向量库不丢。

卸载：

```bash
npm uninstall -g agentmem-hybrid-mcp
# 把 mcp.json 里 cbm-hybrid 那段删掉
```

可选清理本地数据（约 130 MB）：

```bash
# Windows: rmdir /S /Q "%USERPROFILE%\.agentmem-hybrid-mcp"
# Mac/Linux: rm -rf ~/.agentmem-hybrid-mcp
```

**永远不要碰 `~/.agent-memory/`**——那是 AgentMemory 自己的数据。

---

## 7. 开发者文档

| 文档 | 用途 |
|---|---|
| `PLAN.md` | 整个项目的架构、里程碑、风险 |
| `BASELINE.md` | sqlite-only 评测基线 |
| `REPORT.md` | hybrid 改造后跑同一份数据集的对比报告 |
| `USER_TEST.md` | 同事侧 IDE 挂载 + 试用指南 |
| `TEST_CASES_AI_IDE_LANGFUSE.md` | 8 道实战测试题（基于真实记忆） |
| `M6_DISTRIBUTE.md` | 维护者打包 + 同事接收的完整流程 |

### 从源码跑（仅维护者）

```bash
npm install
npm run build
node dist/server.js                    # 直接跑
```

或在 IDE mcp.json 写死路径（不可移植，只用于本地调试）：

```json
{
  "command": "node",
  "args": ["<repo-path>/dist/server.js"]
}
```

### 与 AgentMemory 解耦点

- 通过 HTTP `localhost:3847` + 只读 `~/.agent-memory/agent-memory.db` 跟 AgentMemory 通信
- **不依赖** AgentMemory 源码
- **不修改** AgentMemory 任何文件

---

## 8. License

MIT — 见 `LICENSE`
