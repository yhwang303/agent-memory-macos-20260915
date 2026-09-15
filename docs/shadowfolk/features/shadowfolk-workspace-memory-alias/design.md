# 设计：ShadowFolk 工作区记忆路径别名

> 日期：2026-05-14
> 关联功能：ShadowFolk Upload Plugin 的工程迁移兼容。

## 背景

用户可能把本地 Git 工程从一个磁盘迁移到另一个磁盘，例如从 `E:/Github/foo` 移到 `D:/Github/foo`。迁移后，旧路径不再是 Git 工作区，ShadowFolk 上传插件无法再把旧路径加入上传列表。

当前上传流程有两个路径假设：

- 上传工作区必须能通过 `git rev-parse --show-toplevel` 校验。
- 记忆导出按 `observations.project` 和 `session_summaries.project` 的路径前缀匹配工作区。

因此只配置新的 `D:/Github/foo` 时，Git 信息可以正常上传，但旧 `E:/Github/foo` 下保存的记忆不会被导出。只配置旧 `E:/Github/foo` 时，记忆能匹配，但 Git 校验失败，上传无法开始。

## 目标

- 支持“新 Git 工作区 + 旧记忆路径”的迁移场景。
- 保持 Git root、commit、branch、remote、push-record 都以当前真实 Git 工作区为准。
- 允许一个上传工作区关联多个记忆路径别名，用于导出旧路径下的 observations 和 summaries。
- 兼容现有 `shadowfolkWorkspaces: string[]` 配置，不要求用户手动迁移配置文件。
- 在设置页提供可理解的修复入口，避免用户误以为旧记忆丢失。

## 非目标

- 不把非 Git 路径作为独立上传工作区。
- 不修改历史数据库里的 `project` 字段。
- 不改变 ShadowFolk 服务端 push-record 的 key 语义，仍以当前 Git root 作为上传进度标识。
- 不自动扫描全盘寻找迁移关系。
- 不处理两个不同 Git 仓库被用户手动声明为同一个工程后的语义冲突；这类配置由用户确认承担。

## 推荐方案

采用“工作区记忆路径别名”模型。

上传工作区仍是一个真实 Git root，例如 `D:/Github/foo`。该工作区可以额外绑定若干 `memoryRoots`，例如 `E:/Github/foo`。上传时：

- Git payload 使用 `D:/Github/foo`。
- Memory payload 的过滤根使用 `D:/Github/foo` 和 `E:/Github/foo`。
- Nested repo 排除仍以当前 Git root 下实际存在的嵌套仓库为准。
- 上传成功后，ShadowFolk push-record 和本地 push history 都归属当前 Git root。

这种方案不破坏现有上传模型，也不改写数据库历史路径。旧记忆仍保留原始来源，新路径下的新记忆也能自然进入同一个上传工作区。

## 备选方案

### 方案 A：改写数据库 project 路径

提供一次性迁移工具，把 `E:/Github/foo` 下的历史记忆全部改成 `D:/Github/foo`。

优点是上传逻辑最简单。缺点是破坏历史原始路径，误操作后难恢复，也会影响本地历史查询中“当时在哪个路径工作”的语义。

### 方案 B：允许非 Git 记忆项目上传

允许用户把旧 `E:/Github/foo` 作为 memory-only 工作区加入上传列表。

优点是 UI 容易理解。缺点是缺少 Git root、remote、branch、commit 游标，和 ShadowFolk 当前按 Git 工程维护 push-record 的模型冲突较大，后续重推和增量游标也会变复杂。

### 方案 C：工作区记忆路径别名

当前推荐方案。它把“真实 Git 工程”和“历史记忆路径”分开建模，上传身份稳定，记忆范围可扩展，兼容已有配置。

## 配置模型

保留现有字段：

```ts
shadowfolkWorkspaces: string[]
```

新增字段：

```ts
shadowfolkWorkspaceAliases: Array<{
  workspace: string;
  memoryRoots: string[];
}>
```

规则：

- `workspace` 存当前 Git root 的规范化路径。
- `memoryRoots` 存旧记忆路径或额外需要合并的记忆路径。
- `memoryRoots` 不需要存在于文件系统，也不需要是 Git 工作区。
- `memoryRoots` 需要做路径规范化、去重和空值过滤。
- 旧配置没有 `shadowfolkWorkspaceAliases` 时等价于所有工作区无别名。
- 如果 `shadowfolkWorkspaces` 中某个工作区被移除，其别名配置也应移除。

示例：

```json
{
  "shadowfolkWorkspaces": ["D:/Github/foo"],
  "shadowfolkWorkspaceAliases": [
    {
      "workspace": "D:/Github/foo",
      "memoryRoots": ["E:/Github/foo"]
    }
  ]
}
```

## Uploader 数据流

`pushWorkspaces()` 需要从只接收 `string[]` 扩展为接收工作区配置对象，或在 Worker 层把配置展开后传入 uploader。

推荐内部结构：

```ts
type ShadowFolkWorkspaceConfig = {
  workspace: string;
  memoryRoots?: string[];
};
```

上传步骤：

1. 校验 `workspace` 必须是 Git 工作区或其子目录。
2. 解析当前 `gitRoot`。
3. 构造 `projectRoots = [gitRoot, workspace, ...memoryRoots]`。
4. 去重并规范化 `projectRoots`。
5. 用 `projectRoots` 导出 observations 和 summaries。
6. Git commits、stats、remote、branch、push-record 仍只使用 `gitRoot`。
7. 上传成功后，本地历史记录增加 `memoryRoots` 字段，方便后续解释和重推。

历史区间重推和全量重推也必须使用同一组 `memoryRoots`，否则用户修复配置后，正常上传能带旧记忆，但重推仍漏掉旧记忆。

## Worker API

新增或扩展配置接口：

- `POST /api/shadowfolk/config` 接收 `workspaces` 和 `workspaceAliases`。
- `GET /api/shadowfolk/status` 返回 `workspaceList` 时可附带每个工作区的别名数量，便于 UI 展示。
- `POST /api/shadowfolk/workspaces/validate` 仍只校验真实上传工作区，不校验别名路径的 Git 状态。

可选新增接口：

```http
POST /api/shadowfolk/workspaces/suggest-aliases
```

输入当前 Git root，输出记忆库中“同名目录但不同盘符/上级路径”的候选旧路径。这个接口只做辅助推荐，不自动写配置。

## 设置页 UI

每个上传工作区卡片增加一个轻量区域：

```text
D:/Github/foo                                      [移除]
记忆路径：D:/Github/foo
旧路径别名：E:/Github/foo                         [移除]
[从已记录项目添加旧路径] [手动输入旧路径]
```

行为：

- 添加上传工作区时仍必须选择或输入真实 Git 工作区。
- 如果用户从已记录项目下拉框选择的路径不是 Git 工作区，显示提示：“该路径不是 Git 工作区，可作为某个工作区的旧记忆路径绑定。”
- 用户选择要绑定到哪个现有工作区后，将该路径加入 `memoryRoots`。
- 如果存在同名目录候选，例如 `E:/Github/foo` 和 `D:/Github/foo`，UI 可以提示“一键绑定旧路径”。
- 工作区卡片显示别名数量，降低“为什么旧记忆没有上传”的排查成本。

## 错误处理

- 上传工作区 Git 校验失败：仍阻止添加或上传。
- 别名路径不存在：允许保存，只给出弱提示，因为旧路径可能只是数据库中的历史 project。
- 别名路径和工作区路径重复：自动去重。
- 别名路径被多个工作区引用：保存前提示用户确认；MVP 可以阻止重复引用，避免同一批记忆被重复上传。
- 旧路径记忆没有新增内容：上传结果显示该工作区无 memory 增量，不视为错误。

## 安全与一致性

别名只扩大 memory 导出范围，不改变 Git 上传身份。服务端看到的工程仍是当前 Git root，避免同一个工程迁移后在 ShadowFolk 中裂成两个项目。

因为别名可能把两个实际不同项目的记忆合并到一个上传工作区，UI 必须让用户显式确认，不能自动静默绑定。自动建议只能作为候选，不自动保存。

## 测试计划

- `ShadowFolkUploader`：新 Git root 绑定旧 memoryRoot 时，能导出旧路径 observations 和 summaries。
- `ShadowFolkUploader`：Git payload 仍使用新 Git root，push-record key 仍是新 Git root。
- `ShadowFolkUploader`：别名路径不存在时不影响 memory 导出。
- `WorkerService`：配置读取兼容旧 `string[]`，并能传递 aliases 到 push/replay/full repush。
- `SettingsWindow`/renderer contract：非 Git 记忆项目不能作为上传工作区，但可以作为旧路径别名添加。
- UI：移除工作区时同步移除别名；重复别名会被去重或阻止。

## 发布与迁移

发布后无需自动迁移配置。已有用户的 `shadowfolkWorkspaces` 继续可用。

当用户遇到迁移场景时，设置页提供修复入口：

1. 添加新的真实 Git 工作区。
2. 将旧路径作为该工作区的记忆路径别名。
3. 保存配置。
4. 立即上传或全量重推。

对已经因为路径迁移导致失败的用户，这个流程不需要修改数据库，也不要求恢复旧 E 盘目录。

## 设计自检

- 没有引入 memory-only 上传身份，避免破坏 push-record 模型。
- 没有改写历史数据库，保留原始路径信息。
- 旧配置保持兼容，新字段缺失时行为不变。
- 正常上传、全量重推、历史区间重推都共享同一套 memoryRoots 过滤规则。
- 方案聚焦于本地工程迁移，不包含全盘自动发现或跨项目合并治理。
