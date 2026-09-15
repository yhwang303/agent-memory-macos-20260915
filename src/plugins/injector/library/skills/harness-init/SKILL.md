---
name: harness-init
description: 初始化 harness 偏好并写入项目规则。当用户要求"初始化 harness"、"配置偏好"、"接入这套流程规范"，或检测不到偏好受管块时使用。
---

# Harness Init

问询用户偏好，写入 `.cursor/rules/harness-preferences.mdc` 的受管块，供后续建档/展示读取，避免重复询问。

## 流程

1. **结构化问询**（用单/多选问题逐项问，已知则跳过）：
   - **文档展示形态**：`md` / `html` / `both`
   - 默认语言：`中文` / `English` / …
   - assignee 格式：默认 `agent:<model>@<session>`
2. **写入受管块**：渲染进 `.cursor/rules/harness-preferences.mdc`，**只重写 `start/end` 之间**，块外人工内容不动：

   ```
   <!-- harness:preferences:managed:start -->
   ## Harness 偏好（自动生成，可重新问询覆盖）
   - 文档展示形态: <md|html|both>
   - 默认语言: <…>
   - assignee 格式: <…>
   <!-- harness:preferences:managed:end -->
   ```
3. **回显** 写入内容，提示"以后建档将按此执行，可随时重新运行覆盖"。

## doc.format 影响

- `md`（默认）：仅 `*.md`。
- `html`：每份文档产出/展示 `*.html`。
- `both`：`*.md` 为可 diff 的源 + 附 `*.html` 渲染版（Markdown 始终为源，禁止只存 HTML）。

## 安全约束

- 只动受管块，不删用户手写规则。
- 重复运行幂等覆盖；文件不存在则创建（带 frontmatter `alwaysApply: true`）。
