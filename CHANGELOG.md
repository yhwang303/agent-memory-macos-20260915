# Changelog

所有版本的变更记录。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)。

---

## [2.0.22] - 2026-06-09

### 修复
- **对话型 observation 同会话内被误判为 duplicate 而丢弃**（Codex/Stop 钩子尤甚）：`computeSignature` 此前对所有事件都按 `toolInput` 计算签名，而 `agent_response` / `agent_thought` 的 `toolInput` 恒为 `{}`、内容只在 `toolOutput`，导致同一会话内每轮回复签名完全相同，从第二轮起被分类器在 **Tier 0（duplicate）** 阶段直接 DROP，根本进不到 Tier 2 兜底——表现为「多条 summary 只对应一条 observation」。现这两类事件改用 `toolOutput` 计算签名，不同回复得到不同签名，正常入库。

---

## [2.0.21] - 2026-06-08

### 维护
- 版本号递增并重新出包（含 2.0.20 的 Tier 2 必定落库修复），无新增功能改动。

---

## [2.0.20] - 2026-06-08

### 修复
- **Tier 2 observation 被 LLM 静默丢弃**：此前 Tier 2 若 LLM 返回 skip / 无有效结果则不入库，导致 Codex（仅 Stop 钩子、每轮仅一条 `agent_response`，走 Tier 2）观测大量丢失。现 Tier 2 必定落库：LLM 跳过时改用确定性兜底记录（`formatTrace` 标题/facts + 原文 narrative，截断 5000 字），不再由 LLM 决定是否记录。

---

## [2.0.19] - 2026-06-08

### 新增
- **记录来源 IDE（`source_ide`）**：observation / summary / session 三张表落库时写入来源 IDE 的原始 adapter id（如 `cursor` / `codex-cli` / `claude-code` / `gemini-cli` / `codebuddy-ide` / `openclaw`），修复此前该字段恒为 `NULL` 的问题。
  - **数据流**：值的唯一原点是 hook（`resolveSourceAdapter().id`），随 `addObservation` / `initSession` 透传到 worker，observation 行直接落库；summary 生成时按「最后一条非空 observation → session 行兜底 → `NULL`」派生同一值。该模型不依赖 session，便于后续弃用 session。
  - **远端同步**：summary 的同步 payload 由原先写死的 `''` 改为透传实际 `source_ide`。
  - 解析不出 IDE 时存 `NULL`（不存空串）；历史行不回填，保持 `NULL`。
  - 取值逻辑抽为可单测的纯函数 `resolveSourceIdeForSummary`。

### 修复
- **summary 的 `source_ide` 时有时无（异步竞态）**：observation 为后台异步处理（worker 收到即返回 200，LLM 蒸馏在后台跑），而 `summarizeSession` 紧随其后触发，导致 summary 反推 `source_ide` 时常读不到本轮 observation；复用长会话的 Codex 尤其频繁。现将 hook 已知的权威 `sourceIDE` 透传至 summary 生成，取值优先级改为 **hook hint → 末条非空 observation → session 兜底 → NULL**，彻底消除竞态。

### 版本
- 根 `package.json` + `desktop/package.json`：`2.0.18` → `2.0.19`

---

## [2.0.18] - 2026-06-06

### 修复
- **Windows 中文环境钩子不记录（JSON 解析失败）**：根因是 Cursor 在 Windows 上经 PowerShell 管道（`$input | cmd /c ...`）投递钩子负载，cp936 中文系统会把 Cursor 的 UTF-8 字节按 cp936 解码成乱码并有损丢字，使 `beforeSubmitPrompt` 解析失败、会话从未建立，后续所有 observation/summary 全部 404。
  - **UTF-8 BOM 兜底剥离**：切换系统 UTF-8 locale 后 PowerShell 会在数据头部加 BOM，导致 `JSON.parse` 报 `Unexpected token '﻿'`。现在在字节层（`EF BB BF`）与字符串层（`U+FEFF`）双重剥离 BOM，确保解析不受影响。
  - **会话懒创建**：worker 收到未知 session 的 observation 时，若钩子携带 `projectPath` 则即时补建会话（幂等），使 `stop` 钩子能从磁盘上干净的 UTF-8 transcript 文件正确记录中文内容与摘要——即便 `beforeSubmitPrompt` 因编码丢失而漏建会话。`addObservation` 上送 `projectPath`。
  - **UTF-8↔GBK 双重编码修复兜底**：解码全部失败时尝试还原非有损的双重编码乱码（纯增量，正常输入零影响）。
  - 解码逻辑抽出为可单测的纯模块 `decodeHookInput`。

### 版本
- 根 `package.json` + `desktop/package.json`：`2.0.17` → `2.0.18`

---

## [2.0.17] - 2026-06-05

### 改进
- **DeepSeek 模型下拉更新为 V4 正式型号**：设置页 DeepSeek 可选模型由即将下线的旧别名 `deepseek-chat` / `deepseek-reasoner`（2026/07/24 停用）替换为当前正式模型 `deepseek-v4-pro`（高级·强推理）/ `deepseek-v4-flash`（中级·快而省）。

### 版本
- 根 `package.json` + `desktop/package.json`：`2.0.16` → `2.0.17`

---

## [2.0.16] - 2026-06-05

### 修复
- **会话摘要 `request` 字段长期重复（"用户想确认最新版本是否正常"）**：根因是摘要的 `request` 仅来自 `session.user_prompt`，而该字段以往只在 `UserPromptSubmit → initSession` 时刷新；当 Cursor 等 IDE 漏触发 `UserPromptSubmit`（`Stop` 仍正常触发）时，`user_prompt` 会冻结在早期某条请求，导致同一长会话内每条摘要的 request 都一样。现在在 `Stop` 钩子的 transcript 处理器中，用当轮最新用户消息回填 `user_prompt`（Cursor 与 CodeBuddy IDE 两条路径），与 `UserPromptSubmit` 是否触发解耦。`updateSessionField` 白名单新增 `user_prompt`。

### 新增
- **MCP 查询结果证据持久化**：`observations` 表新增 `evidence` 列（不进 FTS、不进默认召回注入），仅对 MCP 事件保存原始查询结果全文（单条上限 100KB，超出截断标记），Tier 1 与 Tier 2 均落库，供事后溯源/钻取。新增纯函数 `extractMcpEvidence`。

### 版本
- 根 `package.json` + `desktop/package.json`：`2.0.15` → `2.0.16`

---

## [2.0.15] - 2026-06-04

### 新增
- **Observation 分档蒸馏（Tiering）**：在服务端 `processObservation` 调用 LLM 之前，用确定性分类器 `ObservationClassifier` 把每个钩子事件分三档——Tier 0 直接丢弃（空命令、图片/二进制/截图 file_edit、空 agent_response、MCP 空结果、会话内重复等）；Tier 1 用 `TraceFormatter` 模板留痕、零 LLM（只读命令、打包成功、无 diff 的真实文件编辑、MCP 只读查询、极短回复）；Tier 2 才调 LLM 精写，并按价值在高级模型（写文档/报错/agent 回复）与中级便宜模型（普通源码编辑/MCP 业务结果/打包失败）间分流。
  - 改写蒸馏 prompt 根除套话（删"几乎全记"段、narrative 改为"做了/发现了/决定了什么及结果"、facts 收紧），高级/中级共用同模板。
  - `observations` 表新增 `tier`（默认 2，旧数据零影响）与 `signature`（会话内去重）列；默认记忆召回只取 Tier ≥2，不足时用 Tier 1 trace 兜底；显式检索仍可命中 trace。
- **高级/中级模型独立服务商 + 按服务商管理 API Key**：设置页高级模型与中级模型可各自选择服务商（TIMIAI / DeepSeek / OpenAI / Anthropic）与型号；API Key 改为按服务商存储，UI 只显示当前在用服务商的 Key 输入框（去重）。worker 侧新增中级模型独立 endpoint/key 路由（`CODEBUDDY_MEM_LIGHT_ENDPOINT` / `CODEBUDDY_MEM_LIGHT_API_KEY`），中级未配置时回退到高级通道。旧单 Key 配置自动迁移到对应服务商。

### 版本
- 根 `package.json` + `desktop/package.json`：`2.0.14` → `2.0.15`

---

## [2.0.14] - 2026-06-04

### 新增
- **DeepSeek 服务提供商**：设置页新增 DeepSeek 选项，模型支持 `deepseek-chat` / `deepseek-reasoner`，自动切换官方端点 `api.deepseek.com`（OpenAI 兼容，密钥走 OpenAI 槽位）。
- **Tier 2 中级模型可配置**：设置页新增"中级模型（便宜 · Tier 2 普通蒸馏）"下拉，配置项 `apiModelLight` 透传为 `CODEBUDDY_MEM_MODEL_LIGHT`（留空回退到主模型），为后续分档蒸馏预留模型路由。

### 改进
- **模型下拉刷新为实测可用列表**（TimiAPI）：`gpt-5.5 / gpt-5.4 / gpt-5 / gpt-4o / gpt-4o-mini / claude-sonnet-4.6 / claude-opus-4.6`，并明确主模型为"高级 · 精写蒸馏"。

### 移除
- **设置页"测试连通性"按钮**及其 IPC/preload/`connectionTester` 相关逻辑。

### 版本
- 根 `package.json` + `desktop/package.json`：`2.0.13` → `2.0.14`

---

## [2.0.13] - 2026-05-29

### 新增
- **Injector · 规范注入器插件**：把内置 Skills / Rules / MCP / 规范文件按目标 IDE 一键注入到任意项目。
  - 内置内容库（`library/` + `catalog.json`），首个官方 bundle `shadow-harness`（文档范式 + 注册中心 + 门禁 + 任务认领 + 配套 skills/rules，原子整套注入）。
  - 多 IDE 落点解析（Cursor / Claude Code / CodeBuddy / Codex CLI），按 2026 各家真实约定分流：Codex skill 落 `.agents/`、rule 写 `CLAUDE.md`/`AGENTS.md` 受管块、CodeBuddy 用 `RULE.mdc` 文件夹、mcp JSON/TOML 分流。
  - 依赖与完整性：`requires` 传递闭包 + `standalone` 体系组件标记 + `atomic` 原子 bundle，杜绝注入半残体系。
  - 幂等注入引擎（overwrite / managed-block / json-merge / skip-if-exists）+ 注入账本（ledger）支持预览、更新与卸载还原。
  - viewer 新增「Injector」注入页；设置页新增启用卡片；6 个 snake_case MCP 工具（`injector_list/detect_ides/status/preview/inject/uninstall`）。
- **研发 harness 全套**：文档范式（`docs/README.md`）、研发总纲（`docs/HARNESS.md`）、需求注册中心看板 + SSOT 种子、门禁与任务认领 skills/rules。
- **Codex CLI 桌面关联**：设置与首次向导中检测 `~/.codex`，可一键关联；写入 `hooks.json`（仅 Stop，30s 超时）与 `mcp.json`；使用安装包内置 `node` / `hooks-cli` / `mcp-server` 及 `~/.agent-memory/hooks` 代理脚本（Windows + macOS）。
- **Codex transcript**：Stop hook 经 `codex-cli` 适配器优先识别（`turn_id` 等字段），从 `transcript_path` 录入观察并触发会话总结。

### 修复
- **Codex Stop hook 信任**：安装和桌面注册时写入 Codex hook trust state，Stop-only 场景会先初始化 session，避免真实 Codex 会话结束后因未信任或 session 缺失而不记录。
- **PreToolUse shell hook 因命令字段嵌套导致崩溃**：Claude Code / CodeBuddy IDE 把 shell 命令放在 `tool_input.command` 下，而旧逻辑只读取顶层 `input.command` 并直接 `.toLowerCase()`，命令缺失时抛 `TypeError`，在 IDE 侧表现为「hooks 不触发」。现在 `command` 改为可选并兼容 `tool_input.command`，用 `String(... ?? '')` 兜底，避免空命令崩溃。

### 改进
- **CLI 安装器**：`codex-cli` 改为 hooks 机制，安装时写入 Stop hook 与 MCP 配置。
- **ShadowFolk 推送按本地作者过滤 git 提交**：自动推送时应用 `git --author` 过滤（取仓库 `user.email/name`），避免在共享分支上把他人的提交一并上传。新增 `src/services/shadowfolk/gitAuthorFilter.ts` 及回归测试。

### 版本
- 根 `package.json` + `desktop/package.json`：`2.0.12` → `2.0.13`

---

## [2.0.12] - 2026-05-26

### 新增
- **检查更新功能**：客户端启动后自动检查官网发布服务器最新版本，发现更新弹出系统通知并可跳转下载；托盘菜单新增"检查更新"手动入口。
- **Self-Evolve 存量管理**：Overview 页面新增 Rules/Skills 存量列表，支持开关启用/归档切换，展开查看详情，IDE 芯片多选写入。
- **Self-Evolve 增量进化调度**：基于观察条数、主题切换和空闲超时自动触发增量进化，支持状态持久化与重启恢复。
- **插件动态注册**：viewer 页面根据插件启用状态动态显示/隐藏 Tab 入口。

### 改进
- **插件卡片展开按钮**：展开/收起箭头从标题行右侧移到卡片正下方居中，交互更清晰。
- **插件启用开关防换行**：修复长描述文字挤压开关导致换行的布局问题。

### 版本
- 根 `package.json` + `desktop/package.json`：`2.0.11` → `2.0.12`

---

## [2.0.11] - 2026-05-23

### 改进
- **插件卡片折叠交互**：服务器同步等插件卡片默认折叠，仅显示标题与启用开关；点击标题区域可展开/收起，箭头旋转反映状态；开关与折叠逻辑解耦，互不干扰；邀请链接触发时自动强制展开。

### 版本
- 根 `package.json` + `desktop/package.json`：`2.0.10` → `2.0.11`

---

## [2.0.10] - 2026-05-14

### 修复
- **ShadowFolk 上次同步时间重启后显示“从未”**：状态接口原本只读取 Worker 进程内存里的 `lastSuccessAt`，应用或 worker 重启后会丢失。现在当内存为空时，会从本地 `shadowfolk-push-history.json` 中读取各工作区最近一次成功推送时间回填，避免历史上传记录被 UI 显示成“从未”。

### 测试
- `tests/worker/worker-endpoints.test.ts` 新增回归用例：Worker 重启后的状态接口必须从推送历史恢复最近成功同步时间。

### 版本
- 根 `package.json` + `desktop/package.json`：`2.0.9` → `2.0.10`

---

## [2.0.9] - 2026-05-14

### 修复
- **ShadowFolk 设置页刷新状态可感知**：刷新按钮改为专用点击处理器，点击后立即显示“刷新中”与状态提示，避免状态数据不变时看起来无效。
- **上传工作区折叠项命名**：工作区内的旧记忆路径与重推入口统一改名为“高级设置”，默认保持折叠。

### 版本
- 根 `package.json` + `desktop/package.json`：`2.0.8` → `2.0.9`

---

## [2.0.8] - 2026-05-14

### 新增
- **ShadowFolk 工作区旧记忆路径别名**：真实 Git 工作区可绑定历史记忆路径，工程从 E 盘迁移到 D 盘后，上传仍以当前 Git root 为准，同时归并旧路径下的 observations 和 summaries。
- **设置页旧路径绑定体验**：旧记忆路径只能从已记录项目目录中选择，不再手动输入；每个上传工作区默认只展示目录，旧路径与重推操作折叠在详情区域中。

### 改进
- **重推与全量重推支持路径别名**：普通上传、全量重推、历史区间重推共用同一套 `memoryRoots` 过滤规则，避免迁移后的旧记忆漏传。
- **ShadowFolk history 响应脱敏**：历史选项不再向设置页暴露完整本地 `memoryRoots` 路径，只返回 UI 所需字段。

### 版本
- 根 `package.json` + `desktop/package.json`：`2.0.7` → `2.0.8`

---

## [2.0.7] - 2026-04-25

### 修复
- **`media_context` 只压缩最后一条 assistant 回复导致图片内容跑偏**：用户发图后，assistant 可能先在一条回复中说明“从图里看到什么”，随后又继续执行工具和输出最终任务总结。旧逻辑只读取 transcript 最后一条 assistant 消息，容易把最终提交/构建结果误写成图片内容。现在新增 `readLastImageTurnAssistantMessage()`，在用户发图时收集该图片 turn 之后的 assistant 讨论串，作为 `media_context` 的 transcript 信源。
- **Claude Code / Cursor 多条 assistant 行的图片语义保留**：`recordTranscriptObservation()` 在 `has_images=true` 时优先使用“最后一次发图 turn 后的 assistant 讨论串”，再写入 `[USER_POSTED_IMAGE]` 前缀与 observation，确保“提交列表作者是 minusjiang”等图片解读不会被后续任务总结覆盖。

### 测试
- `tests/transcript-observation-common.test.ts` 新增回归用例：用户发图后 assistant 先描述图片、再输出最终总结时，写入的 `last_assistant_message` 与 observation 都必须包含图片描述。
- `tests/transcript-parser.test.ts` 新增 `readLastImageTurnAssistantMessage` 覆盖，确保可读取 `[Image #N]` 后的 assistant 讨论串。

### 版本
- 根 `package.json` + `desktop/package.json`：`2.0.3` → `2.0.7`

---

## [2.0.3] - 2026-04-28

### 新增
- **OpenClaw 一键集成**：桌面端「集成」面板新增 OpenClaw 关联条目；安装器自动写入完整插件目录（`package.json` / `openclaw.plugin.json` / `index.js` / `config.json`），调用 `openclaw plugins install --link`，合并 `~/.openclaw/openclaw.json` 的 `plugins.entries` / `plugins.load.paths`，自动开启 `allowConversationAccess`，并尝试 `openclaw gateway restart`，无需用户手动装插件
- **OpenClaw CLI 探测**：`OpenClawInstaller` 维护 `/opt/homebrew/bin`、`/usr/local/bin`、`~/.npm-global/bin`、`~/.local/bin` 的候选路径，避免桌面 App 启动环境 `PATH` 缺失导致 `openclaw` 命令找不到
- **Setup Wizard 支持 OpenClaw**：`SetupWizard.ts` / `setup-wizard.html` 增加 OpenClaw 选项，与 Claude Code / Cursor 等 IDE 一起出现在初始化向导

### 修复
- **macOS 托盘图标消失**：`TrayManager.ts` 在 macOS 优先加载 22×22 托盘小图并 `nativeImage.resize` 兜底；`scripts/process-icons.cjs` 新增 `icon-*-tray.png` 生成步骤
- **设置「一键连接」无反应**：`inviteParser.ts` 增强邀请链接解析（去前后空白、兼容多前缀、错误信息明确）；`settings.html` 改为真正的 form 提交并新增三态状态行（进行中/成功/失败）；`SettingsWindow.ts` 把 IPC 结果回写到状态行
- **IDE 关联一直「检测中」**：`settings.html` 中 `loadIDEStatus` 用 `withTimeout` 包裹 `detectIDEs` IPC，超时即降级显示，preload 加 `window.electronAPI` 存在性检查
- **OpenClaw hooks 自动注册不再误注册自身**：`main.ts` 把 OpenClaw 从 hooks auto-guard 中排除，避免和 OpenClawRegistrar 重复注册

### 涉及文件
- `desktop/src/services/OpenClawRegistrar.ts` / `desktop/src/services/HooksRegistrar.ts`
- `src/services/integrations/OpenClawInstaller.ts`
- `desktop/src/tray/TrayManager.ts` / `scripts/process-icons.cjs`
- `desktop/src/config/inviteParser.ts` / `desktop/src/windows/SettingsWindow.ts` / `desktop/src/windows/settings.html`
- `desktop/src/windows/SetupWizard.ts` / `desktop/src/windows/setup-wizard.html`
- `desktop/src/main.ts`
- `docs/superpowers/specs/2026-04-27-desktop-openclaw-prd.md` / `2026-04-27-desktop-openclaw-design.md`

---

## [2.0.2] - 2026-04-22

### 改进
- **系统托盘图标换新**：从纯色方块更换为像素小机器人 logo，支持 4 种状态色（绿/橙/红/灰），背景透明、紧凑裁切；横向拉伸 10% 视觉更饱满
- **图标处理流水线**：新增 `scripts/process-icons.cjs`，基于 sharp 实现洪水填充去背景 + 自动裁切 bounding box + 正方形居中
- **多尺寸 ICO 生成**：新增 `scripts/gen-ico.cjs`，生成标准多尺寸 ICO 文件（16/32/48 BMP + 256 PNG），解决 Windows 资源管理器图标渲染问题
- **绿色 Logo 眼睛上色**：机器人眼睛由白色改为深绿色 `rgb(0,150,80)`，与整体主题更协调
- **ShadowFolk 深空 HUD 主题**：QuickPanel、Memory Viewer、Settings、Setup Wizard 统一采用 ShadowFolk 深空配色（`#0a1014` 底色 + `#00d4aa` 青绿色主强调），替换原紫色/白色风格
- **Memory Viewer 标题重命名**：`AgentMemory Viewer` → `AgentMem-Viewer`

### 修复
- **QuickPanel 底部绿色闪烁条**：卡片 `:hover` 的 `translateX(2px)` 触发水平溢出导致水平滚动条（青色 thumb）在底部渲染为绿色闪烁条；增加 `overflow-x: hidden` 禁止水平滚动彻底修复
- **多余 UI 边框清理**：移除 `body::before` 暗角覆盖层、card 半透明绿色边框、card hover `box-shadow` 光晕、footer `border-top` 等可能泄漏到窗口边缘的元素
- **QuickPanel 窗口改为 transparent 模式**：`transparent: true` + 圆角 `border-radius: 8px`，彻底消除 Windows DWM 为无边框窗口渲染的系统边框

### 涉及文件
- `desktop/src/assets/icon-green.png` / `icon-red.png` / `icon-yellow.png` / `icon-gray.png` — 托盘状态图标
- `desktop/src/assets/icon.png` / `icon.ico` — 应用主图标
- `desktop/src/windows/quick-panel.html` / `QuickPanel.ts` — QuickPanel UI + 窗口配置
- `desktop/src/windows/settings.html` / `setup-wizard.html` — 设置页面紫色 → 青绿色
- `web/viewer.html` — Memory Viewer ShadowFolk 主题 + 标题
- `scripts/process-icons.cjs` — 图标处理脚本（含 10% 横向拉伸）
- `scripts/gen-ico.cjs` — ICO 生成脚本

---

## [2.0.1] - 2026-04-22

### 新增
- **Summary `media_context` 字段**：`buildSummaryPrompt` 新增 `<media_context>` 输出槽位，当会话中包含图片/截图/设计稿时，自动检测并指示 LLM 将视觉内容的具体描述（而非"用户分享了一张图片"）写入该字段，解决图片语义在 summary 阶段被过度压缩的问题
- **自动 schema 迁移**：`EXPECTED_COLUMNS` 新增 `session_summaries.media_context`，旧数据库首次启动自动 `ALTER TABLE` 补列并重建 FTS 索引
- **FTS5 全文搜索覆盖 `media_context`**：`summaries_fts` 虚拟表、插入触发器、回填 SQL 均纳入 `media_context`
- **LIKE 搜索覆盖 `media_context`**：`searchSummariesLike` 新增 `media_context LIKE ?` 条件

### 改进
- `lastAssistantMessage` 截取上限从 2000 → 3000 字符，为图片描述保留更多上下文
- `buildSummaryPrompt` 自动探测 `lastAssistantMessage` 中的媒体关键词（图片/截图/设计稿/screenshot/image/diagram），命中时追加第 6 条专项规则要求 LLM 保留详细视觉内容

### 涉及文件
- `src/sdk/prompts.ts` — prompt 模板 + 媒体检测逻辑
- `src/sdk/parser.ts` — `ParsedSummary` 接口 + `parseSummary` 解析
- `src/types/database.ts` — `SessionSummaryRow` 类型
- `src/services/sqlite/Database.ts` — migration / FTS5 / trigger
- `src/services/sqlite/summaries.ts` — insert + LIKE 搜索
- `src/services/worker/SDKAgent.ts` — summary 插入调用
- `src/services/worker/WorkerService.ts` — HTTP API summary 插入调用

---

## [1.1.5] - 2026-04-03

### 修复
- **Worker 服务在非管理员权限下启动崩溃（EPERM）**：Logger 默认日志目录使用 `process.cwd()/logs`，当 Worker 由桌面应用启动时 cwd 为安装目录 `C:\Program Files\...`，普通用户无写入权限导致 `mkdir` 失败。修复：默认日志目录改为 `~/.agent-memory/logs/`，同时在 `getWorkerEnv()` 中显式注入 `LOG_DIR` 环境变量作为双保险

---

## [1.1.4] - 2026-04-03

### 修复
- **Cursor hooks 在 Windows 上因 PowerShell 管道限制全部失败**：PowerShell 的 pipe 语法要求接收端为裸命令名，任何引号包裹的路径（即使无空格）都会被当作字符串表达式而报错 `ExpressionsMustBeFirstInPipeline`。最终方案：`cmd /c <node_path> "<proxy_script>" event`，其中 `cmd` 是裸命令名保证被 PowerShell 接受，`/c` 后的参数由 cmd.exe 处理（正确解析带引号路径），stdin 自动透传。同时将内置 node.exe 复制到 `~/.agent-memory/bin/node.exe` 以不依赖系统 Node
- **统一所有 hooks 返回格式为 `{permission: "allow"}`**：之前 monitor hooks 返回 `{success: true}`，Cursor 不识别。统一返回格式使 Execution Log 正确显示绿色 ALLOW

### 改进
- **内置默认 TIMIAI API Key**：安装后无需手动配置 API Key 即可使用，开箱即用
- **默认模型升级为 gpt-5.4**：从 gpt-5.2/gpt-4o-mini 统一升级到 gpt-5.4

---

## [1.1.2] - 2026-04-02

### 修复
- **Cursor monitor hooks 无 ALLOW 标记**：统一所有 hooks 返回 `{permission: "allow"}`

---

## [1.1.1] - 2026-04-02

### 修复
- **Cursor hooks 在 Windows 上全部失败**：v1.0.8 重构时将 hooks.json 命令从 `node "proxy.js"` 改为 `"bundled/node.exe" "proxy.js"`，但 Cursor 在 Windows 通过 PowerShell 执行 hooks，安装路径含空格时 PowerShell 管道语法报错。恢复为 v1.0.7 的做法：hooks.json 使用系统 `node` 调用 proxy 脚本，proxy 内部再调用内置 node.exe
- **CodeBuddy IDE 对话无数据记录**：CodeBuddy IDE 不支持 `afterAgentResponse` / `afterAgentThought` 事件，导致纯文本对话（无工具调用）不产生任何 observation，session summary 被跳过。现在在 `UserPromptSubmit` 阶段自动为 CodeBuddy IDE 记录用户提问作为 observation，确保每次对话都有数据可供摘要生成
- **Stop 事件增加响应采集**：当 Stop 事件携带 response/text 字段时，记录为 agent_response observation，进一步丰富会话数据

---

## [1.1.0] - 2026-04-02

### 修复
- **CodeBuddy IDE hooks 无法执行**：安装路径含空格时（`AgentMemory`），IDE 的 HookExecutor 无法正确解析带引号的路径。生成代理批处理文件 `~/.agent-memory/hooks/agentmemory-ide-hook.cmd`（无空格路径），hook 命令通过调用此 .cmd 文件间接执行
- **CodeBuddy IDE 配置目录错误**：从 `~/.codebuddy-ide/` 修正为 `~/.codebuddy/settings.json`，确保自动注册的 hooks 写入 IDE 实际读取的位置
- **CodeBuddy 插件版 adapter 元数据错误**：`configDir` 从 `~/.codebuddy` 修正为 `~/.gongfeng-copilot`，`hooksConfigFile` 从 `config.json` 修正为 `hooks/hooks.json`
- **设置窗口缺失 IDE 关联功能**：恢复了 1.0.7 中存在的 IDE 检测/关联/断开 UI、preload API 桥接和相关样式
- **PreToolUse 缺少 matcher**：对齐参考配置，为 `PreToolUse` 事件添加 `"matcher": "Bash"`

### 改进
- `settings.html` IDE 关联区增加 CodeBuddy IDE 标签显示
- 设置窗口高度从 620px 调整为 750px 以容纳 IDE 关联区域
- 更新全部文档和设计文档中的 IDE 路径引用

---

## [1.0.8] - 2026-04-01

### 新增
- **IDE Adapter Registry 架构**：新增 `src/adapters/` 模块，定义 `IDEAdapter` 接口和注册表，新增 IDE 只需添加一个适配器文件
- **CodeBuddy IDE 支持**：新增 `CodeBuddyIDEAdapter`，支持 PascalCase 事件名映射、`PostToolUse` 智能路由（自动识别 shell/MCP/file_edit 子类型）
- **桌面端自动注册**：从 v1.0.7 同步 `SetupWizard` 和 `HooksRegistrar`，支持 CodeBuddy IDE 自动检测和 hooks 注册

### 修复
- **Cursor hooks 依赖系统 Node.js**：改用内置 `node.exe` 路径执行代理脚本，解决用户无全局 Node 时 hooks 静默失败的问题
- **打包缺失原生依赖**：同步 1.0.7 的 `extraResources` 配置，补全 `bindings`、`file-uri-to-path` 等 `better-sqlite3` 依赖
- **Windows 安装包图标格式错误**：NSIS 需要 `.ico` 格式，修改 `generate-icons.js` 生成多尺寸 `.ico` 文件
- **安装包命名可追溯**：添加 `artifactName` 配置，安装包命名为 `AgentMemory-Setup-${version}.exe`

### 重构
- `hooks-cli.ts`：hook 处理从 fire-and-forget 改为 await 模式，确保 CLI 等待 Worker HTTP 响应
- `WorkerService.ts`：session end 和 observation 请求改为立即返回 HTTP 200 后异步处理

---

## [1.0.7] - 2026-03-28

### 新增
- **桌面端 Electron 应用**：系统托盘守护进程，自动管理 Worker 生命周期
- **SetupWizard 首次引导**：首次启动弹出 IDE 关联设置向导
- **HooksRegistrar**：自动检测已安装的 IDE（CodeBuddy 插件版 / Cursor）并注册 hooks
- **Settings UI**：AI 配置（提供商/模型/API Key）、通用设置、IDE 关联管理
- **QuickPanel**：全局快捷键（CmdOrCtrl+Shift+M）唤起 Spotlight 风格搜索面板
- hooks-executor.bat：Windows 下通过 bat 脚本执行 hooks，绑定内置 Node.js 运行时

### 修复
- 运行时 Worker 和 Quick Panel 的 IPC 通讯问题
- localhost fetch CORS 跨域问题（禁用 webSecurity）

---

## [1.0.3] - 2026-03-25

### 修复
- `afterSearchReplaceFileEdit` 事件移至 CodeBuddy-only，避免 Cursor 误触发
- Hook 进程提前退出问题：改为 await HTTP 响应后再退出

---

## [1.0.0] - 2026-03-20

### 新增
- AgentMemory 核心系统：基于 hooks 的跨会话记忆持久化
- 支持 CodeBuddy 插件版和 Cursor 两种 IDE
- Observation 提取和 Summary 生成的 AI 管线
- MCP Server 支持主动搜索历史记忆
- 元意图（Meta-Intent）功能
- 敏感信息过滤规则
- 中文 LIKE 搜索优化
- UTF-8 BOM 处理（兼容新版 Cursor）
