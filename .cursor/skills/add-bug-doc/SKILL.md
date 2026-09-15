---
name: add-bug-doc
description: Scaffold a new bug-analysis directory under docs/<module>/bugs/<name>/ following the project doc convention (see docs/README.md). Use when the user reports a bug that needs written analysis, asks to "write a bug analysis", "归档这个问题", "为 xxx 这个 bug 起一份分析文档", "记录线上问题", or wants to document a defect/regression/incident.
---

# Add Bug Doc

Creates a new bug analysis scaffold under `docs/<module>/bugs/<bug-name>/`,
following the convention defined in `docs/README.md`.

## Required behavior

When invoked:

1. **Read `docs/README.md`** first if you have not in this session — it is the source of truth for modules, naming, and file conventions. Do not improvise; do not invent new modules.

2. **Gather inputs by asking the user up to 3 short questions** (skip a question if the user already provided the info):
   - 所属模块（必选其一）：`memory-core` / `hooks-adapter` / `desktop` / `viewer` / `shadowfolk` / `openclaw` / `release`
   - bug 名（kebab-case，描述现象而非猜测原因，例：`summary-image-missing`、`worker-port-leak`）
   - 是否已经有修复方案？如有 → 同时生成 `design.md`（写修复方案）；如未 → 仅生成 `analysis.md`

3. **Validate**:
   - 模块名必须在 7 个允许值之一；`00-architecture` 和 `_archive` **不允许**作为 bug 的归属。
   - bug 名全小写 kebab-case，长度 ≤ 60，不含日期前缀，与同模块下现有目录不重名（先列一下 `docs/<module>/bugs/` 现有目录核对）。
   - 命名要描述**可观察的现象**（如 `summary-image-missing`），不要写成 `fix-xxx` 或带主观判断。

4. **Create the directory and skeleton files** at `docs/<module>/bugs/<bug-name>/`.
   `analysis.md` 必备；用户已有修复方案时追加 `design.md`。Body 留空。

5. **Update the index** in `docs/README.md` §四（当前模块索引）— 在对应模块下追加 `bugs/` 小节（如果该模块还没有 bugs 子节，先创建一个），把新 bug 加进去。保持已有顺序。

6. **Register into the SSOT seed** `docs/requirements-registry.data.js`（看板单一事实来源，自动分配编号）：
   - 读取文件里的 `window.SEED_REQUIREMENTS` 数组。
   - 计算 `code`：扫描所有现有 `code`，取 `BUG-NNN` 的最大号 +1，三位零填充（无则 `BUG-001`）。
   - 追加一个对象（保持数组为合法 JS）：
     ```js
     {
       id: "<bug-name>",
       code: "BUG-NNN",
       title: "<一句话现象>",
       type: "bug",
       module: "<module>",
       path: "docs/<module>/bugs/<bug-name>/",
       created: "<YYYY-MM-DD>",
       phases: { prd:"todo", design:"todo", gate:"locked", impl:"todo", testcase:"todo", testreport:"todo" },
       status: "open", assignee: null, claimedAt: null,
       updatedAt: "<ISO now>"
     }
     ```
     > bug 无 PRD：把 `prd` 视作 `analysis`（分析文档），`design` 为修复方案；用户若只生成了 `analysis.md`，可把 `design` 留 `todo`。
   - 不要改动其它条目；不要 `git commit`（交给用户）。

7. **Report** the created paths, the assigned `code`, and a one-line suggested next step。

## Templates

### analysis.md（必备）

```markdown
# <bug-name> — 分析

## 现象

## 复现步骤

## 影响范围

## 根因分析

## 待决策 / 后续行动
```

### design.md（仅当用户已有修复方案时生成）

```markdown
# <bug-name> — 修复方案

## 方案概述

## 关键改动

## 回归风险

## 测试 / 验证方法
```

## Safety rules

- **Never overwrite** an existing file. If `docs/<module>/bugs/<bug-name>/<file>.md` already exists, abort that file and report it; ask the user how to proceed.
- **Never create files outside** `docs/<module>/bugs/<bug-name>/`.
- **Do not create** `prd.md` inside a bug directory — bugs don't have PRDs by convention. Use `/add-feature-doc` instead if the request is really a feature.
- **Do not create** `README.md`, `notes.md`, or any other filename inside the bug directory.
- **Do not commit or push** automatically; leave that to the user.
- If `docs/README.md` is missing, abort and instruct the user to restore it — the skill depends on it.

## Final response format

```text
已按范式创建：
- docs/<module>/bugs/<bug-name>/analysis.md
- docs/README.md（已更新索引）
- docs/requirements-registry.data.js（已注册，编号 BUG-NNN）

下一步：填入现象与复现步骤，或运行 git status 确认。
```
