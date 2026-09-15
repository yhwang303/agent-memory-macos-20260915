# 需求收件箱

> 想做但还没排期的需求池。新需求先扔这里，评审后再拆 story 移入对应模块。

---

## 待评审

<!-- 新需求默认落这里，格式：
- [ ] **标题** — 一句话描述需求动机或用户场景 `#tag`
-->

- [ ] **桌面端版本更新提示与跳转下载** — 检测到有新版本时，在桌面端弹出提示并提供「去下载」按钮，点击后自动打开浏览器跳转到官方下载页，由用户手动完成安装/覆盖更新（首版不做静默自动更新） `#desktop` `#release`

## 已评审 · 待排期

- [ ] **Self-Evolve 内置插件** — 将 Self-Evolve 的进化引擎（EvolveEngine / CriticEngine / PlatformWriter）以插件形式嵌入 Agent-Mem，复用已有 Hooks 和 observations 数据，统一服务进程、数据库和 Web Viewer，消除两套工具的割裂体验 `#plugin` `#self-evolve`
  → 需求文档：[docs/self-evolve/features/self-evolve-plugin/prd.md](self-evolve/features/self-evolve-plugin/prd.md)
  → 设计文档：[docs/self-evolve/features/self-evolve-plugin/design.md](self-evolve/features/self-evolve-plugin/design.md)

## 暂缓 / 搁置

<!-- 暂时不做，附上原因或重新评估条件 -->

---

*最后更新：2026-05-23 · 1 项待评审 · 1 项待排期*
