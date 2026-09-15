# 文档目录范式

> 研发流程总纲见 **[docs/HARNESS.md](HARNESS.md)**（偏好 → 建档 → 注册 → 门禁 → 认领 → 实现 → 测试）。本文是其中「文档怎么写」的规范。
>
> 本项目所有文档按 **模块 → features/bugs → 需求(功能/bug)目录 → 文档集** 组织，
> 每个模块自洽、docs 内聚：一个模块文件夹内收敛它的模块级文档与全部需求/bug 的
> 需求文档、设计文档、框架图、测试用例、使用文档、验收结果。
> 新增任何 PRD、设计文档、bug 分析时，请遵循本文范式；不确定时优先调用
> `/add-feature-doc` 或 `/add-bug-doc` Skill 自动落盘。

---

## 一、目录结构（模块自洽，docs 内聚）

> 核心原则：**每个模块一个独立文件夹，模块自身的文档与它的所有需求/bug 都收敛在该文件夹内**，做到 docs 内聚——看一个模块文件夹即可掌握它的全部背景、需求、设计、测试与验收。

```
docs/<module>/                         模块独立文件夹
├── <module-level docs>.md             模块级文档（概览/架构说明等，可选，不绑定单个需求）
├── features/                          功能需求（新功能 / 演进）
│   └── <feature-name>/                以功能命名（kebab-case）
│       ├── prd.md                     需求文档
│       ├── design.md                  设计文档
│       ├── <name>.drawio              框架/架构图（需要描绘框架时）
│       ├── testcase.md                测试用例
│       ├── usage.md                   使用文档（需要交付他人使用时）
│       └── acceptance.md              验收结果（验收 / 测试报告）
└── bugs/                              Bug 需求（缺陷 / 线上问题）
    └── <bug-name>/                    以 bug 命名（kebab-case）
        ├── analysis.md                分析报告（必备）
        ├── design.md                  修复方案（修复需要时）
        ├── testcase.md                回归用例
        └── acceptance.md              验收结果
```

| 级别 | 名字 | 说明 |
|---|---|---|
| 1 | `<module>` | 8 大模块之一（见下表）。模块文件夹下**可直接放模块级文档**（概览、架构说明等不绑定单个需求的文档）；跨模块基础文档放 `00-architecture/`，临时/废弃文档放 `_archive/` |
| 2 | `features` 或 `bugs` | 需求类型文件夹；`features`=功能需求（新功能/演进），`bugs`=Bug 需求（缺陷/线上问题）。**仅当模块有对应类型的需求时才创建** |
| 3 | `<feature-name>` / `<bug-name>` | 以功能或 bug 命名，kebab-case，能独立描述一件事（不带日期前缀） |
| 4 | 文件 | 见 §三：需求/设计/框架图(drawio)/测试用例/使用文档/验收结果等，按需创建，全部收敛在该需求文件夹内 |

---

## 二、8 大模块定义

| 模块 | 职责范围 | 典型需求 |
|---|---|---|
| `00-architecture/` | **跨模块的基础架构和概念文档**，不绑定任何具体需求 | ARCHITECTURE、Session/Observation/Summary 关系、数据结构总览 |
| `memory-core/` | 记忆系统的核心算法、数据模型、压缩与注入逻辑 | RAG 混合搜索、图片语义、记忆演化、用户偏好记忆、闲置自动总结 |
| `hooks-adapter/` | Hook 入口与多平台 IDE/CLI 适配 | Claude Code Hooks、Cursor、IDE 适配器注册、多平台适配 |
| `desktop/` | Electron 桌面端（托盘、设置窗口、安装向导等） | tray-guardian、连接测试、macOS 打包、桌面端 OpenClaw |
| `viewer/` | Web 记忆查看器（`/viewer.html`） | memory-viewer、无边框窗口 |
| `shadowfolk/` | ShadowFolk 上传/同步插件 | 上传插件、daily-sync、push 历史回放、workspace 别名 |
| `openclaw/` | OpenClaw 网关插件、SSE 推送 | M4 网关、channel 推送（Telegram/Discord/Slack） |
| `release/` | 发布、打包、部署、运行时迁移；指引类文档放 `release/guides/` | M5 runtime-migration、npm 部署、release-automation；RELEASING/MIGRATION 指引 |
| `_archive/` | **临时、废弃、项目交接文档**，不进入主结构维护 | HANDOFF/TODO、空文件、跨里程碑路线图 |

### 模块边界判定原则

判断一个新需求归属哪个模块时，按下面顺序回答第一个能确认的：

1. **是不是发布/打包/迁移相关？** → `release/`
2. **是不是 ShadowFolk 插件？** → `shadowfolk/`
3. **是不是 OpenClaw 网关/推送？** → `openclaw/`
4. **是不是 Web 查看器？** → `viewer/`
5. **是不是 Electron 桌面端？** → `desktop/`
6. **是不是 IDE/CLI Hook 适配？** → `hooks-adapter/`
7. **剩下的核心记忆能力**（捕获/压缩/注入/搜索/演化）→ `memory-core/`

如果一个需求横跨多个模块（如 ShadowFolk 同时影响桌面端），归到**主要落地模块**，在其他模块的相关需求里通过链接交叉引用，不复制文档。

### 新增模块的条件

不要轻易新增顶级模块。**只在以下情况新增**：

- 出现一块全新的、独立部署/独立用户群的产品形态（如未来出现独立的 web 后端）
- 该方向已经有 ≥3 个需求且不属于现有任何模块
- 在 PR 描述里明确说明新模块边界与现有模块的关系

---

## 三、文件命名规则

需求/bug 目录内只允许以下文件名（按场景使用，**按需创建、全部收敛在该目录内**）：

| 文件 | 用途 | features 必备性 | bugs 必备性 |
|---|---|---|---|
| `prd.md` | 需求文档（产品视角：要做什么、为什么、验收标准） | 推荐 | 不需要 |
| `design.md` | 设计文档（技术视角：方案、数据流、关键决策） | 推荐 | 修复方案时 |
| `analysis.md` | 分析报告（现状调研、问题复盘） | 调研阶段 | **必备** |
| `plan.md` | 实施计划（任务拆分、里程碑、依赖） | 大需求需要 | 不需要 |
| `*.drawio` | 框架 / 架构图（需要描绘框架时；可附 `*.drawio.svg` 导出版） | 按需 | 按需 |
| `testcase.md` | 测试用例 / 回归用例 | 进入实现后 | 修复后 |
| `usage.md` | 使用文档（需要交付他人使用时） | 按需 | 一般不需要 |
| `acceptance.md` | 验收结果（验收 / 测试报告） | 完成时 | 完成时 |
| `*.pdf` / `*.html` | 同名渲染版（如 `prd.pdf` / `prd.html`）；Markdown 始终为可 diff 的源，是否额外产出渲染版由偏好 `doc.format`（`md`/`html`/`both`）决定 | 可选 | 可选 |

> 与注册中心 6 环节对应：`prd.md`→需求文档、`design.md`→设计文档、`testcase.md`→测试用例、`acceptance.md`→测试报告。

**禁止**在需求目录内出现：日期前缀文件、`README.md`（除非该需求文档很多需要索引）、随手的 `notes.md` / `temp.md`。

### 需求目录命名

- 全小写、kebab-case：`shadowfolk-workspace-memory-alias`、`m2-rag-hybrid-search`
- 不带日期前缀（日期信息进 git 历史，不进文件名）
- 以核心功能名为主，必要时保留里程碑前缀（`m1-`/`m2-` 等）
- 长度 ≤ 60 字符

---

## 四、当前模块索引

> 自动维护的现状索引。新增需求后请同步更新此节（或调用 Skill，会提示更新）。

### 00-architecture/
- [ARCHITECTURE](00-architecture/ARCHITECTURE.md) — 技术架构与原理
- [memory-systems-first-principles-overview](00-architecture/memory-systems-first-principles-overview.md)
- [SESSION-SUMMARY-OBSERVATION](00-architecture/SESSION-SUMMARY-OBSERVATION.md)
- [SUMMARY-VS-OBSERVATION](00-architecture/SUMMARY-VS-OBSERVATION.md)
- [记忆数据的整体结构](00-architecture/记忆数据的整体结构.md)

### memory-core/

**features/**
- [m1-image-semantics](memory-core/features/m1-image-semantics/) — 图片语义修复
- [m2-rag-hybrid-search](memory-core/features/m2-rag-hybrid-search/) — RAG 混合搜索
- [memory-system-evolution](memory-core/features/memory-system-evolution/) — 记忆系统演化
- [user-preference-memory](memory-core/features/user-preference-memory/) — 用户偏好记忆
- [active-session-auto-summary](memory-core/features/active-session-auto-summary/) — 闲置会话自动总结
- [desktop-monitor-plugin](memory-core/features/desktop-monitor-plugin/) — 桌面监控数据源插件（截屏 + VLM）

**bugs/**
- [summary-image-missing](memory-core/bugs/summary-image-missing/) — Summary 图片丢失

### hooks-adapter/features/
- [ide-hooks-integration](hooks-adapter/features/ide-hooks-integration/)
- [claude-code-hooks-solution](hooks-adapter/features/claude-code-hooks-solution/)
- [multi-platform-hooks-adaptation](hooks-adapter/features/multi-platform-hooks-adaptation/)
- [m3-multi-platform-adapters](hooks-adapter/features/m3-multi-platform-adapters/)
- [ide-adapter-registry](hooks-adapter/features/ide-adapter-registry/)
- [claude-code-provider](hooks-adapter/features/claude-code-provider/)
- [openclaw-hook-extension](hooks-adapter/features/openclaw-hook-extension/)
- [spec-injector-plugin](hooks-adapter/features/spec-injector-plugin/) — Injector 通用规范注入器插件（一键注入 harness/skills/rules/mcp 到各 IDE）

### desktop/features/
- [electron-tray-guardian](desktop/features/electron-tray-guardian/)
- [desktop-claude-internal-config](desktop/features/desktop-claude-internal-config/)
- [desktop-connection-test](desktop/features/desktop-connection-test/)
- [desktop-macos-packaging](desktop/features/desktop-macos-packaging/)
- [desktop-openclaw](desktop/features/desktop-openclaw/)

### viewer/features/
- [memory-viewer](viewer/features/memory-viewer/)
- [viewer-frameless-window](viewer/features/viewer-frameless-window/)
- [server-admin-memory-display-parity](viewer/features/server-admin-memory-display-parity/) — 服务端后台记忆展示字段与客户端 viewer 对齐

### shadowfolk/features/
- [shadowfolk-upload-plugin](shadowfolk/features/shadowfolk-upload-plugin/)
- [shadowfolk-desktop-workspaces-daily-sync](shadowfolk/features/shadowfolk-desktop-workspaces-daily-sync/)
- [shadowfolk-push-history-replay](shadowfolk/features/shadowfolk-push-history-replay/)
- [shadowfolk-workspace-memory-alias](shadowfolk/features/shadowfolk-workspace-memory-alias/)

### openclaw/features/
- [m4-openclaw-gateway](openclaw/features/m4-openclaw-gateway/)

### release/

**features/**
- [m5-runtime-migration](release/features/m5-runtime-migration/)
- [headless-npm-deploy](release/features/headless-npm-deploy/)
- [release-automation](release/features/release-automation/)
- [dev-harness-and-agent-task-claiming](release/features/dev-harness-and-agent-task-claiming/) — 研发 harness 流程规范与 agent 任务认领

**guides/**
- [RELEASING](release/guides/RELEASING.md)
- [MIGRATION](release/guides/MIGRATION.md)
- [claude-mem-merge-plan](release/guides/claude-mem-merge-plan.md)
- [m1-m5-feature-summary](release/guides/m1-m5-feature-summary.md)

---

## 五、需求收件箱（INBOX）

`docs/INBOX.md` 是**未评审的需求池**，独立于上面的模块目录结构存在。

| 角色 | 说明 |
|---|---|
| 输入 | 任何想法、用户反馈、灵感、待评审需求 — 先塞 INBOX，不直接建目录 |
| 评审 | 经过讨论确认要做后，从 INBOX 移除，调用 `/add-feature-doc` 落到 `docs/<module>/features/<name>/` |
| 暂缓 | 评审后暂时不做的，留在 INBOX 的"暂缓 / 搁置"区块，附原因 |

**不要**在 INBOX 里写完整 PRD；它是清单不是文档。完整设计请走标准范式。

---

### INBOX 入口

- 查看：[docs/INBOX.md](INBOX.md)
- 评审通过后，调用 `/add-feature-doc` 把需求落到对应模块

---

## 五·五、需求注册中心（Registry）与「先对齐、后实现」门禁

`docs/requirements-registry.html` 是一个本地看板：**所有功能需求与 Bug 需求都必须在此注册**，
用于跟踪每个需求从文档到落地的全流程状态。

### 强制规则：先对齐，后实现

每个需求强制经过 6 个环节（5 个必做环节 + 1 个人工门禁），顺序不可跳过：

```
① 需求文档 → ② 设计文档 → 🔒 人工 Check 门禁 → ③ 代码实现 → ④ 测试用例 → ⑤ 测试报告
```

| 环节 | 对应产物 | 状态 |
|---|---|---|
| 需求文档 | `prd.md`（或 bug 的 `analysis.md`） | 未开始 / 进行中 / 已完成 |
| 设计文档 | `design.md` | 未开始 / 进行中 / 已完成 |
| **人工 Check 门禁** | 人工确认文档已对齐 | 未就绪 / 待审批 / 已通过 |
| 代码实现 | 源码改动 | 锁定 / 未开始 / 进行中 / 已完成 |
| 测试用例 | 测试脚本 / 用例 | 锁定 / 未开始 / 进行中 / 已完成 |
| 测试报告 | 测试结果记录 | 锁定 / 未开始 / 进行中 / 已完成 |

**门禁约束**（做任何新任务前必须遵守）：

1. 先把 `需求文档` 与 `设计文档` 完善并对齐，二者都标记为「已完成」后，门禁才进入「待审批」。
2. 由人工点击「通过门禁」确认对齐，下游的 `代码实现 / 测试用例 / 测试报告` 才会解锁。
3. **未通过门禁前，下游 3 个环节始终锁定，禁止提前编码。** 这与项目规则
   「如果是做新需求，需要先实现需求分析文档和设计文档」一致。

> 注册中心数据存于浏览器 localStorage（key `agentmem_requirements`），可用页面内「导出/导入 JSON」迁移。

### Registry 入口

- 打开：[docs/requirements-registry.html](requirements-registry.html)
- 流程总纲：[docs/HARNESS.md](HARNESS.md)
- 任务认领协议：agent 用 `/claim-requirement` 从看板认领任务（git 乐观锁，实现类任务须门禁已过）；详见 HARNESS.md §5。
- 单一事实来源（SSOT）：[docs/requirements-registry.data.js](requirements-registry.data.js)（git 可追踪；看板按 `updatedAt` 合并）

### 任务认领协议

门禁通过后，agent 可从看板认领「可认领」的任务，认领后回写归属与进度，避免并发撞车。
完整状态机、字段语义与 git 乐观锁见 **[docs/HARNESS.md](HARNESS.md)**（研发流程总纲），认领动作用 `/claim-requirement` Skill。

---

## 六、写作约定

- **语言**：默认中文；引用代码符号/路径/命令保持英文原文
- **标题**：需求目录内的文档统一用 `# <需求名 - prd|design|plan|analysis>` 作为一级标题
- **路径引用**：使用相对于仓库根的路径，如 `src/hooks/index.ts`，不要写成 `D:\...` 或 `~/...`
- **跨需求引用**：用相对链接 `../<other-feature>/design.md`，方便 git mv 时编辑器一起改
- **简洁优先**：**不要长篇大论**。用要点、表格、图代替大段文字；能一句话讲清的不写一段。
- **图文并茂**（设计文档强制）：关键的框架/流程/时序/类关系**必须配图**。优先用 Markdown 内嵌 `mermaid`（可直接 diff、渲染）；复杂架构图用 `*.drawio`（附 `*.drawio.svg` 导出版）放在需求目录内。

---

## 六·五、工程设计规范（必读）

任何设计与编码都遵循以下基本原则；设计文档需体现是如何满足这些原则的：

| 原则 | 要求 |
|---|---|
| **单一职责（SRP）** | 一个模块/类/函数只做一件事，只有一个变化的理由。 |
| **开放封闭（OCP）** | 对扩展开放、对修改封闭；新增能力靠扩展点/插件，而非改既有稳定代码。 |
| **依赖倒置（DIP）** | 高层不依赖低层实现，二者都依赖抽象（接口）；具体实现可替换、可注入。 |
| **高内聚低耦合** | 相关逻辑收敛在同一边界内；跨模块通过清晰窄接口交互，减少相互了解。 |

> 落到本项目：插件通过 `PluginContext` 抽象访问能力（DIP）；新功能优先做成插件/扩展点（OCP）；模块边界对齐 `docs/README.md §二`（高内聚低耦合）。

---

## 七、AI 助手 / Skill 接入

需要新增需求文档时，优先用以下方式而不是手动 `mkdir`：

| 场景 | 调用 |
|---|---|
| 新功能 / 演进需求 | `/add-feature-doc` |
| 缺陷 / 线上 bug 分析 | `/add-bug-doc` |

两个 Skill 会问清楚：所属模块、需求名、需要哪些文件，然后按本范式落盘**空骨架**（带标准标题，正文留空）。

如果未启用 Skill，AI 助手应阅读本文档后手动遵循同样规则。

---

## 八、设计文档标准结构（design.md 必读）

写 `design.md` 按下面流程展开（按需取舍，但顺序与小节名保持一致）；**简洁、图文并茂**，每个分析点尽量配 mermaid/drawio 图：

```markdown
# <需求名> — 设计

## 1. 背景
为什么做、在什么情况下做（动机与触发场景）。

## 2. 需求目标
- 主要目标：可拆成多个需求细节——我们到底要做的是什么？

## 3. 需要确认的问题 / 遇到的问题
为达成目标，需要了解/学习/解决哪些疑惑？明确解决方向。

## 4. 现状分析（充分理解已有逻辑，降低制作难度）
- 流程框架分析：**框架图 / 流程图 / 时序图 / 类图**（mermaid 或 drawio）
- 协议分析
- 接口分析
- 配置 / 配表分析
- 针对现状提出潜在问题

## 5. 初步解决方案（可选，可在需求分析阶段细化）
描述关键数据、关键 API、关键流程：
- 提供可选方案 → 方案选择 → 确定实现方案
- 按方案拆分为小的技术需求
- 技术难点（性能优化 / 热更 / 高危风险）
- 方案注意问题
```

> 这套结构与「工程设计规范（§六·五）」配套：方案部分需说明如何满足 SRP / OCP / DIP / 高内聚低耦合。bug 的 `analysis.md` 可复用 §1/§3/§4 部分。
