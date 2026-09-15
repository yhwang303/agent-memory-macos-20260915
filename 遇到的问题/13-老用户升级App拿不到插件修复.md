# 13 · 老用户升级 App 拿不到插件修复

## 现象
- 修完 `agentEnd.ts` + 两份内嵌 `PLUGIN_INDEX_JS` 模板，typecheck / 单测 / 本机 e2e 全过、闭环完美。
- 但是仔细一查桌面 App 启动流程，发现 **已装 OpenClaw 的老用户升级 App 后，部署版 `~/.openclaw/plugins/agent-memory/index.js` 不会被覆盖**。
- 后果：bug 修了等于没修——老用户的 OpenClaw 来源会话依然走旧逻辑、依然永远 400。

## 根本原因
桌面 App 在 `app.whenReady` 里有几条注册路径，但都对 OpenClaw 主动跳过：

```typescript
// HooksRegistrar.ts
hasNewUnregisteredIDEs(): boolean {
  return detectIDEs().some((d) => d.type !== 'openclaw' && !d.isRegistered);
  //                                       ↑ 过滤掉 openclaw
}

// main.ts startHooksGuard()
for (const ide of ides) {
  if (ide.type === 'openclaw') continue;  // 60s 巡检也跳过
  ...
}
```

只有以下场景会写部署版 `index.js`：
- 首次启动 SetupWizard 时用户手动勾选关联
- 设置面板手动「关联 / 取消关联 / 重新关联」

也就是说 **已经关联过 OpenClaw 的老用户在升级 App 时，没有任何路径会重写部署版 `index.js`**。

更深层原因是这个项目里 plugin 实现存在三份且需手动同步：源码 `src/integrations/openclaw-plugin/` + npm 包侧 `OpenClawInstaller.ts` 内嵌模板 + 桌面端 `OpenClawRegistrar.ts` 内嵌模板，缺乏自动迁移机制。

## 解决
1. 给两份 `PLUGIN_INDEX_JS` 模板首行加版本标识：
   ```js
   // AGENT_MEMORY_PLUGIN_VERSION=v2-session-end
   ```
2. `OpenClawRegistrar.ts` 新增导出 `ensureOpenClawPluginUpToDate(port)`：
   - 读部署版 `index.js`
   - 含最新版本标识 → 跳过
   - 不含 / 旧版本 → `writePluginPackage` 重写 4 个文件 + `plugins registry --refresh` + `gateway restart`
   - 任意环节失败都不抛，不阻塞 App 启动
3. `HooksRegistrar.ts` 透传 `ensureOpenClawUpToDate()` 并加进 facade。
4. `desktop/src/main.ts` 在 `app.whenReady` 末尾调一次：
   ```typescript
   try {
     if (hooksRegistrar.ensureOpenClawUpToDate()) {
       console.log('[OpenClaw] plugin auto-upgraded to latest template');
     }
   } catch { /* upgrade path must not block startup */ }
   ```

后续要再升级 hook 行为，**只需把 `PLUGIN_TEMPLATE_VERSION` 的值改成新串**（比如 `v3-xxx`），老用户启动时就会自动重升。

## 教训
- 「修代码 ≠ 修产品」。修复必须沿着用户实际拿到产品的整条路径走完：源码 → 模板 → 部署版 → 升级路径 → 实际数据库。
- 内嵌字符串模板复刻源码这种设计有原罪——必须搭配「版本标识 + 启动期自动迁移」机制兜底，否则随升随漏，每次都靠用户手动点"重新关联"才能拿到 fix。
- 排查这种隐藏失败要看 `whenReady` / `setInterval` / IPC 几条路径里有没有 `if (ide === 'openclaw') continue` 这种"善意跳过"——它们最容易吃掉升级动作。
