---
name: claim-requirement
description: 从需求注册中心认领一条任务并推进。当用户要求"从需求列表认领任务"、"挑一个待办推进"、"领一个需求来做"、"看看有什么可做的"时使用。
---

# Claim Requirement

从 `docs/requirements-registry.data.js`（SSOT）认领一条任务，遵循 harness 的"文件即队列、git 即锁"。

## 流程

1. **同步**：`git pull --rebase`，读取 `docs/requirements-registry.data.js` 的 `window.SEED_REQUIREMENTS`。
2. **筛选 claimable**：
   - 文档类任务（写 prd/design）：对应 `phases.prd|design != done` 且 `assignee` 为空，门禁前即可认领。
   - 实现类任务（impl/testcase/testreport）：**必须 `phases.gate == "passed"`** 且 `assignee` 为空、`status != done`。
3. **选一条**：优先用户指定；否则取最早 `updatedAt`、未被占用的一条。一次只认领一条。
4. **认领（持锁）**：写入该需求 `assignee`（格式见偏好，缺省 `agent:<model>@<session>`）、`claimedAt`、`status:"in-progress"`、刷新 `updatedAt` → `git commit && git push`。
   - push 被拒（他人已先认领）→ 放弃该条，回到第 1 步换一条。
5. **执行**：按 `path` 下的 prd/design 推进对应环节。
6. **回写**：完成后更新 `phases`（如 `impl:"done"`）、必要时 `status:"done"`，刷新 `updatedAt` → commit。遇阻塞写明原因并把 `status:"blocked"`、清空 `assignee` 释放。

## 安全约束

- **不得擅自通过门禁**（`gate` 只能由人审核后置 `passed`）。
- 实现类任务认领前必须确认 `gate == "passed"`。
- 一次只认领一条；认领即立刻 commit/push 占位。
- 只改自己认领的那条记录，不动他人 `assignee`。
