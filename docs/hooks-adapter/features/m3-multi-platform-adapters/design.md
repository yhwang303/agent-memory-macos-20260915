# M3 · 新平台批量接入

**里程碑**：M3（路线图第 3/5 步）
**工作量**：~10 个工作日
**前置**：M1（transcript-based 类目复用解析器）
**后继**：M5 收尾

---

## 1. 问题陈述

agent-memory 目前支持 5 个 IDE：Cursor / Claude Code / Claude Internal / CodeBuddy / CodeBuddy IDE。

claude-mem v12.3.8 新增了 8 个 IDE + 升级版 Cursor。本里程碑把它们全部接入 agent-memory。

## 2. 目标矩阵

| # | 平台 | ID | 接入机制 | claude-mem 已有参考 | 工作量 |
|---|---|---|---|---|---|
| 1 | Gemini CLI | `gemini-cli` | hooks + transcript | ✅ `GeminiCliHooksInstaller.ts` | 1d |
| 2 | OpenCode | `opencode` | plugin-based | ✅ `OpenCodeInstaller.ts` + `src/integrations/opencode-plugin/` | 1d |
| 3 | Windsurf | `windsurf` | hooks | ✅ `WindsurfHooksInstaller.ts` | 1d |
| 4 | Codex CLI | `codex-cli` | transcript-based | ✅ `CodexCliInstaller.ts` | 1d |
| 5 | Cursor 升级 | `cursor` | hooks + MCP + context 注入 | ✅ `CursorHooksInstaller.ts` + `cursor-hooks/` 资源 | 1d |
| 6 | Copilot CLI | `copilot-cli` | MCP | ✅ `McpIntegrations.ts` | 0.5d |
| 7 | Antigravity | `antigravity` | MCP | 同上 | 0.5d |
| 8 | Goose | `goose` | MCP | 同上 | 0.5d |
| 9 | Crush | `crush` | MCP | 同上 | 0.5d |
| 10 | Roo Code | `roo-code` | MCP | 同上 | 0.5d |
| 11 | Warp | `warp` | MCP | 同上 | 0.5d |
| — | **通用 Installer 层** | — | — | — | 2d |
| — | **IDE 自动检测** | — | — | ✅ `ide-detection.ts` | 0.5d |

**合计约 10 天。**

## 3. 三类接入模板

### 3.1 Hooks-based（cursor / windsurf / gemini-cli / opencode）

与现有 Cursor 适配器同构：IDE 提供 hook 事件，agent-memory CLI 作为脚本被调用。

**产物**：
- `src/adapters/<id>.ts`：声明 `SUPPORTED_EVENTS` / `HOOKS_EVENTS` / `mapEventName` / `normalizeInput`
- `src/services/integrations/<Id>HooksInstaller.ts`：写 `hooks.json` / 配置文件
- `tests/adapters/<id>.test.ts`

### 3.2 Transcript-based（claude-code 升级 + codex-cli）

IDE 不提供 `afterAgentResponse` 事件，但把对话写入 transcript 文件。策略：复用 M1 产出的 `readLastAssistantMessage`，在对应触发点（Stop hook / 周期扫描）读取。

**Claude Code**：M1 已覆盖（Stop + PreCompact 读 `transcript_path`）。

**Codex CLI**：
- Transcript 路径：`~/.codex/sessions/*.json`
- 无 hook 机制，采用 **chokidar 文件监听 + agent-memory daemon 周期扫描**
- 每次 session 文件落盘 → 调 `readLastAssistantMessage` → 录入 `agent_response` observation → 触发 summarize

**产物**：
- `src/adapters/codex-cli.ts`：声明 transcript watcher 配置
- `src/services/integrations/CodexCliInstaller.ts`：注册路径到 daemon
- 复用 M1 的 parser，不新增解析逻辑

### 3.3 MCP-based（copilot-cli / antigravity / goose / crush / roo-code / warp）

这 6 个 IDE 不开放 hook，但都支持 MCP。策略：把 agent-memory 的 MCP server 注册进它们的配置文件，让 IDE 内部的 Agent 主动调 `search` / `timeline` 工具。**不抓事件**，只做**被动查询端**。

**产物**：
- `src/services/integrations/McpIntegrations.ts`：统一的 MCP 配置写入器，支持 6 种配置文件格式
- 每个 IDE 一个小的 `mcpConfigPath` 常量

## 4. 通用 Installer 架构

```
src/services/integrations/
  ├── index.ts
  ├── types.ts
  │     export interface Integration {
  │       id: string;
  │       displayName: string;
  │       detect(): Promise<boolean>;
  │       install(opts): Promise<InstallResult>;
  │       uninstall(): Promise<void>;
  │       status(): Promise<IntegrationStatus>;
  │     }
  ├── CursorHooksInstaller.ts
  ├── WindsurfHooksInstaller.ts
  ├── GeminiCliHooksInstaller.ts
  ├── OpenCodeInstaller.ts
  ├── CodexCliInstaller.ts
  ├── McpIntegrations.ts       ← 6 合 1
  └── OpenClawInstaller.ts     ← 仅声明，具体由 M4 落地
```

CLI 入口：

```
agent-memory install          # 自动检测 + 交互选择
agent-memory install --all    # 安装所有已检测到的
agent-memory install cursor windsurf codex-cli
agent-memory status           # 列出每个 IDE 的集成状态
agent-memory uninstall <id>
```

## 5. IDE 自动检测（ide-detection.ts）

移植 `claude-mem/src/npx-cli/commands/ide-detection.ts`，适配 agent-memory。

检测策略（复用 claude-mem 13 平台表）：
- 文件/目录存在性（`~/.claude`、`~/.cursor`、`~/.codex` ...）
- `which` / `where` 命令查找二进制
- VS Code 扩展目录扫描（antigravity / goose）

## 6. Cursor 升级（原地增强）

现有 `src/adapters/cursor.ts` 已是 hooks-based，升级内容：

1. **引入 MCP 注册**：把 agent-memory MCP server 写入 `~/.cursor/mcp.json`
2. **Context 注入**：通过 Cursor 的 `cursorrules` 机制，把 M2 的 `/api/context/inject` 内容注入 rules
3. **`cursor-hooks/` 资源包**：移植 claude-mem 的 hooks 脚本模板（`session-init.sh`、`context-inject.sh` 等）
4. **升级 `CursorHooksInstaller.ts`**：支持版本化的 hooks.json 升级

## 7. 文件清单（节选，完整见 plan 阶段）

| 类目 | 文件数 |
|---|---|
| 新增 adapter | 10（9 个新 IDE + cursor 升级） |
| 新增 installer | 7（含 McpIntegrations 一个覆盖 6 个 MCP IDE） |
| 新增 tests | ~20 |
| 配置 fixture（hooks.json 模板 / MCP 配置模板） | ~15 |
| CLI 入口 `src/cli/install.ts` | 1 |

---

## 8. 测试计划

### 8.1 单元

每个 adapter：
- `normalizeInput` 的各 event 分支
- `mapEventName` 双向映射
- `generateHooksConfig` 输出格式

每个 installer：
- 检测逻辑
- 写入文件后 diff

### 8.2 Smoke test 矩阵（手工 + 脚本）

| IDE | 动作 | 预期 |
|---|---|---|
| Cursor | 安装 hooks + 跑一次对话 | observations 表有新记录；MCP search 可调用 |
| Windsurf | 同上 | 同上 |
| OpenCode | 安装 plugin + 跑一次 | 同上 |
| Gemini CLI | 安装 hooks | 同上 |
| Codex CLI | 跑一次，扫一次 transcript | 有记录 |
| Copilot CLI | 写入 MCP 配置，打开 Copilot | IDE 能列出 agent-memory 工具 |
| Antigravity | 同上 | 同上 |
| Goose | 同上 | 同上 |
| Crush | 同上 | 同上 |
| Roo Code | 同上 | 同上 |
| Warp | 同上 | 同上 |

### 8.3 跨平台

每个 installer 的路径拼接在 Windows / macOS / Linux 三平台各跑一次（CI matrix）。

---

## 9. 非目标

- 不深度集成未开放事件 API 的 IDE（只做 MCP 被动）
- 不实现 IDE 间的会话跨项目同步
- 不为 IDE 插件做 UI

---

## 10. 风险

| 风险 | 缓解 |
|---|---|
| 各 IDE 配置格式变更 | installer 版本化，打 warning 不强制覆盖 |
| VS Code 扩展 ID 改名（antigravity / goose） | 检测用模糊匹配 `includes` |
| 6 个 MCP IDE 的配置路径差异 | 集中到一份表，加单测锁定 |
| Windows 路径大小写问题 | 统一 `path.normalize` + `toLowerCase` 比较 |
| 安装器写入用户配置文件有破坏性 | 写入前备份到 `~/.agent-memory/backups/<timestamp>/` |

---

## 11. 验收标准

- [ ] 11 个 IDE（原有 5 个 + 新增 6 个）在各自平台跑通 smoke test
- [ ] `agent-memory install --all` 在装了所有 IDE 的机器上 1 次成功
- [ ] `agent-memory status` 列出所有检测到的 IDE 和集成状态
- [ ] 卸载后恢复用户配置文件为集成前状态
- [ ] Windows / macOS / Linux CI 全绿

---

*下一里程碑：M4 OpenClaw 网关插件。*
