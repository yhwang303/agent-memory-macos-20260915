# claude-mem 集成 · 待办与需用户确认事项

> 这是一份"需人类决策或后续手动执行"的清单。Claude 自动推进 M1–M5 过程中遇到的任何需要用户实际参与的事项都记在这里。
>
> 按里程碑分组，最新加到对应章节顶部。

---

## 跨里程碑共性

### [ ] 预装 Python + uv（M2 RAG 依赖）
Chroma 向量库通过 `chroma-mcp` (Python) 运行，需本地存在 `uv`。
- Windows: `winget install --id=astral-sh.uv -e`
- macOS/Linux: `curl -LsSf https://astral.sh/uv/install.sh | sh`

不装也能跑 M2（自动降级到 FTS5-only 模式），但 RAG 功能不可用。

### [ ] 预留约 2 GB 磁盘用于中文 embedding 模型（M2）
默认 `bge-m3` 首次启动自动下载到 `~/.config/agent-memory/models/`。可在 `settings.json` 覆盖为 `paraphrase-multilingual-MiniLM-L12-v2`（更小，精度略低）。

---

## M1 · 图片语义修复

### [ ] T11 手工回归（需真实 IDE）
10 组含图片的真实会话，人工打分 summary 是否命中图片内容。
- 5 组 Claude Code
- 3 组 Claude Internal
- 2 组 CodeBuddy IDE（注：当前 codebuddy-ide 被 `claude-` prefix 门控过滤掉，这 2 组预期不会走 transcript 路径；见下面"待确认"条目）
- 目标：≥ 8/10 命中
- 报告模板：`docs/superpowers/reports/m1-regression-<date>.md`

执行完后反馈通过/失败，如果 < 8/10 再回到对应 Task 排查。

### [ ] 待确认：codebuddy-ide 是否应该解除 `claude-` prefix 门控？
目前 `adapterEmitsTranscript` 只匹配 `claude-*`，codebuddy-ide 即便注入 `transcript_path` 也不会被读取。
- 如果 CodeBuddy IDE 发送的是 Claude Code JSONL 格式 → 应该把 codebuddy-ide 加进门控（改一行）
- 如果格式不同 → 保持现状，未来单独为 CodeBuddy IDE 写一个解析分支
- **请确认 CodeBuddy IDE 的 transcript 文件格式**（看 `~/.codebuddy` 下是否有 JSONL，内容结构是什么）

### [ ] 待确认：pre-existing viewer-api 测试失败是否影响 PR
2 条 `tests/viewer-api.test.ts` 失败在合并前就存在于 master：
- `should have required UI elements`
- `should have all required API endpoint calls`
可选项：(a) 不管（与 M1 无关）(b) 修掉，合入时顺便带上 (c) 标记为 skip。

---

## M2 · RAG + SQLite 双重查询

### [ ] 确认：CI 是否预装 uv + bge-m3 模型？
目前 M2 集成测试（`tests/e2e/m2-search-integration.test.ts`）在 uv 未安装时自动 skip。如果想让 CI 真的跑向量查询回归：
1. CI runner 安装 uv（Linux: `curl -LsSf https://astral.sh/uv/install.sh | sh`）
2. 预下载 bge-m3（~2 GB）到 `~/.cache/huggingface` 或 `$MODEL_CACHE_DIR`

只做本地回归的话不用改 CI。

### [ ] 手工验证：Chinese recall 目标
spec §5.2 要求 hybrid 相对纯 FTS5 top-5 recall 提升 ≥ 20%。集成测试 body 目前 skip，需要在本地：
1. 灌 100 条中文 observation（可用最近真实会话导出）
2. 对 10 个典型查询分别跑 hybrid 和 sqlite 两种模式
3. 人工判分命中率
报告模板建议：`docs/superpowers/reports/m2-recall-<date>.md`

### [ ] 决策：Per-project Chroma collection 命名
当前 `WorkerService.initChroma` 硬编码 `project='default'` 创建单一 collection。多项目场景下需要按 project 拆。
选项：
- A. 启动时预先为所有已知项目创建 collection
- B. 懒加载：查询时按 project 动态 `ensureCollection`
- C. 单一 collection + metadata 过滤（claude-mem 当前做法，简单但向量质量略降）

建议 B。

### [ ] 待填：T15 集成测试 body
`tests/e2e/m2-search-integration.test.ts` 目前只做 uv 检测 + `t.skip`。在 bge-m3 模型本地缓存好之后，可以把真实流程补上：spawn ChromaProcessManager → connect mcp → 灌 100 条 fixture → bulkReindex → 跑 3 种 mode → 断言 Chinese 命中。参考 `claude-mem/tests/integration/chroma-vector-sync.test.ts`。

---

## M3 · 多平台适配器

### [x] 4 个 hooks-based 适配器：Windsurf, Gemini CLI, OpenCode, Codex CLI
全部实现并通过单元测试（54 tests）。适配器已注册到 registry。

### [x] Cursor adapter 升级 + transcript gate 扩展
`normalizeInput` 支持 `stop` 事件的 transcript 合并。`adapterEmitsTranscript` 从前缀匹配改为 Set 查找，新增 cursor/gemini-cli/codex-cli/opencode。

### [x] McpIntegrations（6 个 MCP-only 平台）
Copilot CLI, Antigravity, Goose, Crush, Roo Code, Warp — 统一 `McpPlatform` 表 + 配置生成。

### [x] Registry + hooks-cli 更新
9 个适配器注册（按优先级排序），8 个 handler 的 projectPath 环境变量链扩展。

### [x] IDE 自动检测（15 平台）
`ide-detection.ts` 支持 config_dir + binary 两种检测方式。

### [x] 安装器层（BaseHooksInstaller + 5 installers）
通用基类 + 4 个 hooks 薄包装 + CodexCli（transcript/MCP-only）。

### [x] CLI install/status/uninstall 命令
`src/cli/install.ts` 支持 `install [--all | <id>...]`、`status`、`uninstall <id>...`。

### [ ] 待办：npm 分发配置
Linux 下的 npm 全局安装（`npm i -g agent-memory`）需要补充 `bin` 字段到 `package.json`。归入 M5 一起处理。

### [ ] 待办：MCP-only 平台的 installer 实现
当前 6 个 MCP-only 平台只有配置表和生成逻辑（`McpIntegrations`），尚未有独立的 `Integration` 实现。可在 M5 打包阶段补充或按需延后。

### [ ] 待验证：各 IDE 配置路径真实性
适配器中的 configDir / hooksConfigFile / mcpConfigFile 基于文档推测。需在真实安装环境中确认：
- Windsurf: `~/.windsurf/hooks.json`
- Gemini CLI: `~/.gemini/settings.json`
- OpenCode: `~/.opencode/settings.json`
- Codex CLI: `~/.codex/mcp.json`

---

## M4 · OpenClaw 网关插件

### [x] Worker 新端点
- `/api/session/complete` — 关闭 session
- `/api/readiness` — 深度就绪检查
- `/stream` — SSE observation/summary 实时推送

### [x] Observation EventEmitter
WorkerService 内部 eventBus，observation/summary 写入后 emit

### [x] OpenClaw 插件（5 hooks + 3 channels + SSE consumer）
- beforeAgentStart → POST /api/session/start
- beforePromptBuild → GET /api/context/inject (60s LRU)
- toolResultPersist → POST /api/observation
- agentEnd → POST /api/summary + /api/session/complete
- gatewayStart → poll /api/readiness (30 retries)
- Telegram / Discord / Slack channel adapters
- ObservationFeed SSE consumer with exponential backoff

### [x] OpenClaw Installer + config-schema.json

### [ ] 待验证：真实 OpenClaw dev gateway 集成测试
需要搭建 OpenClaw dev 环境，验证 5 轮对话后的 observation 写入、context inject 返回、SSE 订阅。

### [ ] 待验证：Telegram/Discord/Slack 端到端推送
需要配置真实 bot token / webhook URL 测试。

---

## M5 · 运行时迁移 + AGPL + 打包

### [x] Bun API 检查
`scripts/check-no-bun.js` 确认 src/ 中无 Bun.*/bun:/import.meta.main 用法。零命中。

### [x] AGPL-3.0 许可证切换
- `LICENSE` — AGPL-3.0 全文引用
- `NOTICE` — 声明 claude-mem 来源
- `package.json` license 字段改为 `AGPL-3.0-only`
- `scripts/add-license-header.js` — 批量加文件头脚本（就绪，未执行）

### [x] 统一 CLI 入口 (`src/cli.ts`)
支持 install/status/uninstall/doctor/version 命令。`agent-memory` 和 `agent-memory` 双 bin 入口。

### [x] pkg 打包配置
`package.json` 增加 `pkg` 字段（targets: win/mac/linux x64）。

### [x] CI/CD
- `.github/workflows/ci.yml` — push/PR 自动测试
- `.github/workflows/release.yml` — tag 触发三平台构建 + GitHub Release

### [x] Migration 文档 + README 更新
- `docs/MIGRATION.md` — 升级指南、RAG 配置、从 claude-mem 迁移
- README 更新：AGPL 标识、13 平台 IDE 列表

### [ ] 待执行：源文件 license header 批量注入
`npm run license:headers` — 就绪但未执行（会修改所有 .ts 文件）。建议合入 master 前执行。

### [ ] 待验证：.exe 冷启动
需要在干净 Windows 机器上测试：`npx @yao-pkg/pkg .` 产出的 .exe 是否可冷启动。

### [ ] 待购：代码签名证书
Windows SmartScreen 告警需要 EV 证书。

---

## 已解决（存档）

_（决策敲定后从上方移到这里）_
