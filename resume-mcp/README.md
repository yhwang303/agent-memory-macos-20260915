# agentmem-resume-mcp

> 给已安装 **AgentMemory（AgentMemory）桌面端**的同事，在切换 IDE 时把"项目最近做到哪了"一键灌进新会话。
>
> 核心场景：你在 Cursor 里把项目做到一半，明天换到 Claude Code 接着做。新 IDE 完全不知道之前发生过什么。把整个 AgentMemory DB 塞进上下文又会爆。
>
> 这个 MCP 暴露**一个**工具 `load_recent_context`：LLM 在新会话开始时调一次，按当前工作目录自动反查 AgentMemory，返回最近 N 条 **rolling summary**（每条附带它所在 session 的元信息 + 关键 observations），包成一段紧凑的 XML 贴进上下文。

> **从 AgentMemory v2.1.0 起，agentmem-resume-mcp 已直接打入 AgentMemory 桌面端安装包。** 装完
> `AgentMemory-Setup-*.exe` 后，命令 `agentmem-resume-mcp` 已自动注册到用户 PATH，
> mcp.json 写一行 `{ "command": "agentmem-resume-mcp" }` 即可使用，**不再需要
> 手动 `npm install -g`**。本目录是 monorepo 内 vendored 副本，构建脚本
> `desktop/scripts/prepare-resume-mcp.js` 会从此处取源码做打包；
> `npm install -g` 与 `agentmem-resume-mcp-*.tgz` 安装方式仅供调试与回退使用。

---

## 0. 这是什么

| | 没有 agentmem-resume-mcp | 有 agentmem-resume-mcp |
|---|---|---|
| 跨 IDE 接续 | 新会话从零开始，丢失全部进展 | 一句"load recent context"，LLM 立刻知道你昨天在干嘛 |
| 上下文成本 | 把整个 DB 灌进去 → 立刻爆 | 默认 ~3-4k tokens，可调 |
| 工程侵入 | — | 零改动，独立 MCP，跟 agentmem-hybrid-mcp 互不干扰 |

它**不**做的事：
- ❌ 不做语义检索（那是 `agentmem-hybrid-mcp` 的活，可以并存）
- ❌ 不写 AgentMemory 数据库（永远 readonly）
- ❌ 不会自动注入（MCP 协议不支持推送，必须 LLM 显式调用）

---

## 1. 五分钟上手

### 1.1 前置

- Node.js ≥ 18 + npm
- AgentMemory 桌面端**至少跑过一次**（这样 `~/.agent-memory/agent-memory.db` 才会存在）

### 1.2 安装

> **同事侧只需要 `agentmem-resume-mcp-0.2.0.tgz` 这一个文件**——它已经包含构建好的 dist；运行时依赖（`@modelcontextprotocol/sdk` + `better-sqlite3`）会在 npm install 时自动从 npm registry 拉取并放到全局 `node_modules` 下。**不需要源码、不需要 git clone、不需要这个 tgz 之外的任何路径。**

把 tgz 放到任意目录（比如 `~/Downloads/`），然后：

```bash
# 方式 A：cd 过去用相对路径
cd ~/Downloads
npm i -g ./agentmem-resume-mcp-0.2.0.tgz

# 方式 B：直接用绝对路径，不用 cd
npm i -g ~/Downloads/agentmem-resume-mcp-0.2.0.tgz       # Mac/Linux
npm i -g %USERPROFILE%\Downloads\agentmem-resume-mcp-0.2.0.tgz   # Windows cmd
```

验证命令到位（任意目录）：

```bash
where agentmem-resume-mcp        # Windows
which agentmem-resume-mcp        # Mac/Linux
```

### 1.3 配 IDE

在 IDE 的 `mcpServers` 里加：

```json
{
  "mcpServers": {
    "cbm-resume": {
      "command": "agentmem-resume-mcp"
    }
  }
}
```

- CodeBuddy: `~/.codebuddy/mcp.json`
- Claude Code: `~/.claude.json`
- Cursor: `~/.cursor/mcp.json` (或项目里的 `.cursor/mcp.json`)

**完全退出 IDE 再重开**。

### 1.4 第一次自检

让 agent 跑：

> "把这个项目最近的 AgentMemory 记忆拉一下"

应该看到一段 `<agentmemory_resume project="...">` 包裹的输出，里面是最近 10 条 session_summary 的快照。

如果当前目录在 AgentMemory 里没有任何记录，会看到 `isError=true` 的错误并附上"已知项目列表"——这时让 agent 显式传一个 project 参数。

### 1.5 典型用法

新 IDE 启动后，让 agent 干的第一件事：

> "我想接着这个项目继续做，先看看最近做到哪了"

或者更精确：

> "调用 load_recent_context，n=15, max_tokens=6000"

或者明确指定项目：

> "load_recent_context with project='d:/agent-memory', exclude_active=true"

---

## 2. 暴露的工具

只有一个：

### `load_recent_context`

按当前 CWD 反查 AgentMemory，返回最近若干条 **session_summary** + 每条 summary 附带的 session 元信息和 observation。

**关于"为什么是 summary 而不是 session"**：AgentMemory 里一个 session 会**滚动产生多条 summary**（典型比例 ~6:1，summary 比 session 多得多）。直接拉最近 N 条 summary 能让 LLM 看到项目状态在不同时间点的演进快照——同一个 session 的多个滚动版本可能都会出现，这是设计意图，不是 bug。

**参数**（全部可选）：

| 参数 | 默认 | 范围 | 含义 |
|---|---|---|---|
| `project` | 自动 | 字符串 | 显式 AgentMemory 项目 key，如 `d:/agent-memory`。不传时自动检测：归一化 cwd → 精确匹配 → 父目录回退（最多 5 级） |
| `n` | **10** | 1-30 | 取最近 N 条 session_summary（newest-first；已自动过滤完全为空的 summary） |
| `max_tokens` | 4000 | 500-16000 | 内容上限的字符级估算。超出会触发渐进式裁剪 |
| `obs_per_summary` | 3 | 0-10 | 每条 summary 附带几条 observation。0 = 仅 summary 主体 |
| `exclude_active` | false | 布尔 | true 时跳过 originating session 状态为 `active` 的 summary（通常就是当前正在调用的那次） |

**返回示例**（XML 包裹 + 内嵌 markdown）：

```xml
<agentmemory_resume project="d:/agent-memory" loaded_at="2026-06-01T07:00:00Z" summaries="10" tokens_est="2690" match="cwd">
  <hint>The following are the most recent AgentMemory rolling summaries for this project ...</hint>
  <summary id="687" created="2026-06-01T06:13:00Z" session_id="109" session_status="completed">
    <prompt>没事，还有就是混合的recall 10才只有26.91%吗，这个数据会不会有点低了？...</prompt>
    <body>
      Request: 用户想确认混合检索的 Recall@10 是否偏低 ...
      Investigated: 调研了业界混合检索基线 ...
      Learned: ... 主要瓶颈不在融合策略本身 ...
      Completed: 完成了混合检索效果调研 ...
      Next steps: 先做一次重排模型的小规模验证 ...
    </body>
    <observations>
      - [investigation] 完成混合检索效果调研并给出优化优先级建议 — ...
    </observations>
  </summary>
  <!-- 9 more summaries, oldest last; multiple snapshots of the same session may appear -->
</agentmemory_resume>
```

**裁剪可见性**：当 `max_tokens` 不够时，根标签会出现 `truncated="narrative_to_300,drop_observation_detail"` 这种属性，告诉 LLM 哪些层级被压缩，必要时它可以让用户调高 `max_tokens` 重试。

---

## 3. 数据布局

只读 AgentMemory 主库 `~/.agent-memory/agent-memory.db`：

| 表 | 用途 |
|---|---|
| `session_summaries` | **主锚点**：最近 N 条按 created_at_epoch 倒序取 |
| `sdk_sessions` | 给每条 summary 附 user_prompt / status / source_ide |
| `observations` | 细粒度笔记，按 `memory_session_id` 关联到每条 summary 所属 session |

**项目识别**：AgentMemory 把项目存成小写正斜杠路径（`d:/agent-memory`）。本工具会把 `process.cwd()` 归一化后精确匹配；不命中则向上找父目录最多 5 级；都不命中则报错并附上已知项目列表。

---

## 4. 配置（环境变量，可选）

| 变量 | 默认 | 含义 |
|---|---|---|
| `AGENTMEM_RESUME_DB_PATH` | `~/.agent-memory/agent-memory.db` | 显式指定 AgentMemory 主库路径（迁移过 / 多用户场景下用得上） |
| `AGENTMEM_RESUME_LOG_FILE` | 未设置 | 设置后日志同时写到该文件（始终也会写 stderr） |
| `AGENTMEM_RESUME_DEBUG` 或 `DEBUG` | 未设置 | 任一为真启用 DEBUG 级日志 |
| `AGENTMEM_RESUME_DEFAULT_N` | 10 | 工具默认 N |
| `AGENTMEM_RESUME_DEFAULT_MAX_TOKENS` | 4000 | 工具默认 max_tokens |
| `AGENTMEM_RESUME_DEFAULT_OBS_PER_SUM` | 3 | 工具默认 obs_per_summary（旧名 `AGENTMEM_RESUME_DEFAULT_OBS_PER_SES` 仍兼容） |

---

## 5. 故障排查

### 5.1 "AgentMemory main DB is not available"

- `~/.agent-memory/agent-memory.db` 不存在 → AgentMemory 桌面端没装或没启动过
- 自定义路径错误 → 检查 `AGENTMEM_RESUME_DB_PATH`
- 文件存在但权限不对 → 看 stderr 日志的具体错误

### 5.2 "Could not resolve a AgentMemory project for cwd"

含义：当前目录及其上 5 级父目录都不在 AgentMemory 已知项目列表里。

排查：
1. 看错误信息里的 `Known AgentMemory projects`，确认你预期的项目是否在里面
2. 在该项目里**实际开过 IDE 会话**了吗？AgentMemory 是按"产生过会话"建项目记录的
3. 实在不行，调用时传 `project="d:/your-project"` 显式指定

### 5.3 "Tool returned empty result"

- 该项目下确实没有最新 summary 满足条件
- 试试传 `n=20, exclude_active=false, obs_per_summary=5` 放宽

### 5.4 输出被截断（attribute 里有 `truncated=`）

- 调高 `max_tokens`（最多 16000）
- 或减小 `n` / `obs_per_summary`
- truncated 列表的语义见 `src/tokenBudget.ts` 顶部注释

### 5.5 重启 IDE 后 MCP 没出现

- 检查 `mcpServers` 里 command 拼对了（是 `agentmem-resume-mcp`，不是 `cbm-resume`）
- 命令行直接跑 `agentmem-resume-mcp` 看 stderr 有没有报错（应该挂在等 stdio 输入，Ctrl+C 退出）
- 看 IDE 自己的 MCP 启动日志

---

## 6. 升级 / 卸载

```bash
# 升级
npm i -g ./agentmem-resume-mcp-<new-version>.tgz

# 卸载
npm uninstall -g agentmem-resume-mcp
```

不会动 `~/.agent-memory/`（那是 AgentMemory 自己的数据，跟本工具完全无关）。

---

## 7. 开发者文档

- 技术细节、SQL 写法、架构决策见 `C:\Users\milkwang\.claude-internal\plans\scalable-imagining-octopus.md`（plan 文件）
- 同事分发流程见 `M6_DISTRIBUTE.md`
- 单元自检：`npm run handshake` 跑端到端 stdio 握手
- 真实命中烟测：`node scripts/smoke-real-project.mjs d:/your-project 5`

构建：

```bash
npm install
npm run build         # tsc → dist/
npm run dev           # tsx 直跑（开发期）
npm run handshake     # 黑盒 JSON-RPC 握手测试
npm pack              # 打 .tgz
```

---

## 8. License

MIT
