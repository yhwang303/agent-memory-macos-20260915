# 10 · Gemini 配额 429 导致助手回复为空（事件本身已入库）

## 现象
- 在 OpenClaw 里发"你好"等简单消息，助手没回复。
- 但 Agent Memory 数据库里能看到 `openclaw-gateway` 项目下的 observation，标题写着「网关项目中向用户问候时遭遇模型配额耗尽错误」之类的"错误现场"。

## 根本原因
- `~/.openclaw/openclaw.json` 里 `agents.defaults.model.primary` 配的是 `google/gemini-3.1-pro-preview`，免费额度耗尽，模型侧直接返回 **HTTP 429 / RESOURCE_EXHAUSTED**。
- 提供方在生成前就拒绝了请求，所以助手内容为空、token 统计全 0。
- 但 OpenClaw 仍然触发了 `agent_end`（带错误现场），插件正确把这次失败入库。

## 影响判定
- ✅ 记忆链路完全正常（事件能入库 + 总结生成 title/subtitle/narrative/concepts）。
- ❌ 业务层面没拿到正常对话。
- 这次的"看起来没记"其实是"记了一次失败"，不是 bug。

## 解决
- 短期：把默认模型切成本机配置里还有额度的 provider，比如：
  - `minimax/MiniMax-M2.1`
  - `timiai/gpt-5.2-codex`
- 长期：给 OpenClaw 配 fallback chain（主模型 429 自动切备用），并在记忆库里把"失败 observation"和"正常对话 observation"区分类型，方便后续筛查。

## 教训
- "助手没回复"≠"插件没记"，要先去 DB 看一眼有没有"失败现场"再下结论。
- 任何依赖外部模型 API 的链路都要做配额监控，不要让一个 provider 把整个 agent 体验拖死。
