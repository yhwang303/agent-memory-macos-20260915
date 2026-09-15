# 05 · OpenClaw 只写 `config.json` 不能被宿主加载

## 现象
- 安装器把 `~/.openclaw/plugins/agent-memory/config.json` 写好了，但 `openclaw plugins inspect agent-memory` 始终显示 `not loaded`。
- 启动 OpenClaw agent 后，hooks 完全没触发，记忆库也收不到任何 observation。

## 根本原因
- OpenClaw 2026 版的插件加载约定**不只是**有一份 config 就行，至少需要：
  1. 一个完整的插件目录：`package.json`（含 `openclaw.extensions`）、`openclaw.plugin.json`、`index.js`。
  2. `index.js` 用 SDK 暴露的 `definePluginEntry({ register(api) { api.on(...) } })` 注册 hooks。
  3. 通过 `openclaw plugins install --link <dir>` 把目录登记进 `~/.openclaw/openclaw.json` 的 `plugins.load.paths`。
  4. `~/.openclaw/openclaw.json` 中 `plugins.entries.agent-memory.hooks.allowConversationAccess = true`，否则即便加载也拿不到对话内容。
  5. 让 `openclaw gateway restart`（或重启 OpenClaw 进程）让加载生效。

## 解决
- `src/services/integrations/OpenClawInstaller.ts` / `desktop/src/services/OpenClawRegistrar.ts` 改成"一条龙"：
  - 写完整插件目录（4 个文件）。
  - 调 `openclaw plugins install --link`。
  - 合并 `openclaw.json`（保留用户其它配置，只追加自己的条目和 path）。
  - 设置 `allowConversationAccess: true`。
  - 尝试 `openclaw gateway restart`，失败也不报错。
- 验证：`openclaw plugins inspect agent-memory` 能看到 5 个 typed hooks 注册成功。

## 教训
- 集成第三方平台时不要只看"配置文件长什么样"，必须按它们的安装/注册命令走完整流程。
- "用户自己再装一下插件"在桌面端是不可接受的，必须做到 install/uninstall 完全自动。
