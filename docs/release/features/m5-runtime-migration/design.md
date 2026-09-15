# M5 · 运行时迁移 + .exe 打包 + AGPL 切换

**里程碑**：M5（路线图第 5/5 步）
**工作量**：~3 个工作日
**前置**：M1 / M2 / M3 / M4 全部完成
**后继**：合入 master

---

## 1. 目标

- 把 M1–M4 过程中从 claude-mem 带进来的任何 Bun API 代码**换成 Node 等价实现**
- 把 agent-memory 的 LICENSE 切为 **AGPL-3.0**，并在所有源文件加头注释
- 验证 agent-memory 能以 .exe 形式打包并分发（Windows 优先）
- 产出 `docs/MIGRATION.md` 面向用户的升级指南

## 2. Bun → Node 替换清单

从 claude-mem 移植过来的代码可能包含以下 Bun API，需要逐一替换：

| Bun API | Node 等价 | 改写难度 |
|---|---|---|
| `Bun.serve({ fetch })` | `http.createServer` + Express/Fastify | 小 |
| `Bun.file(path).text()` | `fs.readFile(path, 'utf8')` | 小 |
| `Bun.spawn` | `child_process.spawn` | 小 |
| `Bun.sqlite` | `better-sqlite3` | 小 |
| `bun:test` | `node --test` / `vitest` | 小 |
| `import.meta.main` | `require.main === module` | 小 |
| `Bun.env` | `process.env` | 小 |
| Bun top-level await + ESM | Node 20+ 已原生支持 | 无 |
| `bun run` 脚本 | `node dist/*.js` | 中（npm scripts 改） |

**审查工具**：`grep -rn "Bun\." src/` 应返回 0 行；CI 里加一条 guard。

## 3. AGPL-3.0 切换

### 3.1 LICENSE 文件
替换为 AGPL-3.0 全文（https://www.gnu.org/licenses/agpl-3.0.txt）。

### 3.2 NOTICE 文件（新增）
```
agent-memory
Copyright (C) 2026 <公司/作者>

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License v3.

This product includes code adapted from:
- claude-mem (AGPL-3.0) by thedotmack — https://github.com/thedotmack/claude-mem
```

### 3.3 源文件头（每个 .ts 顶部）
```ts
/*!
 * agent-memory — AGPL-3.0
 * Copyright (C) 2026 <公司/作者>
 * See LICENSE and NOTICE for details.
 */
```

用脚本 `scripts/add-license-header.js` 批量处理。

### 3.4 README.md
顶部增加 License badge + AGPL 简要条款说明。

### 3.5 package.json
`"license": "AGPL-3.0-only"`。

## 4. .exe 打包

### 4.1 工具选型对比

| 工具 | 优点 | 缺点 |
|---|---|---|
| **pkg** (vercel/pkg) | 成熟，Node 18 支持好 | 已归档停止维护 |
| **nexe** | 活跃 | 构建慢 |
| **node-sea** (Node 20+ 原生 Single Executable Applications) | 官方，未来向 | 功能相对基础 |
| **@yao-pkg/pkg** | pkg 的社区 fork，活跃 | — |

**选型**：优先 `@yao-pkg/pkg`（社区 fork，积极维护，接口与 vercel/pkg 一致）。

### 4.2 打包配置

`package.json`：
```json
{
  "bin": { "agent-memory": "dist/cli.js" },
  "pkg": {
    "targets": ["node20-win-x64", "node20-macos-x64", "node20-linux-x64"],
    "assets": [
      "dist/**/*",
      "src/services/sqlite/migrations/*.sql",
      "src/integrations/openclaw-plugin/**/*"
    ],
    "outputPath": "release"
  }
}
```

### 4.3 外部依赖处理

| 依赖 | 策略 |
|---|---|
| `better-sqlite3`（native） | `@yao-pkg/pkg` 自动拎 prebuild；Windows 需带 MSVC 运行时 |
| `chroma-mcp`（Python） | **不打包**；.exe 启动时检测 `uv`，缺失时引导用户安装 |
| `bge-m3` 嵌入模型 | 首次使用下载；Worker 启动时异步拉 |

### 4.4 分层安装策略

| 层次 | 内容 | 必需 |
|---|---|---|
| Core | agent-memory.exe + SQLite + 所有适配器 + 10+ IDE 支持 | 必需 |
| RAG | chroma-mcp + bge-m3（走 uv 安装） | 可选 |
| OpenClaw | 插件包（随 .exe 分发） | 可选，仅网关场景 |

`agent-memory doctor` 命令列出每层状态。

### 4.5 自动更新

- Windows：`squirrel.windows` 或简易的 `agent-memory self-update` 拉 GitHub Release
- 跨平台：GitHub Release + `detect latest`

## 5. CI

`.github/workflows/release.yml`：
```
matrix: [windows-latest, macos-latest, ubuntu-latest]
  - node: 20
  - run: npm ci && npm run build && npm run package
  - artifact: release/agent-memory-<os>-<arch>
  - on tag v*: upload to GitHub Release
```

## 6. 迁移指南（docs/MIGRATION.md）

面向用户的升级说明，覆盖：
- 从旧版 agent-memory 升级的步骤（数据库迁移自动）
- 从 claude-mem 切换过来的用户（数据可选导入）
- Chroma / chroma-mcp 的可选启用方法
- 新 IDE 的一键安装命令

## 7. 文件清单

| 文件 | 动作 |
|---|---|
| `LICENSE` | 替换为 AGPL-3.0 |
| `NOTICE` | 新增 |
| `scripts/add-license-header.js` | 新增 |
| `package.json` | `license` 字段 + `pkg` 配置 + `bin` |
| `.github/workflows/release.yml` | 新增/更新 |
| `docs/MIGRATION.md` | 新增 |
| `scripts/check-no-bun.js` | 新增（CI guard） |
| `README.md` | 顶部 License badge + 介绍段 |

## 8. 测试计划

### 8.1 运行时

- `grep -rn "Bun\."` 零命中
- `node --test tests/` 全绿
- 所有 M1–M4 的测试在 Node 20 下通过

### 8.2 打包

- 三平台均产出 .exe/.bin/.app
- Windows .exe 冷启动 < 3s
- `agent-memory --version` 输出正确
- `agent-memory install claude-code` 在无 Node 环境的干净 Windows 上跑通

### 8.3 License

- `licensee` 工具（或 `license-checker`）扫描 `node_modules`，无与 AGPL 不兼容的传递依赖
- 所有 `.ts` 文件头注释存在

## 9. 风险

| 风险 | 缓解 |
|---|---|
| 打包后 native 模块加载失败 | 使用 `pkg-fetch` 预构建；Windows 带 MSVC 运行时 |
| `chroma-mcp` 无法在 .exe 内自带 | 明确文档：RAG 是可选能力；提供 `agent-memory doctor` 指引 |
| AGPL 条款让下游用户困惑 | README 写清"你用 agent-memory 做 SaaS 也必须开源" |
| Windows 签名缺失导致 SmartScreen 告警 | 采购代码签名证书（超出本里程碑，列为后续） |
| `node-sea` vs `@yao-pkg/pkg` 未来抉择 | 预留 `scripts/build-with-sea.js` 做 POC，等 Node 22 LTS 再切 |

## 10. 验收标准

- [ ] `grep -rn "Bun\."` 零命中
- [ ] LICENSE 是 AGPL-3.0，NOTICE 声明 claude-mem
- [ ] 所有源文件头注释完成
- [ ] 三平台 .exe/.bin/.app 均可运行
- [ ] Windows .exe 冷启动通过
- [ ] `agent-memory doctor` 可检测并报告缺失的可选层
- [ ] GitHub Release 流水线一键出包
- [ ] `docs/MIGRATION.md` 已 review

---

## 合入 master 前的最终 checklist

- [ ] M1 ~ M5 五份 spec 全部签字
- [ ] 对应 5 份实施 plan 全部完成
- [ ] 每个里程碑的验收标准全部满足
- [ ] CI 全绿
- [ ] 顶层 README 更新支持的 IDE 列表
- [ ] Demo：用同一份图片截图分别在 Claude Code / Cursor / Codex CLI 触发，三者生成的 summary 都包含图片语义
- [ ] Demo：在 OpenClaw gateway 里跑一轮对话，Telegram 频道收到 observation

---

*路线图终点。合入 master 之后，整合工作正式完成。*
