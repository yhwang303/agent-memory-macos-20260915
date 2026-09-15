# server-admin-memory-display-parity — 设计

## 总体方案

只调整服务端 `agent-memory-backend/web/admin.html` 中 `renderMem(item, type)` 的**字段取用逻辑**，使「总结 / 会话 / 操作」卡片的标题、预览取用的字段与客户端 `agent-memory/web/viewer.html` 的卡片字段映射一致。标签行与交互形态保持不变。

无后端、无数据库、无同步逻辑改动；纯前端展示层一处函数的字段映射对齐。

## 关键决策

1. **只对齐字段，不对齐样式与交互**：admin 保留就地展开、保留账号/IDE/设备/项目标签；viewer 保留弹窗详情。两端只要"取同一字段当标题/预览"即可消除"内容不一样"的错觉。
2. **标题以 `request` 为准**：summary 卡片标题统一取 `request`（用户意图），而非现状的 `completed`。这是本次问题的核心。
3. **正文展开沿用 admin 现有结构化分节**（`# 请求 / # 调研 / # 学到 / # 完成 / # 下一步 / # 备注`）。viewer 的完整字段在弹窗里、admin 在展开正文里，承载形式不同但字段集合一致，无需强行统一为弹窗。
4. **兜底口径对齐 viewer**：viewer 用 `safeText(x, fallback)` + `truncate`，admin 对应字段缺失时用同样的 fallback 文案，避免出现空标题或字段错位。

## 字段映射对齐表

下表「目标」列即 admin `renderMem` 改造后应取用的字段，与 viewer 卡片保持一致。

### 总结 summaries

| 元素 | viewer（基准） | admin 现状 | admin 目标 |
|------|----------------|------------|------------|
| 标题 | `request` | `completed ‖ request` | **`request`**（fallback `'(无标题)'`） |
| 预览 | `completed ‖ learned` | `learned ‖ investigated` | **`completed ‖ learned`** |
| 展开正文 | 弹窗：request/investigated/learned/completed/next_steps/notes | 结构化分节同字段 | 保持现状（字段集合已一致） |

### 操作 observations

| 元素 | viewer（基准） | admin 现状 | admin 目标 |
|------|----------------|------------|------------|
| 标题 | `title ‖ type` | `title ‖ type` | 保持（已一致） |
| 预览 | `narrative ‖ text` | `subtitle ‖ text ‖ narrative` | **`narrative ‖ text`** |
| 展开正文 | 弹窗字段 | text/narrative/facts/concepts | 保持现状 |

### 会话 sessions

| 元素 | viewer（基准） | admin 现状 | admin 目标 |
|------|----------------|------------|------------|
| 标题 | `user_prompt ‖ session_id` | `user_prompt` | **`user_prompt`**（fallback `'(no prompt)'`，已基本一致） |
| 预览 | `last_assistant_message` | `status` | 见下方「兼容性」——服务端无该字段，保留 `status` 作为降级 |
| 展开正文 | 弹窗字段 | user_prompt | 保持现状 |

## 数据流 / 时序

不变。`admin.html` → `GET /api/v1/admin/memory/{type}` → 服务端 `summaries/sessions/observations` 表 → 返回行 → `renderMem` 渲染。本需求只改最后一步 `renderMem` 的字段取用。

## 接口变更

无。不新增 / 不修改任何 API 字段。

## 兼容性与迁移

- **session 预览字段缺口**：viewer 的会话预览用 `last_assistant_message`，但服务端 `sessions` 表（见 `agent-memory-backend/src/routes/sync.ts` 的 `insSession`）并不存储该字段。故 admin 会话预览无法严格对齐，**降级保留 `status`**（或留空），并在 PRD 验收中将会话预览标注为"尽力对齐"。如需完全一致，需另立需求让客户端同步 `last_assistant_message` 字段（不在本需求范围）。
- 改动是纯展示层、无状态、无迁移；旧数据立即按新字段映射呈现。
- 跨仓改动点：实现文件位于 `agent-memory-backend/web/admin.html`，本设计文档位于 `agent-memory/docs`。提交时在两仓 PR 描述里相互引用。

## 测试策略

1. 选同一条 summary（同 `memory_session_id`），分别在 viewer 与 admin 打开，核对卡片标题文字一致（均为 `request`）、预览一致。
2. 构造缺字段样本（如 `request` 为空），验证 admin 兜底文案与 viewer 一致，无空标题 / `undefined`。
3. observations / sessions 各取一条核对标题与预览字段。
4. 回归：admin 标签行（账号/IDE/设备/项目/时间）与就地展开交互保持正常。
