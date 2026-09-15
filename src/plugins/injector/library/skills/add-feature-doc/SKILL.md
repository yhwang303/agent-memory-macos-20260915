---
name: add-feature-doc
description: Scaffold a new feature requirement directory under docs/<module>/features/<name>/ following the project doc convention (see docs/README.md). Use when the user asks to add a new feature PRD, design doc, implementation plan, or wants to "create a new requirement", "write a PRD for X", "新建需求", "加个功能需求文档", "为 xxx 写需求文档/设计文档", "起一份 PRD".
---

# Add Feature Doc

Creates a new feature requirement scaffold under `docs/<module>/features/<requirement-name>/`,
following the convention defined in `docs/README.md`.

## Required behavior

When invoked:

1. **Read `docs/README.md`** first if you have not in this session — it is the source of truth for modules, naming, and file conventions. Do not improvise; do not invent new modules.

2. **Gather inputs by asking the user up to 3 short questions** (skip a question if the user already provided the info):
   - 所属模块（必选其一）：`memory-core` / `hooks-adapter` / `desktop` / `viewer` / `shadowfolk` / `openclaw` / `release`
   - 需求名（kebab-case，不带日期，例：`shadowfolk-batch-retry`）
   - 需要哪些文档（多选默认 prd + design）：`prd` / `design` / `plan` / `analysis`

3. **Validate**:
   - 模块名必须在 7 个允许值之一；`00-architecture` 和 `_archive` **不允许**作为新需求的归属。如果用户提的方向不在现有模块里，参考 docs/README.md §二的"模块边界判定原则"二次确认，不要自行创建新模块。
   - 需求名全小写 kebab-case，长度 ≤ 60，不含日期前缀，与同模块下现有目录不重名（先列一下 `docs/<module>/features/` 现有目录核对）。

4. **Create the directory and skeleton files** at `docs/<module>/features/<requirement-name>/`.
   Each requested file gets a standard heading skeleton (see Templates below). Body left blank.

5. **Update the index** in `docs/README.md` §四（当前模块索引）— append the new requirement under the matching module/features list. Keep the existing alphabetical/chronological order of that list.

6. **Register into the SSOT seed** `docs/requirements-registry.data.js`（看板单一事实来源，自动分配编号）：
   - 读取文件里的 `window.SEED_REQUIREMENTS` 数组。
   - 计算 `code`：扫描所有现有 `code`，取 `FEAT-NNN` 的最大号 +1，三位零填充（例：现有最大 `FEAT-002` → 新 `FEAT-003`；若无则 `FEAT-001`）。
   - 追加一个对象（保持数组为合法 JS）：
     ```js
     {
       id: "<requirement-name>",            // kebab-case，作内部稳定主键
       code: "FEAT-NNN",                    // 上一步算出的编号
       title: "<一句话标题>",
       type: "feature",
       module: "<module>",
       path: "docs/<module>/features/<requirement-name>/",
       created: "<YYYY-MM-DD>",
       phases: { prd:"todo", design:"todo", gate:"locked", impl:"todo", testcase:"todo", testreport:"todo" },
       status: "open", assignee: null, claimedAt: null,
       updatedAt: "<ISO now>"
     }
     ```
   - 不要改动数组里其它条目；不要 `git commit`（交给用户）。

7. **Report** the created paths, the assigned `code`, and a one-line suggested next step.

## Templates

Generate each file with the heading skeleton below. **Replace `<requirement-name>` with the actual kebab-case name; otherwise leave the body sections empty for the author to fill in.**

### prd.md

```markdown
# <requirement-name> — PRD

## 背景

## 目标

## 用户故事 / 使用场景

## 范围

### 包含

### 不包含

## 验收标准

## 风险与未决事项
```

### design.md

> 对齐 `docs/README.md §八 设计文档标准结构`：简洁、图文并茂（关键流程/框架/时序/类关系配 mermaid 或 drawio），并在方案中体现 §六·五 工程设计规范（SRP/OCP/DIP/高内聚低耦合）。

```markdown
# <requirement-name> — 设计

## 1. 背景
为什么做、在什么情况下做。

## 2. 需求目标
- 主要目标：可拆为多个需求细节——我们要做的是什么？

## 3. 需要确认的问题 / 遇到的问题
为达成目标需了解/学习/解决哪些疑惑，明确解决方向。

## 4. 现状分析
- 流程框架分析：框架图 / 流程图 / 时序图 / 类图（mermaid 或 drawio）
- 协议分析
- 接口分析
- 配置 / 配表分析
- 针对现状提出潜在问题

## 5. 初步解决方案（可选）
关键数据 / 关键 API / 关键流程：
- 可选方案 → 方案选择 → 确定实现方案（说明如何满足 SRP/OCP/DIP/高内聚低耦合）
- 拆分为小的技术需求
- 技术难点（性能 / 热更 / 高危风险）
- 方案注意问题
```

### plan.md

```markdown
# <requirement-name> — 实施计划

## 里程碑

## 任务拆分

## 依赖

## 风险与回滚
```

### analysis.md

```markdown
# <requirement-name> — 调研分析

## 问题描述 / 现状

## 调研发现

## 备选方案对比

## 推荐方案
```

## Safety rules

- **Never overwrite** an existing file. If `docs/<module>/features/<requirement-name>/<file>.md` already exists, abort that file and report it; ask the user how to proceed.
- **Never create files outside** `docs/<module>/features/<requirement-name>/`.
- **Do not create** `README.md`, `notes.md`, or any other filename inside the requirement directory — those are not part of the convention.
- **Do not commit or push** automatically; leave that to the user.
- If `docs/README.md` is missing, abort and instruct the user to restore it — the skill depends on it.

## Final response format

```text
已按范式创建：
- docs/<module>/features/<requirement-name>/prd.md
- docs/<module>/features/<requirement-name>/design.md
- docs/README.md（已更新索引）
- docs/requirements-registry.data.js（已注册，编号 FEAT-NNN）

下一步：填入需求背景，或运行 git status 确认。
```
