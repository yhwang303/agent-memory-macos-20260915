# 设计：桌面端 OpenClaw 关联

> 日期：2026-04-27
> 关联 PRD：`2026-04-27-desktop-openclaw-prd.md`

## 现状

桌面端设置页通过 `HooksRegistrar.detectIDEs()` 获取 hooks 型 IDE 列表，再通过 `HooksRegistrar.register/unregister()` 改写各 IDE 的 hooks 配置。OpenClaw 是 plugin 型集成，不适合放进 `desktop/src/shared/hooks-config.ts` 的 hooks 事件模型。

npm 版已有 `src/services/integrations/OpenClawInstaller.ts`，但 desktop 的 `tsconfig.json` `rootDir` 限制在 `desktop/src`，不能直接复用 root `src` 里的 ESM 实现。

## 方案

新增桌面端专用 `OpenClawRegistrar`，实现 App UI 所需的同步安装动作：

- `detect()`：检查 `~/.openclaw` 是否存在，或 PATH 中是否存在 `openclaw`。
- `status(port)`：检查 `~/.openclaw/plugins/agent-memory/config.json` 与 `index.js`。
- `register(port)`：创建完整插件包，写入配置，注册到 OpenClaw，刷新插件注册表，并尝试重启 Gateway。
- `unregister()`：从 OpenClaw 注册表卸载插件，并删除 `config.json`，保留插件目录，避免误删用户扩展文件。

`HooksRegistrar` 继续作为设置页 IPC facade，但返回值扩展为桌面集成列表：

- hooks 型 IDE：沿用 `DetectedIDE`。
- OpenClaw：追加 `{ type: 'openclaw', mechanism: 'plugin', ... }`。

设置页展示逻辑按 `mechanism` 切换文案：

- hooks：`关联 / 断开`
- plugin：`安装 / 移除`

## 配置格式

写入路径：

```text
~/.openclaw/plugins/agent-memory/config.json
```

同时写入完整 OpenClaw 插件入口：

```text
~/.openclaw/plugins/agent-memory/package.json
~/.openclaw/plugins/agent-memory/openclaw.plugin.json
~/.openclaw/plugins/agent-memory/index.js
```

默认内容：

```json
{
  "enabled": true,
  "project": "openclaw-gateway",
  "workerHost": "127.0.0.1",
  "workerPort": 3847,
  "syncMemoryFile": true,
  "syncMemoryFileExclude": ["debugger"],
  "observationFeed": {
    "enabled": false,
    "channel": "telegram",
    "to": ""
  }
}
```

其中 `workerPort` 使用桌面端当前配置端口。

## 安装流程

点击 App 设置页的 OpenClaw「安装」或运行 npm 安装命令时，安装器执行：

1. 先用 `openclaw plugins uninstall --force --keep-files agent-memory` 清掉旧注册，避免旧临时插件路径继续抢占。
2. 写入完整插件包和 `config.json`。
3. 执行 `openclaw plugins install --link ~/.openclaw/plugins/agent-memory`。
4. 清理 `openclaw.json` 里残留的旧 `agent-memory` load path，只保留正式插件目录。
5. 执行 `openclaw plugins registry --refresh`，并开启 `plugins.entries.agent-memory.hooks.allowConversationAccess=true`。
6. 尝试 `openclaw gateway restart`，让插件立即生效。

## 风险

- 如果用户系统没有 `openclaw` CLI，App 无法完成注册，只能返回安装失败信息。
- 删除时保留插件目录，可能留下空目录，这是有意保守处理。
- 如果用户同时测试 npm 版和 App 版，二者会写同一个 OpenClaw 配置路径，后写入者覆盖 `workerPort`。
