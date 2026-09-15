# 设计：ShadowFolk 推送历史与重推

> 日期：2026-05-11
> 关联功能：ShadowFolk Upload Plugin 的单工作区历史区间重推与全量重推。

## 背景

当前 ShadowFolk 上传按工作区维护增量游标。客户端从 ShadowFolk 读取当前 `push-record`，根据 `last_commit_hash`、`last_observation_id`、`last_summary_id` 导出增量，上传成功后再更新游标。

这个模型适合日常增量上传，但当 ShadowFolk 侧某个 batch 被删除时，客户端缺少一个简单入口来按过去的上传区间重推。用户希望本地记录每次成功上传的 `startCursor` 和 `endCursor`，之后可以选择一个历史区间重新推送。另一个独立需求是对单个工作区执行全量重推，即清空起点后从本地现有数据重新上传。

## 目标

- 每个工作区成功上传后，本地记录一条轻量历史区间。
- 支持选择某个历史区间，重新导出并上传该区间的数据。
- 支持单个工作区全量重推。
- 历史区间重推和全量重推成功后，将当前上传进度恢复到所选区间的终点或全量结果的终点。
- UI 绑定在每个上传工作区条目下，提示尽量少。

## 非目标

- 不保存完整 payload。历史文件只保存游标、计数、batchId、时间等元信息。
- 不支持一次全量重推所有工作区。
- 不做服务端 batch 删除或覆盖。重推总是生成新的 ShadowFolk batch。
- 不改变现有每日自动上传和“立即上传一次”的主流程语义。
- 不把重推历史同步到 ShadowFolk；历史账本是本机辅助恢复信息。

## 术语

`Cursor` 表示一个上传游标：

```json
{
  "commit": "hash-or-empty",
  "observationId": 123,
  "summaryId": 45
}
```

`startCursor` 是一次上传开始前的游标。`endCursor` 是这次上传成功后写入的游标。

历史区间重推的导出范围为 `(startCursor, endCursor]`：

- Git commits：`startCursor.commit..endCursor.commit`。
- observations：`id > startCursor.observationId && id <= endCursor.observationId`。
- summaries：`id > startCursor.summaryId && id <= endCursor.summaryId`。

全量重推等价于使用空 `startCursor`，并以当前本地可导出的最新数据作为 `endCursor`。

## 本地历史账本

新增本地 JSON 文件，建议路径：

```text
~/.agent-memory/shadowfolk-push-history.json
```

结构：

```json
{
  "version": 1,
  "entries": [
    {
      "id": "hist_20260511_112955_421526b5",
      "workspace": "D:/GitHub/shadow-folk",
      "gitRoot": "D:/GitHub/shadow-folk",
      "remote": "https://github.com/c001estb0y/shadow-folk.git",
      "branch": "feat/plugin-system",
      "mode": "normal",
      "startCursor": {
        "commit": "old-hash",
        "observationId": 100,
        "summaryId": 20
      },
      "endCursor": {
        "commit": "new-hash",
        "observationId": 160,
        "summaryId": 28
      },
      "batchId": "421526b5-d640-4f8c-bf70-49f26549ec8e",
      "counts": {
        "commits": 2,
        "observations": 60,
        "summaries": 8
      },
      "createdAt": "2026-05-11T11:29:55.605Z"
    }
  ]
}
```

写入规则：

- 只有成功上传且 `pushed: true` 的工作区才写历史。
- 每个工作区独立追加历史记录。
- 如果某次上传没有新增 commit、observation、summary，不写历史。
- 历史记录按 `createdAt` 倒序展示。
- MVP 不自动清理历史；因为只存游标和元信息，体积很小。后续可增加“每工作区保留最近 N 条”。

## 正常上传数据流

正常每日上传和立即上传保持当前行为，只在成功后追加历史：

1. 校验工作区并解析 Git root。
2. 读取当前 ShadowFolk `push-record`。
3. 构造 `startCursor`。
4. 根据当前主流程导出增量 payload。
5. 上传到 `/api/push/raw`。
6. 根据上传结果构造 `endCursor`。
7. 更新 ShadowFolk `push-record` 为 `endCursor`。
8. 追加本地历史记录。

如果第 5 步成功但第 7 步失败，视为整次上传失败，不写本地历史。这样避免本地历史显示“可重推”，但实际当前游标没有推进。

## 历史区间重推数据流

用户在某个工作区条目下选择历史记录并点击“开始”：

1. Worker 根据 `historyId` 读取本地历史记录。
2. 校验该记录属于当前工作区的 Git root。
3. 如果 `endCursor.commit` 非空，校验它仍可在本地 Git 中解析；如果不能解析，返回错误。若该历史区间没有 commit，允许只重推 memory 数据。
4. 使用 `(startCursor, endCursor]` 重新导出 payload。
5. 上传到 `/api/push/raw`。
6. 上传成功后，将 ShadowFolk 当前 `push-record` 更新为该记录的 `endCursor`。
7. 追加一条新的历史记录，`mode: "replay"`，其 `startCursor` / `endCursor` 与被重推记录一致，`sourceHistoryId` 指向原记录。
8. UI 显示“重推完成”。

重推历史区间时，不读取旧 payload。所有数据都从当前本地 Git 和 `agent-memory.db` 重建。

## 全量重推数据流

用户在某个工作区条目下选择下拉框第一项“全量重推”并点击“开始”：

1. Worker 校验工作区并解析 Git root。
2. 构造空 `startCursor`：
   - `commit: ""`
   - `observationId: 0`
   - `summaryId: 0`
3. 导出该工作区本地可导出的全部 observations 和 summaries。
4. Git commits 使用当前上传器的默认全量窗口。MVP 沿用现有 `getCommits()` 在无 `sinceHash` 时的策略，即最近 7 天 commit。
5. 上传到 `/api/push/raw`。
6. 上传成功后，将 ShadowFolk 当前 `push-record` 更新为全量结果的 `endCursor`。
7. 追加一条新的历史记录，`mode: "full"`。
8. UI 显示“全量重推完成”。

全量重推只作用于单个工作区，不提供“一键全量重推全部工作区”。

## UI 设计

重推入口放在每个上传工作区条目下，不新增独立大模块。

默认折叠：

```text
D:/GitHub/shadow-folk                         [移除]
  [重推]

E:/Github/agent-memory                        [移除]
  [重推]
```

点击某个工作区的“重推”后，在该条目下展开：

```text
D:/GitHub/shadow-folk                         [移除]
  [重推]
  范围 [ 全量重推                              v ] [开始]
       [ 2026-05-11 19:29 · 2 commits · 62 obs · 7 summaries ]
       [ 2026-05-10 19:40 · 2 commits · 22 obs · 3 summaries ]
```

交互规则：

- 下拉框第一项固定为“全量重推”。
- 后续选项是该工作区历史区间，按时间倒序。
- 文案尽量短，不展示大段解释。
- 点击“开始”时弹确认框：
  - 全量重推：`确认全量重推该工作区？`
  - 历史区间：`确认重推所选历史区间？`
- 重推运行中禁用该工作区的“开始”按钮。
- 成功或失败统一复用现有状态区域展示一句话。

状态示例：

```text
重推完成，已恢复到所选区间终点。
```

```text
全量重推完成，已恢复到最新游标。
```

## Worker API

新增 Worker 内部 API，供 SettingsWindow IPC 代理调用：

```text
GET  /api/shadowfolk/history?workspace=...
POST /api/shadowfolk/replay
```

`GET /api/shadowfolk/history` 返回该工作区的下拉选项：

```json
{
  "success": true,
  "workspace": "D:/GitHub/shadow-folk",
  "gitRoot": "D:/GitHub/shadow-folk",
  "options": [
    {
      "kind": "full",
      "label": "全量重推"
    },
    {
      "kind": "history",
      "historyId": "hist_20260511_112955_421526b5",
      "label": "2026-05-11 19:29 · 2 commits · 62 obs · 7 summaries"
    }
  ]
}
```

`POST /api/shadowfolk/replay` 请求：

```json
{
  "workspace": "D:/GitHub/shadow-folk",
  "kind": "history",
  "historyId": "hist_20260511_112955_421526b5"
}
```

全量重推请求：

```json
{
  "workspace": "D:/GitHub/shadow-folk",
  "kind": "full"
}
```

返回沿用当前上传结果形状，并增加 `mode` 和 `historyEntry`：

```json
{
  "success": true,
  "mode": "replay",
  "result": {
    "workspace": "D:/GitHub/shadow-folk",
    "pushed": true,
    "batchId": "new-batch-id",
    "observations": 62,
    "summaries": 7,
    "commits": 2
  },
  "historyEntry": {
    "id": "hist_20260511_120001_new"
  }
}
```

## Uploader 内部接口

`ShadowFolkUploader` 增加三个内部能力：

- `pushWorkspaceRange(workspace, startCursor, endCursor, options)`：按显式游标区间导出和上传。
- `repushWorkspaceFull(workspace)`：单工作区全量重推。
- `replayHistoryEntry(historyEntry)`：校验历史记录并按区间重推。

正常上传可以继续使用现有 `pushWorkspace()`，但需要在内部明确构造 `startCursor` 和 `endCursor`，以便写入历史。

区间导出需要扩展当前实现：

- 当前 `getCommits(gitRoot, sinceHash)` 只支持 `sinceHash..HEAD`。需要新增对 `start..end` 的支持；当 `start` 或 `end` 为空时，按现有默认窗口或 memory-only 区间处理。
- 当前 `exportRows(..., lastId)` 只支持 `id > lastId`。需要新增 `maxId` 参数，支持 `id > start && id <= end`。

## 错误处理

- 历史文件不存在：返回只有“全量重推”的选项。
- 历史文件损坏：保留损坏文件为 `.corrupt.<timestamp>`，重新创建空历史，并在状态中提示“历史记录损坏，已重建”。
- 历史记录不属于该工作区：拒绝重推。
- 本地 Git 找不到非空的 `endCursor.commit`：拒绝历史区间重推，提示“本地 Git 已找不到该历史终点”。如果历史区间没有 commit，则不做该校验。
- 本地 DB 中区间数据缺失：允许上传可导出的子集，但结果计数会反映实际上传数量。
- 上传成功但更新游标失败：返回失败，不写历史。
- 同一时间只允许一个 ShadowFolk 上传或重推任务运行，复用现有 running 状态。

## 测试计划

- `ShadowFolkUploader`：
  - 正常上传成功后写入 `startCursor` 和 `endCursor`。
  - 历史区间重推只导出 `(startCursor, endCursor]`。
  - 历史区间重推成功后更新当前游标为 `endCursor`。
  - 全量重推使用空起点并更新当前游标为最新结果。
  - Git 找不到历史 `endCursor.commit` 时拒绝重推。
- Push history store：
  - 历史文件不存在时返回空列表。
  - 追加记录保持 JSON 结构有效。
  - 按 Git root 过滤历史记录。
  - 损坏 JSON 会备份并重建。
- Worker：
  - `GET /api/shadowfolk/history` 返回全量重推和历史选项。
  - `POST /api/shadowfolk/replay` 支持 `kind: "history"`。
  - `POST /api/shadowfolk/replay` 支持 `kind: "full"`。
  - running 时拒绝重复重推。
- Settings UI：
  - 每个工作区条目下有折叠的“重推”入口。
  - 下拉框第一项是全量重推。
  - 历史记录按该工作区过滤并倒序展示。
  - 点击开始前有最短确认。
  - 成功或失败复用状态区域展示。

## 自检

- 设计没有保存完整 payload，只保存游标和元信息。
- 历史区间重推和全量重推是两个独立模式，但 UI 统一为单个下拉框。
- 全量重推限定为单个工作区，符合当前范围。
- 重推成功后会更新当前游标，符合“服务器删除后客户端重推恢复”的目标。
- UI 入口在每个工作区条目下，没有新增独立大区域。
