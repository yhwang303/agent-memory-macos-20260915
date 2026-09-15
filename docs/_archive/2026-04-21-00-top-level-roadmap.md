# claude-mem → agent-memory 集成 · 顶层路线图

**分支**：`feat/claude-mem-integration`
**目标**：一条分支、5 份子 spec、1 次合入 master
**日期**：2026-04-21
**基准**：cloudboyguo 分支 + claude-mem v12.3.8

---

## 全局约束

| 约束 | 决定 |
|---|---|
| 运行时 | **Node.js only**（agent-memory 以 .exe 发布；claude-mem 的 Bun API 需重写为 Node） |
| 许可证 | agent-memory 迁移到 **AGPL-3.0**；允许直接复制 claude-mem 源码 |
| RAG 向量化 | **chroma-mcp**（Python，uv 管理）+ 中文嵌入模型（默认 `bge-m3`） |
| 数据存储 | SQLite 主库不变（`~/.config/agent-memory/agent-memory.db`）；Chroma 作为补充 |
| 分支策略 | 一条分支顺序推进 M1→M5，最后单次合入 |
| 交付形式 | 最终 .exe 产品 + 源码（AGPL） |

---

## 5 个里程碑

| ID | 名称 | 工作日 | 独立 spec |
|---|---|---|---|
| M1 | 图片语义修复（Claude Code transcript 读取） | ~3 | `2026-04-21-m1-image-semantics-design.md` |
| M2 | RAG + SQLite 双重查询 | ~5 | `2026-04-21-m2-rag-hybrid-search-design.md` |
| M3 | 新平台批量接入（opencode/windsurf/codex-cli/gemini-cli/copilot-cli/antigravity/goose/crush/roo-code/warp） | ~10 | `2026-04-21-m3-multi-platform-adapters-design.md` |
| M4 | OpenClaw 网关插件 | ~4 | `2026-04-21-m4-openclaw-gateway-design.md` |
| M5 | 运行时迁移 + .exe 打包 + AGPL 切换 | ~3 | `2026-04-21-m5-runtime-migration-design.md` |

**合计约 25 个工作日**（5 周）。

---

## 依赖关系

```
M1 (图片) ──┐
            ├──► M3 (多平台) ──► M5 (打包)
M2 (RAG) ───┤
            └──► M4 (OpenClaw)
```

- **M1 独立**：仅涉及 Claude Code / Claude Internal 适配器与 hooks-cli 的 handleStop。
- **M2 独立**：引入 Chroma 栈，不改动适配器；但 M3/M4 的 context 注入依赖它。
- **M3 依赖 M1**：新平台的 transcript-based 通道（claude-code 升级 + codex-cli）复用 M1 的 `transcript-parser.ts`。
- **M4 依赖 M2**：OpenClaw 插件通过 `GET /api/context/inject` 拉已向量化/结构化的 context。
- **M5 收尾**：Bun 替换、AGPL 切换、.exe 验证。

---

## 实施与 review checkpoint

每个里程碑：
1. brainstorm 已完成 → 对应 spec 已签字
2. writing-plans 产生实施 plan
3. 按 plan 实施，commit 到同一分支
4. 本里程碑的回归跑通（例如 M1 的 10 组含图片会话）
5. 在此分支上继续下一个里程碑

**单次 PR** 提交到 master，PR 描述按 M1–M5 分 5 段。

---

## 风险登记表

| 风险 | 影响 | 缓解 |
|---|---|---|
| .exe 打包无法带 Python/uv（Chroma 依赖） | 高 | M5 做降级策略：无 Python 时 Chroma 特性禁用，降级纯 FTS5 |
| chroma-mcp 在 Windows 上 SSL 问题（claude-mem issue #590） | 中 | 参考 claude-mem 的修复；在 ChromaMcpManager 里透传 CA 证书 |
| 10 个新平台事件规范差异大 | 中 | M3 按"hooks/transcript/mcp"3 类模板化，不逐个手写 |
| OpenClaw 插件 SSE 常驻会和 .exe 生命周期冲突 | 中 | M4 里约定：OpenClaw feature 仅在显式启动 `agent-memory gateway` 子命令时启用 |
| AGPL 切换需要更新所有文件头 + README | 低 | M5 用一次脚本批量处理 |

---

## 合入 master 的条件

- 所有 5 份子 spec 已签字
- 所有 5 份 plan 对应的测试通过
- 10 个新 IDE 的 smoke test 表（M3）全绿
- Claude Code 图片语义回归（M1）≥8/10
- 混合查询（M2）在测试集上 recall ≥ 纯 FTS5 基线 + 20%
- .exe 冷启动成功（M5）
- LICENSE 更新为 AGPL-3.0，NOTICE 声明 claude-mem 来源

---

*本文档为 brainstorming 产物。下一步由 superpowers:writing-plans 逐个里程碑产出 plan。*
