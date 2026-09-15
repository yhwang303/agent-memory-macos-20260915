# 设计：ShadowFolk 桌面端上传工作区与每日同步

> 日期：2026-05-07
> 关联功能：ShadowFolk Upload Plugin 在桌面端通过内置 Node Worker 上传本地记忆。

## 背景

ShadowFolk 上传插件最初来自 `shadow-push.py`：用户通过 skill 手动指定 `--workspace`，脚本读取该 Git workspace 的提交增量和 `agent-memory.db` 中对应项目的记忆，再上传到 ShadowFolk。

桌面端当前已经具备内置 Node 运行环境，因此 Windows App 不需要依赖 Python。桌面端上传逻辑应由 Worker 内的 Node uploader 执行，但必须保留原脚本的两个关键语义：

- 上传目标继续复用 `~/.shadow/config.json` 中的 `server` 和 `api_token`。
- 上传范围必须由用户显式指定，不能静默扫描并上传本地数据库里的所有历史项目。

## 目标

- 在 Settings 的 Plugins 页签中提供“上传工作区”列表。
- 用户手动添加、删除工作区；系统添加时做 Git workspace 校验。
- 自动上传从“每 N 秒”改为“每天北京时间 HH:mm 上传一次”。
- 保留“立即上传一次”，立即上传使用同一组工作区列表。
- 修正 API Token 显示逻辑：用户点击显示时能看到真实 token，而不是脱敏星号。

## 非目标

- 不新增“自动扫描全库并上传所有项目”的默认行为。
- 不为每个 ShadowFolk server 维护多套工作区列表；当前桌面端只支持一个全局 ShadowFolk 目标和一组全局上传工作区。
- 不把 ShadowFolk 上传并入 agent-memory 原有 remote sync / auto-share 链路。
- 不要求 Linux/CLI Python 插件也立刻支持桌面端全部 UI 配置；Python 插件仍可继续用自己的 config/daemon 形态。

## 用户界面

Plugins 页签中 ShadowFolk 区域分为四块：

```text
ShadowFolk Upload Plugin

上传地址
[ http://9.134.128.138:8080                         ]

API Token
[ ********                                      ] [显示]

自动上传
[x] 启用每日自动上传
北京时间 [ 23:30 ]

上传工作区
[ E:\Github\agent-memory                         ] [移除]
[ D:\GitHub\shadow-folk\shadow-task-summarizer   ] [移除]

[添加当前项目] [手动添加路径] [从记忆库发现...]

[立即上传一次] [刷新状态]
状态：已启用，已配置 2 个工作区，下次上传 今天 23:30，北京时间
```

文案上统一使用“上传工作区”，不使用“组合”。

## 工作区列表语义

每个上传工作区代表一个 Git repository 的上传范围。

添加路径时必须立即校验：

1. 路径存在。
2. 路径是 Git workspace 或 Git workspace 的子目录。
3. 通过 `git rev-parse --show-toplevel` 解析 Git root。
4. 解析失败则添加失败，提示“该路径不是 Git 工作区或其子目录”。
5. 如果解析出的 Git root 已存在于列表中，则不重复添加，提示“该项目已在上传列表中”。

保存时也需要重新校验一遍列表，避免路径被删除或 Git 仓库状态变化。

内部建议保存 Git root，而不是保存用户输入的子目录。这样 UI 显示、去重和上传游标都稳定一致。若用户输入的是子目录，添加成功后列表展示其 Git root。

## 工作区发现

“从记忆库发现...”只用于辅助填充列表，不触发自动上传。

行为：

- 从 `observations` 和 `session_summaries` 的 `project` 字段读取历史项目路径。
- 对每个路径执行 Git root 校验。
- 按 Git root 去重。
- 以选择列表展示给用户。
- 只有用户主动选择并确认后，才加入上传工作区列表。

这避免当前 `pushAll()` 静默扫描全库导致上传范围过宽。

## 上传流程

无论是每日自动上传还是“立即上传一次”，都使用相同流程：

1. 读取 `~/.shadow/config.json` 的 `server` 和 `api_token`。
2. 读取桌面配置里的上传工作区列表。
3. 对每个工作区重新执行 Git root 校验。
4. 同一 Git root 去重后逐个上传。
5. 每个工作区独立执行：
   - `GET /api/push/push-records/{git_root}`
   - 收集 git commit / diff stats
   - 按 Git root 从 `agent-memory.db` 导出增量 `observations` / `session_summaries`
   - `POST /api/push/raw`
   - `PUT /api/push/push-records/{git_root}`
6. 单个工作区失败不影响后续工作区。
7. 汇总返回成功、无新增和失败列表。

状态展示至少包含：

- 是否启用。
- ShadowFolk 是否已配置。
- 工作区数量。
- 当前是否上传中。
- 下次自动上传时间。
- 上次成功时间。
- 最近一次每个工作区的结果。
- 最近错误。

## 每日北京时间同步

桌面端不再配置秒级上传间隔，改为每日固定北京时间：

```json
{
  "shadowfolkEnabled": true,
  "shadowfolkDailyTime": "23:30",
  "shadowfolkTimezone": "Asia/Shanghai"
}
```

调度规则：

- Worker 启动时计算下一次 `Asia/Shanghai` 的 `HH:mm` 对应的本地时间。
- 到点后执行一次上传。
- 上传结束后重新计算下一天同一北京时间。
- 如果 App 在当天计划时间之后启动，默认不补跑，等待下一天。
- 用户可随时点击“立即上传一次”。
- 如果定时上传与立即上传重叠，只允许一个上传任务运行；另一个请求返回“上传正在运行”。

北京时间固定为 `Asia/Shanghai`，UI 只显示“北京时间”，暂不提供多时区选择。

## Token 显示

当前 UI 的“显示”按钮只切换 input type，但输入框值已经是 `********`，所以显示后仍然是星号。

修正设计：

- `shadowfolk:get-config` 默认返回 `apiToken: "********"` 和 `hasApiToken: true`。
- 新增 reveal IPC，例如 `shadowfolk:reveal-token`。
- 用户点击“显示”时，主进程读取 `~/.shadow/config.json` 并返回真实 `api_token`。
- 用户点击“隐藏”时恢复密码框。
- 保存时如果输入框仍为 `********`，不覆盖原 token。

由于 `~/.shadow/config.json` 本来就是 ShadowFolk skill 使用的明文 JSON，本设计不声称该 token 由 safeStorage 加密保存。

## 配置结构

桌面端 `desktop-config.json` 增加：

```json
{
  "shadowfolkEnabled": false,
  "shadowfolkDailyTime": "23:30",
  "shadowfolkWorkspaces": [
    "E:\\Github\\agent-memory"
  ]
}
```

`~/.shadow/config.json` 继续保存：

```json
{
  "server": "http://9.134.128.138:8080",
  "api_token": "sf_example_token",
  "memory_db": "C:/Users/minusjiang/.agent-memory/agent-memory.db"
}
```

桌面端 Node uploader 默认使用 agent-memory 自身打开的 `agent-memory.db`。若后续需要兼容 `memory_db` 指定路径，可作为单独扩展处理。

## 测试计划

- `ShadowFolkUploader`：
  - 只上传显式传入的工作区列表。
  - 同一 Git root 去重。
  - 非 Git 路径校验失败。
  - 单个工作区失败不影响其他工作区。
- Worker：
  - `/api/shadowfolk/workspaces/validate` 返回 Git root 或错误。
  - `/api/shadowfolk/push` 使用配置列表，不再自动扫描全库。
  - 每日调度能计算下一次北京时间运行时间。
  - 上传中重复触发返回 busy。
- Settings UI：
  - 添加路径成功后显示 Git root。
  - 重复 Git root 不重复加入。
  - 删除工作区后保存生效。
  - 点击显示 token 能看到真实 token。
  - 立即上传按钮展示汇总状态。

## 自检

- 没有默认上传全部历史项目的行为。
- 工作区添加和保存都有 Git 校验。
- 每日同步语义固定为北京时间，不引入多时区复杂度。
- Token 显示逻辑与 `~/.shadow/config.json` 明文存储现实一致。
- 设计不改变 agent-memory 原有 auto-share 同步链路。
