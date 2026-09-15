# spec-injector-plugin — 设计

## 总体方案

`Injector` 是 agent-memory 的内置插件，由四块组成：

```
src/plugins/injector/
├── index.ts                 # 插件入口 createInjectorPlugin()：catalog/detect/preview/inject/ledger
├── catalog.ts               # 读取内置内容库索引，提供查询/过滤
├── resolver.ts              # 「内容 × 目标 IDE」→ 落点路径解析（复用 IDE 路径表）
├── engine.ts                # 注入引擎：preview(diff) / apply（幂等写入）/ uninstall
├── ledger.ts                # 注入账本读写（注入了什么/到哪/版本/原始备份）
└── library/                 # 内置内容库（随插件打包，随版本更新）
    ├── catalog.json         # 库索引（所有可注入项 + bundle 定义）
    ├── skills/<slug>/...     # 内置 skills
    ├── rules/<id>.mdc        # 内置 rules（含受管块模板）
    ├── mcp/<id>.json         # MCP 配置片段
    ├── specs/<id>/...        # 规范/模板文件（如 harness 全套）
    └── bundles/...           # （bundle 仅在 catalog.json 里以引用列表声明）
```

接入方式遵循当前过渡态（仿 self-evolve 手工接线），并预留向 `plugin.json` 框架迁移：

- `WorkerService` 启动时若 `settings.plugins.injector.enabled` 则装配，注册 `/api/injector/*` 路由，`pluginUIManifests.push({id:'injector', tab:{...}})`。
- `web/viewer.html` 注册 `PLUGIN_RENDERERS['injector']`。
- 设置页加 Injector 卡片 + IPC。
- `mcp-server.ts` 注册 snake_case 工具。

## 决策 1：内容库用「目录文件 + catalog.json」，不入 SQLite

内置内容以**真实文件**存放在 `library/`，用 `catalog.json` 做索引。理由：

- 可注入项本身就是文件（SKILL.md / .mdc / json / 模板），直接拷贝/合并最自然，便于 diff 与版本管理。
- 随插件包发布；桌面端用 electron-builder 的 `extraResources`（参考 ShadwMonitor 打包）把 `library/` 带进 `resources/`。
- SQLite 仅用于**账本（ledger）**与运行期状态，不存内容本体。

## 决策 2：可注入项（Injectable）统一模型

`catalog.json` 每个条目：

```jsonc
{
  "id": "skill.add-feature-doc",
  "category": "skill",            // skill | rule | mcp | spec | bundle
  "name": "新增功能需求文档",
  "description": "按 docs 范式落盘 features 需求骨架",
  "version": "1.2.0",
  "tags": ["harness", "docs"],
  "source": "skills/add-feature-doc",   // library 内相对路径（bundle 无此字段）
  "targetKind": "skill",          // 决定落点解析方式：skill|rule|mcp|spec
  "conflict": "overwrite",        // overwrite | managed-block | json-merge | toml-merge | skip-if-exists
  "ides": ["cursor", "claude-code", "codebuddy"],  // 支持的 IDE（spec 类可为 ["*"]=项目根）
  "managedBlock": { "start": "<!-- injector:add-feature-doc:start -->", "end": "..." },  // 仅 managed-block 类

  // —— 体系完整性相关（见决策 8）——
  "standalone": false,            // 是否可单独注入；false=体系组件，不可裸勾
  "requires": ["spec.docs-readme", "spec.requirements-registry", "rule.harness-gate"],  // 硬依赖（注入时按闭包自动带入）
  "partOf": "bundle.shadow-harness" // 所属体系（用于 viewer 归组/提示，可选）
}
```

`bundle` 条目用 `members` 引用其它 id，可声明 `atomic` 表示不可拆：

```jsonc
{
  "id": "bundle.shadow-harness",
  "category": "bundle",
  "name": "shadow-harness",
  "version": "1.0.0",
  "atomic": true,                 // true=原子体系：成员不在扁平列表单独出现，只能整套注入
  "members": [
    "spec.docs-readme", "spec.requirements-registry", "spec.harness-md", "spec.inbox",
    "skill.add-feature-doc", "skill.add-bug-doc", "skill.claim-requirement", "skill.harness-init",
    "rule.harness-gate", "rule.engineering-spec"
  ]
}
```

## 决策 3：落点解析（resolver）—— 单一权威路径表

集中维护一张「targetKind × IDE → 路径」表，注入引擎据此解析目标文件。初版以已验证 IDE 为准（Cursor、Claude Code 已在 PlatformWriter 实现），其余标"实验性"逐步开启。

> 下表为 2026 官方文档调研结果（Cursor / Claude Code / Codex / CodeBuddy）。**各家差异极大，不能套同一套落点**：rule 的组织粒度、mcp 的文件格式、skill 的目录名都不同，resolver 必须 per-IDE per-targetKind 实现。`{ws}`=工作区根，`{home}`=用户目录。

| targetKind \ IDE | Cursor | Claude Code | Codex CLI | CodeBuddy |
|------------------|--------|-------------|-----------|-----------|
| **skill** | ⚠️ 无官方 skills 概念；现有 PlatformWriter 写 `{ws}/.cursor/skills/<slug>/SKILL.md`（**非官方约定，标实验性**） | `{ws}/.claude/skills/<slug>/SKILL.md`（项目）/ `{home}/.claude/skills/<slug>/SKILL.md`（全局） | `{ws}/.agents/skills/<slug>/SKILL.md`（项目）/ `{home}/.agents/skills/<slug>/SKILL.md`（全局）— **目录是 `.agents` 不是 `.codex`** | `{ws}/.codebuddy/skills/<slug>/SKILL.md`（项目）/ `{home}/.codebuddy/skills/<slug>/SKILL.md`（用户） |
| **rule** | `{ws}/.cursor/rules/<id>.mdc`（**扁平目录**，frontmatter `description/globs/alwaysApply`） | 写进 `{ws}/CLAUDE.md` **受管块**（**无独立 rule 文件**） | 写进 `{ws}/AGENTS.md` **受管块**（根目录，**无 rules 目录、无独立 rule 文件**；支持 `AGENTS.override.md`） | `{ws}/.codebuddy/rules/<id>/RULE.mdc`（**每条 rule 一个文件夹**，frontmatter `description/alwaysApply/enabled`） |
| **mcp** | `{ws}/.cursor/mcp.json`（项目）/ `{home}/.cursor/mcp.json`（全局），键 `mcpServers.<id>` | `{ws}/.mcp.json`（项目根，团队共享）/ `{home}/.claude.json`（用户/local 段） | **`{home}/.codex/config.toml` 的 `[mcp_servers.<id>]` 段（TOML，非 JSON！需 `toml-merge`）** | `{home}/.codebuddy/mcp.json`（全局）/ 项目 `{ws}/.codebuddy/settings.json` |
| **memory/指令** | `{ws}/AGENTS.md` 或 `{ws}/CLAUDE.md`（根，plain md，Cursor 均识别） | `{ws}/CLAUDE.md`（根）或 `{ws}/.claude/CLAUDE.md` | `{ws}/AGENTS.md`（根，可 `AGENTS.override.md`） | `{ws}/CODEBUDDY.md`（根；缺失时自动回退读 `AGENTS.md`） |
| **spec/规范文件** | `{ws}/<source 指定相对路径>`（项目根，IDE 无关） | 同 | 同 | 同 |

### 调研得出的三个关键约束（影响注入引擎实现）

1. **rule 粒度差异**：Cursor 一条 = 一个 `.mdc`；CodeBuddy 一条 = 一个**文件夹**（内含 `RULE.mdc`）；Claude Code / Codex **没有独立 rule 文件**，只能往 `CLAUDE.md` / `AGENTS.md` 注入受管块。→ resolver 对后两者用 `managed-block`，对 Cursor/CodeBuddy 用文件级写入。
2. **mcp 格式不统一**：Cursor / Claude Code / CodeBuddy 是 JSON（`json-merge`），**Codex 是 TOML**（`[mcp_servers.<id>]`）。→ 需新增 `toml-merge` 冲突策略（见决策 4），否则 Codex 的 mcp 注入无法幂等。
3. **现有检测表需修正**（落注入逻辑前必做）：`ide-detection.ts` 当前把 `codebuddy` 标 `.gongfeng-copilot`、`codebuddy-ide` 才是 `.codebuddy`；Codex 的 skills 实际落 `.agents/` 而非 `.codex/`。注入落点应以本调研表为准，并回头校正检测表。

> 真实落点以本表为权威依据；未验证的 IDE 在 catalog 的 `ides` 里先不声明，避免写错位置。后续每接入一个新 IDE，先补本表再开 `ides` 声明。

IDE 检测：复用 `ide-detection.ts` 的 `IDE_DETECTION_TABLE`，viewer 预选"已安装"的 IDE。

## 决策 4：注入引擎与冲突策略（幂等）

`apply(injectables, targets)` 流程：

0. **依赖闭包解析（见决策 8）**：先把用户勾选项按 `requires` / `members` 展开成完整集合，杜绝半残体系。
1. 解析每个 (injectable × IDE) 的目标路径。
2. 生成**计划**：每个目标文件标 `create | overwrite | merge | skip`。
3. `preview` 模式只返回计划 + diff，不落盘。
4. `apply` 模式按 `conflict` 策略写入：

| conflict | 行为 | 适用 |
|----------|------|------|
| `overwrite` | 整文件覆盖（覆盖前备份进 ledger） | skill 目录、独立 spec 文件 |
| `managed-block` | 仅重写 `start/end` 之间，块外不动 | rule 写入 CLAUDE.md / AGENTS.md / .mdc |
| `json-merge` | 深合并到目标 JSON 的指定键（如 mcpServers.<id>） | Cursor/Claude/CodeBuddy 的 mcp.json |
| `toml-merge` | 合并到目标 TOML 的指定表（如 `[mcp_servers.<id>]`） | Codex 的 `~/.codex/config.toml` |
| `skip-if-exists` | 已存在则跳过，仅缺失时写 | 用户可能改过的种子（如 registry.data.js） |

所有写入前把被影响文件的原始内容/哈希记入 ledger，支持卸载还原。

## 决策 4b：依赖与完整性（体系内容不可孤立注入）

**问题**：catalog 里的条目并不对等。有的 skill/rule 是通用、能独立成立的零件；有的只是某个体系的一部分（如 `skill.add-feature-doc` 必须有 `docs/` 范式、需求注册中心、门禁 rule 才有意义），单独丢进 `skills/` 会变成孤立、不完整的功能。

用三档机制保证"注入出来的永远是完整可用的东西"：

| 字段 | 含义 | 用于 |
|------|------|------|
| `standalone`（默认 `true`） | 是否可单独注入。`false`=体系组件，UI 禁止裸勾，勾它即转为选中其依赖闭包（或所属 bundle） | 区分通用零件 vs 体系零件 |
| `requires: string[]` | 硬依赖的其它 injectable id；注入时按**传递闭包**自动带入，preview 中标注"因依赖自动加入" | 体系零件牵引出配套 spec/rule |
| `atomic`（bundle 字段，默认 `false`） | `true`=原子体系：成员**不在扁平列表单独出现**，只能整套注入，从根上杜绝拆分 | 真正"拆了即废"的体系（如 shadow-harness） |

解析规则（apply / preview 第 0 步 `resolveClosure(selected)`）：

1. 展开所有被选 bundle 的 `members`。
2. 对集合内每一项，递归并入其 `requires`（去重；检测循环依赖则报错）。
3. 若集合里出现 `standalone:false` 的项却**缺少其 requires**（理论上第 2 步已补全，这里兜底校验）→ 视为"不完整"，预览给出阻断提示而非静默写入。
4. 返回闭包集合交给落点解析。

UI 配合（详见决策 6）：
- `atomic` bundle 的成员不进 Skills/Rules 扁平列表，只在 bundle 卡片内以只读清单展示。
- 非 atomic 但 `standalone:false` 的项：列表里带"体系组件"徽标，勾选时弹"将一并注入依赖：A、B、C"确认。
- 预览抽屉里，因依赖自动带入的项单独分组标注，让用户清楚"为什么会多写这些文件"。

> 卸载对称处理：卸载一个体系零件时，若它的依赖项**仅被它使用**，提示是否一并卸载；被其它已注入项共享的依赖则保留（引用计数，类比包管理器）。

## 决策 5：账本（ledger）与更新/卸载

SQLite 表 `injector_ledger`（插件自有表）：

| 列 | 说明 |
|----|------|
| `id` | 自增 |
| `workspace` | 目标工作区 |
| `ide` | 目标 IDE |
| `injectable_id` | catalog id |
| `version` | 注入时的版本 |
| `target_path` | 实际写入路径 |
| `mode` | create/overwrite/merge |
| `backup` | 原始内容/哈希（卸载还原用） |
| `injected_at` | 时间 |

- **更新**：catalog 版本 > ledger 版本 → 标"可更新"，更新即按当前策略重注。
- **卸载**：managed-block 删块；json-merge 删对应键；overwrite/create 用 backup 还原或删除新增文件。

## 决策 6：viewer 页布局（分类清晰）

`PLUGIN_RENDERERS['injector']` 面板：

```
┌ Injector ──────────────────────────────────────────────┐
│ 目标：[工作区路径 ▾]   IDE：[✓Cursor ✓Claude □CodeBuddy] │  ← 顶部目标条（自动检测预选）
├─────────────┬──────────────────────────────────────────┤
│ 分类树       │ 列表（勾选）                              │
│ • 整套Bundle │ ☑ Harness 全套      v1.0  [未注入]        │
│ • Skills     │ ☑ add-feature-doc   v1.2  [可更新 v1.1→]  │
│ • Rules      │ ☐ harness-gate      v1.0  [已注入]        │
│ • MCP        │ ...                                       │
│ • 规范文件    │                                          │
├─────────────┴──────────────────────────────────────────┤
│ [预览所选] [注入所选]            已注入清单 ▸（账本视图）  │
└─────────────────────────────────────────────────────────┘
```

- 选 bundle = 自动勾选其 members；`atomic` bundle 的 members **不出现在 Skills/Rules 扁平列表**，仅在 bundle 卡片内以只读清单展示（杜绝单独勾选）。
- 体系组件徽标：`standalone:false` 的项在列表里标"体系组件 · 属于 X"，勾选时弹确认"将一并注入依赖：A、B、C"。
- 状态徽章：未注入 / 已注入(v) / 可更新(v→v)。
- 「预览所选」弹出将写入文件计划 + diff；**因依赖自动带入的项单独分组标注**（呼应决策 4b）；「注入所选」执行。
- 「已注入清单」从 ledger 渲染，支持单项更新/卸载；卸载体系零件时按引用计数提示是否连带卸载其专属依赖。

## 决策 7：API 与 MCP 工具

| HTTP endpoint | 方法 | 说明 | MCP tool（snake_case） |
|---------------|------|------|------------------------|
| `/api/injector/catalog` | GET | 内置内容库（按分类，含版本） | `injector_list` |
| `/api/injector/detect` | GET | 检测已安装 IDE + 解析默认工作区 | `injector_detect_ides` |
| `/api/injector/ledger` | GET | 已注入清单（可按 workspace 过滤） | `injector_status` |
| `/api/injector/preview` | POST | dry-run，返回写入计划 + diff | `injector_preview` |
| `/api/injector/inject` | POST | 执行注入（items + ides + workspace） | `injector_inject` |
| `/api/injector/uninstall` | POST | 卸载某账本项 | `injector_uninstall` |

## 数据流 / 时序

```
viewer → GET /catalog + GET /detect        （展示库 + 预选 IDE）
用户勾选 → POST /preview                     （引擎解析落点 + 生成 diff，不写盘）
确认 → POST /inject                          （引擎写入 + 记 ledger）
viewer → GET /ledger                         （刷新已注入状态）
```

## 接口/文件变更清单

| 文件 | 变更 |
|------|------|
| `src/plugins/injector/**` | 新增：插件全部代码 + `library/` 内置内容 |
| `src/services/worker/WorkerService.ts` | 装配 injector、注册 `/api/injector/*`、push ui-manifest |
| `web/viewer.html` | 新增 `PLUGIN_RENDERERS['injector']` 面板 |
| `desktop/src/windows/settings.html` + `SettingsWindow.ts` | Injector 设置卡片 + IPC 开关 |
| `src/servers/mcp-server.ts` | 注册 injector_* MCP 工具 |
| `src/config/settings.ts` | 新增 `plugins.injector` 配置项 |
| `desktop/package.json` | electron-builder `extraResources` 打包 `src/plugins/injector/library` |

## 兼容性与迁移

- 首版按 self-evolve 过渡态手工接线；待 `PluginHost`/`plugin.json` 落地后，把入口改为 `createPlugin(ctx)` + `uiEntry`，library 路径走 `pluginDataDir`，DB 走 `PluginContext.db`。
- 账本表为插件自有表，遵循"插件通过 PluginContext.db 访问"的目标规范（过渡期先在 WorkerService 层隔离）。

## 测试策略

1. catalog 解析：库内 skills/rules/mcp/specs/bundles 正确分类、版本正确。
2. 落点解析：同一 skill 注入 Cursor 与 Claude Code，分别落到各自 skills 目录。
3. 幂等：rule 受管块重复注入不重复；mcp.json 合并不破坏既有 server；overwrite 前有 backup。
4. 预览：dry-run 不写盘，diff 与实际 apply 一致。
5. bundle：注入「Harness 全套」后，目标项目具备 README/registry/HARNESS/skills/rule，且注册中心可打开。
6. 卸载：managed-block 删块、json-merge 删键、overwrite 还原 backup，工作区回到注入前。
7. 更新：bump 某 injectable 版本 → 账本标"可更新" → 更新后版本一致。
8. 每个新 endpoint 有对应 MCP 工具且可调通。

## 待对齐（开放问题）

1. **模块归属**：升格独立模块 `injector`，还是留在 `hooks-adapter`？
2. **IDE 覆盖范围**：首版只做已验证的 Cursor + Claude Code，其余实验性？
3. **远程内容源**：首版纯内置；是否预留"从 git 仓库拉取内容库"的接口形态？
4. **与 self-evolve 的边界**：Injector=分发内置模板，self-evolve=从记忆生成；两者写入同一 IDE 路径时的协同/避免互相覆盖。
