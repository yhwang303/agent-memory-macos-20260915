# dev-harness-and-agent-task-claiming — 设计

## 总体方案

把现有三块资产（文档范式 / 注册中心 / 建档 Skill）整合为一套可被「人 + 多 agent」共同遵循的 harness，由四部分组成：

1. **权威总纲** `docs/HARNESS.md`：唯一入口文档，串联所有规范。
2. **单一事实来源（SSOT）** `docs/requirements-registry.data.js`：所有需求/任务的状态（含认领、门禁、各环节）都以此文件为准，git 可追踪。
3. **看板** `docs/requirements-registry.html`：SSOT 的可视化视图，展示认领状态，提供人工门禁审核入口。
4. **认领 Skill** `.cursor/skills/claim-requirement/SKILL.md`：定义 agent「发现→认领→回写」的标准动作。

核心原则：**文件即队列，git 即锁，人只审核。**

## 关键决策

### 决策 1：SSOT 用 JS 种子文件，不引服务端

`requirements-registry.data.js`（`window.SEED_REQUIREMENTS`）作为唯一事实来源：

- agent 直接读/改这个文件并 `git commit`，天然版本化、可回滚、可 review。
- 浏览器注册中心从它加载（已实现），退化为"视图 + 人工门禁审核入口"。
- 不引数据库/后端队列服务（首版 YAGNI；规模变大再考虑用 worker `:3847` 落盘，见决策 4）。

### 决策 2：浏览器 localStorage 降级为缓存，种子为权威

现状 `mergeSeed()` 只新增、不更新已存在 id。改为：**种子对"认领字段 + 环节状态"拥有权威**，合并时覆盖本地同 id 记录的这些字段。理由：agent 在文件里推进的进度必须能在看板反映出来；localStorage 仅用于离线浏览与人工临时操作。

为避免覆盖人工刚点的门禁，引入 `updatedAt` 时间戳：合并时取较新的一方（last-write-wins）。

### 决策 3：门禁审批——AI 主动询问、AI 落盘（零复制）

矛盾点：人工"通过门禁"若点在浏览器、agent 读不到文件；而让人复制 JSON 回写又太繁琐（实测体验差）。最终采用 **AI 主导的对话式门禁**，把审批动作收敛成"人答一句话"：

1. AI 读到某需求单（认领/推进时）先检查 `gate`：
   - `gate === "passed"` → 直接继续后续环节，不打扰人。
   - `gate !== "passed"` 且 `prd` + `design` 均 `done` → AI **主动发起一个确认问题**：
     「需求 `<code> <title>` 的需求/设计文档已就绪，是否通过人工门禁开始实现？」
   - 文档未 done → AI 提示先补文档，不进入门禁。
2. 人答"通过" → **AI 自己**把种子里该需求置 `gate:"passed"`、刷新 `updatedAt` 并提交。**全程无需人复制、无需开浏览器。** 人答"先不"→ 保持 `pending`，不动工。
3. 看板门禁格子退化为**纯状态展示**（待审批 / 已通过）；删除"复制 JSON 片段"弹窗。浏览器点按钮仅作本地预览，权威审批走对话由 AI 落盘。

> 备选（后续增强）：注册中心通过本机 worker `http://127.0.0.1:3847` 暴露 `POST /api/registry/persist`，但有了 AI 落盘后已非必需。

### 决策 4：认领 = git 乐观锁

纯文件下并发认领靠 git 收敛，认领动作必须紧凑且立刻推送：

```
1. git pull --rebase
2. 读种子，挑一条 claimable 的需求
3. 校验 assignee 仍为空
4. 写入 assignee / claimedAt / status=in-progress / updatedAt
5. git commit && git push   ← 如被拒（他人先认领），放弃该条，回到 1
```

一次只认领一条；push 成功即视为持锁成功。

### 决策 5：assignee 标识格式

`assignee` 为自由字符串，推荐 `agent:<model>@<短会话id>` 或人工 handle（如 `human:tonny`）。便于追溯是谁/哪个会话在做。

### 决策 6：偏好问询 + 写入规则受管块

harness 接入新项目（或用户主动触发）时，先用**结构化问题**问询偏好，把结果写入项目规则文件的**受管块**，后续建档/展示读取规则即可，不再每次询问。

**为什么写"规则"而不是配置文件**：规则（`.cursor/rules/*.mdc` / `CLAUDE.md` / `AGENTS.md`）本就是 agent 每轮都会读到的上下文，把偏好写在这里能让任意 agent 无需额外加载就遵守，零接入成本。

**受管块约定**（沿用本仓 self-evolve 的 managed 块模式，避免覆盖用户手写内容）：

```
<!-- harness:preferences:managed:start -->
## Harness 偏好（自动生成，可重新问询覆盖）
- 文档展示形态: both    # md | html | both
- 默认语言: 中文
- assignee 格式: agent:<model>@<session>
<!-- harness:preferences:managed:end -->
```

只重写 `start/end` 之间的内容；块外的人工规则不动。

**首批偏好项（可扩展）**：

| 偏好键 | 取值 | 影响 |
|--------|------|------|
| `doc.format` | `md` / `html` / `both` | 建档时是否在 `*.md` 之外同步产出渲染版 `*.html`；`both` 则两者并存，注册中心文档跳转优先按此打开 |
| `doc.language` | `中文` / `English` / … | 文档与骨架默认语言 |
| `assignee.format` | 模板字符串 | 认领时 assignee 缺省格式 |

**问询时机与方式**：

1. 触发：`/harness-init` Skill，或用户说"初始化 harness / 配置偏好"。
2. 用结构化单/多选问题逐项问（如"文档要哪种形态？HTML / Markdown / 两者"）。
3. 收集结果 → 写入规则受管块 → 回显写入内容。
4. 可重复触发：再次运行覆盖受管块（块外不动）。

**`doc.format` 对文档范式的影响**：

- `md`（默认）：仅 `prd.md` / `design.md` …（现状）。
- `html`：每份文档以 `*.html` 形态产出/展示（如 `prd.html`）。
- `both`：`*.md` 为源，附 `*.html` 渲染版；`docs/README.md` §三 的"`*.pdf` 渲染版"扩展为同样允许 `*.html` 渲染版。

> 注：`doc.format` 仅决定**是否额外产出渲染版**，Markdown 始终作为可 diff 的源，避免只存 HTML 导致 review 困难。

### 决策 7：每个需求/bug 默认自动编号

每条需求/bug 注册时**默认分配一个人类友好的编号 `code`**，免去手工想 id：

- 格式：`FEAT-NNN`（功能）/ `BUG-NNN`（缺陷），按类型各自递增、零填充 3 位。
- 分配点（全部自动，无需手填）：
  1. 看板「注册新需求」：`newReq` 调 `nextCode(type)` 取当前该类型最大号 +1。
  2. `/add-feature-doc`、`/add-bug-doc`：建档时**顺带把种子条目写入 `requirements-registry.data.js`**（含自动 `code`），不再只更新 README 索引。
  3. 加载兜底：看板加载时对缺 `code` 的旧记录补号（`ensureCodes`）。
- `id` 仍是内部稳定主键（可继续用描述性串）；`code` 是展示与口头引用用（"FEAT-002 门禁通过"）。看板卡片显示 `#<code>` 徽章。

## 数据模型（种子 schema 扩展）

在现有字段（`id/title/type/module/path/created/phases`）基础上新增：

| 字段 | 类型 | 说明 |
|------|------|------|
| `code` | string | 人类友好编号 `FEAT-NNN` / `BUG-NNN`，注册时自动分配 |
| `status` | `'open' \| 'in-progress' \| 'blocked' \| 'done'` | 任务执行态，默认 `open` |
| `assignee` | `string \| null` | 认领人/agent，`null`=未认领 |
| `claimedAt` | ISO 字符串 \| null | 认领时间 |
| `updatedAt` | ISO 字符串 | 最近修改时间（合并冲突仲裁用） |
| `docs` | `{prd?, design?, useAnalysis?}` | 可选，覆盖文档文件名（bug 用 `analysis.md` 时） |

示例：

```js
{
  id: "samdp20260529",
  code: "BUG-001",
  title: "服务端后台记忆展示字段与客户端 viewer 对齐",
  type: "bug",
  module: "viewer",
  path: "docs/viewer/features/server-admin-memory-display-parity/",
  created: "2026-05-29",
  phases: { prd:"done", design:"done", gate:"locked", impl:"locked", testcase:"locked", testreport:"locked" },
  status: "open",
  assignee: null,
  claimedAt: null,
  updatedAt: "2026-05-29T05:30:00.000Z"
}
```

## 任务认领状态机

```
                 gate=passed 且 assignee=null
   [可认领 claimable] ───────claim───────▶ [in-progress @assignee]
          ▲                                      │
          │ release(放弃/超时)                    │ 完成全部环节
          └──────────────────────────────────────┤
                                                  ▼
                                            [done] status=done
```

- **文档类任务**（写 prd/design）：门禁前即可认领，认领条件 = 对应 doc 环节未完成且 `assignee` 空。
- **实现类任务**（impl/testcase/testreport）：必须 `gate=passed` 才可认领（沿用"先对齐后实现"）。
- `blocked`：遇阻塞，写明原因到该需求（可加 `note` 字段），释放 assignee 供他人接手。

## 接口/文件变更清单

| 文件 | 变更 | 仓库 |
|------|------|------|
| `docs/HARNESS.md` | 新增：权威总纲 | agent-memory |
| `docs/requirements-registry.data.js` | schema 扩展认领字段 | agent-memory |
| `docs/requirements-registry.html` | 渲染认领徽章；`mergeSeed` 支持按 `updatedAt` 覆盖更新；门禁通过后输出回写片段 | agent-memory |
| `.cursor/skills/claim-requirement/SKILL.md` | 新增：认领协议 Skill | agent-memory |
| `.cursor/skills/harness-init/SKILL.md` | 新增：偏好问询 + 写入规则受管块 Skill | agent-memory |
| `.cursor/rules/harness-preferences.mdc` | 新增：偏好受管块所在规则文件（首次问询后生成） | agent-memory |
| `.cursor/rules/harness-engineering-spec.mdc` | 新增：工程设计规范必读规则（SRP/OCP/DIP/高内聚低耦合），随 harness 注入 | agent-memory |
| `docs/README.md` | §三 渲染版扩展允许 `*.html`；§六 简洁+图文并茂；§六·五 工程设计规范；§八 设计文档标准结构；§五·五 补充认领协议链接 | agent-memory |
| `.cursor/skills/add-feature-doc/SKILL.md` | design.md 模板对齐 §八 标准结构 | agent-memory |

## `docs/HARNESS.md` 大纲

1. 总览图：（首次）偏好问询 → INBOX → 建档 → 注册 → 🔒门禁 → 认领 → 实现 → 测试 的全链路。
2. 初始化偏好：指向 `/harness-init`；偏好项与受管块说明（决策 6）。
3. 文档怎么写：指向 `docs/README.md`（模块/命名/模板）+ `/add-feature-doc`、`/add-bug-doc`；受 `doc.format` 影响是否产出 HTML。**必读：§六·五 工程设计规范（SRP/OCP/DIP/高内聚低耦合）、§八 设计文档标准结构（背景→目标→待确认问题→现状分析→初步方案，简洁 + 图文并茂）。**
4. 需求与 bug 怎么注册：写入 `requirements-registry.data.js`；字段 schema；看板自动加载。
5. 门禁怎么走：先对齐后实现；门禁审批回写闭环（决策 3）。
6. agent 如何认领：指向 `/claim-requirement`；状态机与 git 乐观锁。
7. 角色分工表：人=偏好选择/审核/门禁；agent=建档/注册/认领/实现/测试/回写。
8. 接入新项目清单：拷贝即用 vs 需定制的文件列表（harness 安装包）。

## `/claim-requirement` Skill 大纲

- 触发：agent 被要求"从需求列表认领任务"/"挑一个待办推进"。
- 步骤：`git pull` → 读种子 → 过滤 claimable（按文档类/实现类规则）→ 选一条 → 校验未被占用 → 写认领字段 → commit/push（冲突则换一条）→ 执行 → 回写环节与 `status` → commit。
- 安全：实现类任务认领前必须 `gate=passed`；一次只认领一条；不得擅自通过门禁。

## `/harness-init` Skill 大纲

- 触发：用户说"初始化 harness / 配置偏好"，或新项目首次接入、检测不到偏好受管块时。
- 步骤：
  1. 用结构化单/多选问题逐项问偏好（首项「文档展示形态：HTML / Markdown / 两者」，再问语言、assignee 格式等）。
  2. 将答案渲染进 `.cursor/rules/harness-preferences.mdc` 的 `harness:preferences:managed` 受管块（只重写块内，块外不动）。
  3. 回显写入内容，提示"以后建档将按此执行，可随时重新运行覆盖"。
- 安全：只动受管块；不删用户手写规则；重复运行幂等覆盖。

## 兼容性与迁移

- 旧种子记录缺新字段时，加载端按默认值补齐（`status:'open'`、`assignee:null`、`updatedAt=created`）。
- 纯前端 + 文件改动，无数据库迁移。
- 存量需求文档结构不变。

## 测试策略

1. 种子加新字段 → 看板正确显示认领徽章（可认领/已认领@谁/进行中/完成）。
2. 模拟两个 agent 先后改种子认领同一条 → git 冲突收敛，仅一个持有 assignee。
3. 门禁未过的实现类任务 → 认领 Skill 拒绝认领。
4. 人点门禁→回写种子→另一 agent 读到 `gate=passed` 并成功认领实现。
5. `mergeSeed` 按 `updatedAt` 覆盖：种子较新则刷新看板，本地较新（刚点门禁）则保留。
